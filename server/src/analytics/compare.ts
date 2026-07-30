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
    MixedBasisError,
    partitionByBasis,
    type EngagementBasis,
    type EngagementPost,
    type MediaType,
    type Platform,
    type RatedPost,
} from "./engagement";
import { describe as describeDistribution, type Distribution } from "./stats";
import { bestHours, groupContiguousHours, type TimingAnalysis } from "./timing";

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

// ── Format mix ───────────────────────────────────────────────────────────
//
// The Module C MUST names four dimensions, and this is the one most easily
// confused with format.ts. They answer different questions:
//
//   format.ts   — how well does each format PERFORM for this account?
//   format mix  — how much of the calendar does each format TAKE UP?
//
// Both are needed, and the gap between them is where the advice lives. A format
// that performs at 2× and occupies 4% of output is the finding; either number
// alone is not. Mix is a share of posts, so it has no denominator and therefore
// no engagement basis — it is counted over every post, rated or not.

export interface FormatShare {
    mediaType: MediaType;
    n: number;
    /** Share of this account's posts, 0–1. */
    share: number;
}

export interface AccountFormatMix {
    accountId: string;
    personName: string;
    role: AccountRole;
    isSynthetic: boolean;
    total: number;
    /** Every format this account used, largest share first. */
    shares: FormatShare[];
}

/** Where the principal's allocation differs most from the peer set's. */
export interface MixDivergence {
    mediaType: MediaType;
    principalShare: number;
    /** Median of the peers' shares for this format — 0 where a peer never uses it. */
    peerShare: number;
    /** principalShare − peerShare. Negative means the principal under-uses it. */
    difference: number;
}

export interface FormatMixComparison {
    principal: AccountFormatMix | null;
    peers: AccountFormatMix[];
    /** Largest absolute divergence first — the formats worth talking about. */
    divergences: MixDivergence[];
}

/** All this comparison needs from a post. Note the absence of any metric. */
export interface MixPost {
    mediaType: MediaType;
}

export interface MixCorpus<T extends MixPost> {
    accountId: string;
    personName: string;
    role: AccountRole;
    isSynthetic: boolean;
    posts: readonly T[];
}

function mixFor<T extends MixPost>(corpus: MixCorpus<T>): AccountFormatMix {
    const counts = new Map<MediaType, number>();
    for (const post of corpus.posts) {
        counts.set(post.mediaType, (counts.get(post.mediaType) ?? 0) + 1);
    }

    const total = corpus.posts.length;

    return {
        accountId: corpus.accountId,
        personName: corpus.personName,
        role: corpus.role,
        isSynthetic: corpus.isSynthetic,
        total,
        shares: [...counts.entries()]
            .map(([mediaType, n]) => ({ mediaType, n, share: total === 0 ? 0 : n / total }))
            .sort((a, b) => b.share - a.share),
    };
}

/**
 * How the principal allocates output across formats, against the peer set.
 *
 * Divergence is computed against the MEDIAN peer share rather than the pooled
 * peer share, for the same reason every other benchmark in this product is a
 * median: one competitor who posts nothing but reels should not redefine what
 * "normal" looks like for the peer set.
 *
 * A format the principal never uses is included with a share of 0 rather than
 * omitted — a 0% allocation against a 30% peer median is the single most
 * actionable thing this function can report, and dropping the row would hide it.
 */
export function compareFormatMix<T extends MixPost>(corpora: readonly MixCorpus<T>[]): FormatMixComparison {
    const mixes = corpora.map(mixFor);

    const principal = mixes.find((m) => m.role === "PRINCIPAL") ?? null;
    const peers = mixes.filter((m) => m.role === "COMPETITOR");

    const divergences: MixDivergence[] = [];

    if (principal !== null && peers.length > 0) {
        const allFormats = new Set<MediaType>();
        for (const mix of mixes) for (const share of mix.shares) allFormats.add(share.mediaType);

        for (const mediaType of allFormats) {
            const principalShare = principal.shares.find((s) => s.mediaType === mediaType)?.share ?? 0;

            const peerShares = peers.map((p) => p.shares.find((s) => s.mediaType === mediaType)?.share ?? 0);
            const sorted = [...peerShares].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const peerShare = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

            divergences.push({ mediaType, principalShare, peerShare, difference: principalShare - peerShare });
        }

        divergences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    }

    return { principal, peers, divergences };
}

// ── Best-performing windows ──────────────────────────────────────────────
//
// The fourth dimension of the MUST. Unlike cadence and mix, this one IS derived
// from engagement rates, so it carries a basis and inherits every sample-size
// rule in timing.ts — `bestHours` already drops LOW-confidence buckets, which is
// what keeps a one-post hour out of a side-by-side comparison where it would
// read as an equal claim to a peer's twenty-post hour.

