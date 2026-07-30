// "How do we compare?" — question 3 of the four.
//
// The principal against the peer set on identical metrics. Two things make this
// harder than it looks, and both are handled here rather than in the UI.
//
// 1. FOLLOWER COUNTS ARE NOT EQUAL, AND MUST NOT BE THE COMPARISON.
//    The peer set spans 0.9M to 1.8M followers. Ranking on likes would rank on
//    audience size and call it performance. Every figure in this module is the
//    normalised rate — which is also why the basis guard applies with full force:
//    comparing a views-normalised principal against a followers-normalised peer
//    is the same error wearing a different hat.
//
// 2. PROVENANCE IS NOT UNIFORM, AND MUST NOT BE AVERAGED AWAY.
//    Three of the four tracked people have a live YouTube channel; the fourth is
//    seeded. So a YouTube comparison can legitimately span real and generated
//    accounts. That is NOT refused — refusing would remove the only live-data
//    comparison the product has — but it is flagged on the result, per account,
//    and the UI is expected to badge it.
//
//    The distinction is deliberate: mixing engagement BASES is an arithmetic
//    error and throws. Mixing PROVENANCE is a validity caveat and is reported.
//    One produces a meaningless number; the other produces a real number about
//    a partly-invented world, and the reader has to be told which.

import {
    assertSingleBasis,
    partitionByBasis,
    type EngagementBasis,
    type EngagementPost,
    type Platform,
    type RatedPost,
} from "./engagement";
import { describe as describeDistribution, type Distribution } from "./stats";

/** Below this, an account is not given a comparison figure. Same bar as format.ts. */
export const MIN_COMPARE_N = 5;

export type AccountRole = "PRINCIPAL" | "COMPETITOR";

/** One account's rated corpus, plus the metadata a comparison has to carry. */
export interface AccountCorpus<T extends EngagementPost> {
    accountId: string;
    /** The human, not the handle — the same person has one account per platform. */
    personName: string;
    role: AccountRole;
    platform: Platform;
    handle: string;
    /** Whether THIS account's data is generated. Per account, never per platform. */
    isSynthetic: boolean;
    rated: RatedPost<T>[];
}

export interface AccountSummary {
    accountId: string;
    personName: string;
    role: AccountRole;
    platform: Platform;
    handle: string;
    isSynthetic: boolean;
    n: number;
    distribution: Distribution;
    /** Median where outlier-driven, mean otherwise. */
    headline: number;
    headlineStat: "MEAN" | "MEDIAN";
}

export interface ExcludedAccount {
    accountId: string;
    personName: string;
    platform: Platform;
    n: number;
    reason: "INSUFFICIENT_POSTS" | "NO_RATED_POSTS";
}

export interface Provenance {
    /** True when this comparison spans live and generated accounts. */
    mixed: boolean;
    liveAccounts: string[];
    syntheticAccounts: string[];
}

export interface Comparison {
    basis: EngagementBasis;
    /** Null when the principal has too few rated posts to be compared honestly. */
    principal: AccountSummary | null;
    /** Peers meeting MIN_COMPARE_N, best first. */
    peers: AccountSummary[];
    /**
     * The median of the peer medians — a peer-set benchmark that one dominant
     * competitor cannot drag. Null when no peer qualifies.
     */
    peerBenchmark: number | null;
    /** Principal ÷ peer benchmark. Above 1 means the principal is ahead. */
    principalVsPeers: number | null;
    /** The principal's position among all qualifying accounts, 1-indexed. */
    principalRank: number | null;
    rankedOutOf: number;
    provenance: Provenance;
    /** Accounts left out, with the reason. Never silently dropped. */
    excluded: ExcludedAccount[];
}

function summarise<T extends EngagementPost>(corpus: AccountCorpus<T>): AccountSummary | ExcludedAccount {
    const base = {
        accountId: corpus.accountId,
        personName: corpus.personName,
        platform: corpus.platform,
    };

    if (corpus.rated.length === 0) {
        return { ...base, n: 0, reason: "NO_RATED_POSTS" };
    }
    if (corpus.rated.length < MIN_COMPARE_N) {
        return { ...base, n: corpus.rated.length, reason: "INSUFFICIENT_POSTS" };
    }

    const distribution = describeDistribution(corpus.rated.map((r) => r.engagement.rate))!;

    return {
        ...base,
        role: corpus.role,
        handle: corpus.handle,
        isSynthetic: corpus.isSynthetic,
        n: distribution.n,
        distribution,
        headline: distribution.outlierDriven ? distribution.median : distribution.mean,
        headlineStat: distribution.outlierDriven ? "MEDIAN" : "MEAN",
    };
}

function isSummary(value: AccountSummary | ExcludedAccount): value is AccountSummary {
    return (value as AccountSummary).distribution !== undefined;
}