export interface AccountWindow {
    accountId: string;
    personName: string;
    role: AccountRole;
    isSynthetic: boolean;
    /** The zone these hours are expressed in — per account, never assumed shared. */
    timezone: string;
    startHour: number;
    endHour: number;
    label: string;
    /** Posts across the merged hours. */
    n: number;
    /** Median of the merged hours' multiples of that account's overall median. */
    multipleOfOverall: number;
}

export interface WindowComparison {
    basis: EngagementBasis;
    principal: AccountWindow[];
    peers: AccountWindow[];
    /**
     * Hours where at least one peer has a quotable window and the principal has
     * no post at all. The overlap with `gaps.ts` is intentional — this is the
     * descriptive version for the comparison screen, `gaps.ts` is the ranked,
     * evidence-gated version the AI layer is allowed to cite.
     */
    hoursPrincipalNeverUses: number[];
}

/** The timing input a window comparison needs, per account. */
export interface WindowCorpus {
    accountId: string;
    personName: string;
    role: AccountRole;
    isSynthetic: boolean;
    timezone: string;
    analysis: TimingAnalysis | null;
    /**
     * Every local hour this account has ANY post in — see `timing.occupiedHours`.
     *
     * Supplied separately rather than read off `analysis.byHour` because that
     * marginal suppresses buckets below MIN_CELL_N. Deriving presence from it
     * reported an hour holding two posts as one the principal had never used,
     * and "start posting at 10:00" then goes to someone already posting at 10:00.
     */
    occupiedHours: readonly number[];
}

/**
 * A "best-performing window" must actually perform.
 *
 * `bestHours` returns an account's top `count` hours whether or not any of them
 * are good — which is correct for a ranked list and wrong for this screen. An
 * account active in only four hours would report all four as best-performing
 * windows, including the one dragging its average down, and a comms manager
 * reading four accounts side by side would take every one of them as a
 * recommendation. At or above the account's own median is the bar.
 */
const MIN_WINDOW_MULTIPLE = 1;

/**
 * Each account's best-performing windows, side by side.
 *
 * `count` is the number of top HOURS considered before merging, not the number
 * of windows returned — three adjacent strong hours collapse into one window,
 * which is the intended behaviour and why the two numbers differ.
 */
export function compareWindows(corpora: readonly WindowCorpus[], count = 4): WindowComparison | null {
    const withAnalysis = corpora.filter((c) => c.analysis !== null);
    if (withAnalysis.length === 0) return null;

    const bases = new Set(withAnalysis.map((c) => c.analysis!.basis));
    if (bases.size > 1) {
        // Same rule as everywhere: a views-normalised window and a
        // followers-normalised one are different quantities on one screen.
        throw new MixedBasisError("window comparison", [...bases].sort());
    }

    const windowsFor = (corpus: WindowCorpus): AccountWindow[] =>
        groupContiguousHours(
            bestHours(corpus.analysis!, count).filter((b) => b.multipleOfOverall >= MIN_WINDOW_MULTIPLE),
            (b) => b.hour,
        ).map((run) => ({
            accountId: corpus.accountId,
            personName: corpus.personName,
            role: corpus.role,
            isSynthetic: corpus.isSynthetic,
            timezone: corpus.timezone,
            startHour: run.startHour,
            endHour: run.endHour,
            label: run.label,
            n: run.items.reduce((total, bucket) => total + bucket.n, 0),
            multipleOfOverall: medianOf(run.items.map((b) => b.multipleOfOverall)) ?? 0,
        }));

    const principalCorpora = withAnalysis.filter((c) => c.role === "PRINCIPAL");
    const peerCorpora = withAnalysis.filter((c) => c.role === "COMPETITOR");

    // Every hour the principal has ANY post in. "Never uses" is a question about
    // presence: an hour he posts in badly, or rarely, is still an hour he uses.
    const principalHours = new Set<number>();
    for (const corpus of principalCorpora) {
        for (const hour of corpus.occupiedHours) principalHours.add(hour);
    }

    const peerWindows = peerCorpora.flatMap(windowsFor);
    const unusedHours = new Set<number>();
    for (const window of peerWindows) {
        for (let hour = window.startHour; hour <= window.endHour; hour += 1) {
            if (!principalHours.has(hour)) unusedHours.add(hour);
        }
    }

    return {
        basis: [...bases][0],
        principal: principalCorpora.flatMap(windowsFor),
        peers: peerWindows.sort((a, b) => b.multipleOfOverall - a.multipleOfOverall),
        hoursPrincipalNeverUses: [...unusedHours].sort((a, b) => a - b),
    };
}