/** Median of a small set of medians. Own implementation to avoid a sort-in-place surprise. */
function medianOf(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compare a principal against a peer set on one engagement basis.
 *
 * Every corpus passed in must already be rated on the same basis — mixing throws,
 * loudly, via `assertSingleBasis`. Use `compareAccountsByBasis` for a corpus that
 * legitimately spans both.
 */
export function compareAccounts<T extends EngagementPost>(
    corpora: readonly AccountCorpus<T>[],
    context = "comparison",
): Comparison | null {
    const allRates = corpora.flatMap((c) => c.rated.map((r) => r.engagement));
    const basis = assertSingleBasis(allRates, context);
    if (basis === null) return null;

    const summarised = corpora.map(summarise);
    const included = summarised.filter(isSummary);
    const excluded = summarised.filter((s): s is ExcludedAccount => !isSummary(s));

    // Ranking is on the median, for the same reason format.ts ranks on the
    // median: one viral post must not promote an account above a peer that
    // performs consistently.
    const ranked = [...included].sort((a, b) => b.distribution.median - a.distribution.median);

    const principal = ranked.find((s) => s.role === "PRINCIPAL") ?? null;
    const peers = ranked.filter((s) => s.role === "COMPETITOR");

    const peerBenchmark = medianOf(peers.map((p) => p.distribution.median));

    const principalRank = principal === null ? null : ranked.indexOf(principal) + 1;

    return {
        basis,
        principal,
        peers,
        peerBenchmark,
        principalVsPeers:
            principal === null || peerBenchmark === null || peerBenchmark === 0
                ? null
                : principal.distribution.median / peerBenchmark,
        principalRank,
        rankedOutOf: ranked.length,
        provenance: {
            mixed: included.some((s) => s.isSynthetic) && included.some((s) => !s.isSynthetic),
            liveAccounts: included.filter((s) => !s.isSynthetic).map((s) => s.personName),
            syntheticAccounts: included.filter((s) => s.isSynthetic).map((s) => s.personName),
        },
        excluded,
    };
}

/**
 * The entry point for a cross-platform comparison.
 *
 * A set spanning YouTube (views) and Instagram carousels (followers) contains
 * both bases and cannot be one comparison. This returns the two panels the UI
 * renders separately rather than a blended number that would look authoritative
 * and mean nothing.
 */
export function compareAccountsByBasis<T extends EngagementPost>(
    corpora: readonly AccountCorpus<T>[],
    context = "comparison",
): Record<EngagementBasis, Comparison | null> {
    const split: Record<EngagementBasis, AccountCorpus<T>[]> = { VIEWS: [], FOLLOWERS: [] };

    for (const corpus of corpora) {
        const byBasis = partitionByBasis(corpus.rated);
        // An account contributes to a panel only if it has posts on that basis.
        // Passing through an empty corpus would produce a NO_RATED_POSTS
        // exclusion on every panel, which is noise rather than information.
        if (byBasis.VIEWS.length > 0) split.VIEWS.push({ ...corpus, rated: byBasis.VIEWS });
        if (byBasis.FOLLOWERS.length > 0) split.FOLLOWERS.push({ ...corpus, rated: byBasis.FOLLOWERS });
    }

    return {
        VIEWS: split.VIEWS.length > 0 ? compareAccounts(split.VIEWS, `${context} [VIEWS]`) : null,
        FOLLOWERS: split.FOLLOWERS.length > 0 ? compareAccounts(split.FOLLOWERS, `${context} [FOLLOWERS]`) : null,
    };
}

/**
 * One sentence a comms manager can read, with the caveat attached when it applies.
 *
 * Lives here rather than in the UI so the Markdown export, the dashboard and the
 * AI prompt all describe the same comparison the same way.
 */
export function describeComparison(comparison: Comparison): string {
    const { principal, peerBenchmark, principalVsPeers, principalRank, rankedOutOf, provenance } = comparison;

    if (principal === null) {
        return `No comparison: the principal has fewer than ${MIN_COMPARE_N} rated posts in this view.`;
    }
    if (principalVsPeers === null || peerBenchmark === null) {
        return `No qualifying peers to compare against (${principal.personName}: n=${principal.n}).`;
    }

    const direction = principalVsPeers >= 1 ? "ahead of" : "behind";
    const multiple = principalVsPeers >= 1 ? principalVsPeers : 1 / principalVsPeers;

    const sentence =
        `${principal.personName} ranks ${principalRank} of ${rankedOutOf} on median engagement rate ` +
        `(${comparison.basis.toLowerCase()}-normalised), ${multiple.toFixed(2)}× ${direction} the peer benchmark, ` +
        `across ${principal.n} posts.`;

    return provenance.mixed
        ? `${sentence} NOTE: this comparison mixes live and seeded accounts — seeded: ${provenance.syntheticAccounts.join(", ")}.`
        : sentence;
}
