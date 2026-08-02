// The single analytics document the AI layer is allowed to see.
//
// THIS FILE IS THE GROUNDING MECHANISM. Not the prompt, not the validator —
// this. The recommendation model never receives raw post metrics, so it has no
// corpus to average in its head and no engagement figures to misread. It
// receives only what is computed here, with `n` already attached to every
// number. Structurally it can misinterpret a verified figure; it cannot invent
// an unverified one.
//
// TWO RULES THAT SHAPE EVERY DECISION BELOW
//
// 1. THE REPORT IS ROUNDED AT BUILD TIME, ONCE.
//    Every rate is stored as a percentage to two decimals and every multiple to
//    two decimals — the form a human would write. If the report held full
//    precision, the model would round it for prose and the validator would then
//    be comparing 3.47 against 0.034700000000000002 and would have to accept a
//    loose tolerance to work at all. Rounding here makes verification nearly
//    exact, which is the difference between a validator and a formality.
//
// 2. THE REPORT IS DELIBERATELY SMALL.
//    This is the counter-intuitive one. Every number in this document becomes a
//    number the validator will ACCEPT, because a figure that appears anywhere in
//    the evidence is by definition citable. So a bigger report is a WEAKER
//    validator: dump enough JSON and every plausible integer appears somewhere,
//    and "checked against the analytics" stops meaning anything. Lists are
//    capped for that reason and not to save tokens — and every cap is reported
//    in `truncations`, because a silent cap reads as complete coverage.

import { compareAccounts, compareFormatMix, compareWindows, describeComparison, type Comparison, type FormatMixComparison, type WindowComparison } from "./compare";
import { compareCadence, describeCadence, type CadenceComparison } from "./cadence";
import { loadCorpora, type CorpusFilter, type CorpusPost, type LoadedCorpus } from "./corpus";
import { partitionByBasis, type EngagementBasis, type Platform } from "./engagement";
import { analyseFormats, type FormatAnalysis } from "./format";
import {
    describeGap,
    describeNearMiss,
    describeOverInvestment,
    findGaps,
    GAP_LIFT_THRESHOLD,
    mergeHourWindows,
    type GapAnalysis,
    type PeerEvidence,
} from "./gaps";
import { analyseTiming, bestHours, occupiedHours, type TimingAnalysis } from "./timing";
import { topPosts } from "./topPosts";

// ── Caps ─────────────────────────────────────────────────────────────────
// See rule 2 above. These bound the size of the verified-number set, which is
// what gives validation its teeth.

const MAX_FORMATS = 5;
const MAX_GAPS = 5;
/**
 * Higher than MAX_GAPS on purpose. Near misses are the panel's whole content on
 * a corpus where nothing clears the bar, and truncating them to five would
 * reintroduce the blankness they exist to fix.
 */
const MAX_NEAR_MISSES = 8;
const MAX_OVER_INVESTED = 3;
const MAX_TOP_POSTS = 3;
const MAX_BEST_HOURS = 3;

// ── Rounding ─────────────────────────────────────────────────────────────

/** A rate as a percentage to two decimals: 0.034712 → 3.47. */
function pct(rate: number): number {
    return Math.round(rate * 100 * 100) / 100;
}

/** A multiple to two decimals: 1.4832 → 1.48. */
function mult(value: number): number {
    return Math.round(value * 100) / 100;
}

/** A share as a whole percentage: 0.6234 → 62. */
function sharePct(share: number): number {
    return Math.round(share * 100);
}

// ── Report shape ─────────────────────────────────────────────────────────

export interface ReportFormat {
    mediaType: string;
    n: number;
    /** Median engagement rate, as a percentage. */
    medianRatePct: number;
    /** This format's median as a multiple of the account's overall median. */
    multipleOfOverall: number;
    /** True where mean/median > 1.5 — lead with the median in any prose. */
    outlierDriven: boolean;
}

export interface ReportHour {
    hour: number;
    label: string;
    n: number;
    multipleOfOverall: number;
}

export interface ReportPost {
    /** Database id. What a recommendation's evidence chip resolves against. */
    id: string;
    postedAt: string;
    mediaType: string;
    ratePct: number;
    multipleOfMedian: number;
    /** Null for synthetic posts — there is nothing real to link to. */
    permalink: string | null;
    isSynthetic: boolean;
    /** Truncated: the model needs enough to recognise the post, not to re-analyse it. */
    captionExcerpt: string | null;
}

/** One peer's contribution to a gap or a near miss, as the UI renders it. */
export interface ReportPeerEvidence {
    personName: string;
    n: number;
    lift: number;
    /** True where this peer on its own cleared the lift bar. */
    clears: boolean;
    isSynthetic: boolean;
}

export interface ReportGap {
    dimension: string;
    label: string;
    kind: string;
    peerLift: number;
    peerAgreement: string;
    principalN: number;
    opportunity: number;
    /** Pre-written from verified figures, so the model restates rather than recomputes. */
    sentence: string;
    provenanceCaveat: string | null;
    /**
     * Who the finding actually rests on.
     *
     * Previously dropped in this projection, which left the dashboard asserting
     * "2 of 3 peers agree" with no way to see which two or by how much. A reader
     * deciding whether to move a posting slot is entitled to the names.
     */
    peers: ReportPeerEvidence[];
}

/**
 * A bucket that was considered and rejected, with the gate that stopped it.
 *
 * See the NearMiss docblock in analytics/gaps.ts for why this is reported at
 * all. The short version: on a real corpus the gates reject nearly everything,
 * and "no gap clears the bar" rendered alone is indistinguishable from "we did
 * not look".
 */
export interface ReportNearMiss {
    dimension: string;
    label: string;
    reason: string;
    peerLift: number;
    peerAgreement: string;
    principalN: number;
    /** Null where he has too few posts in the bucket to quote a figure. */
    principalLift: number | null;
    whatWouldChangeIt: string;
    sentence: string;
    peers: ReportPeerEvidence[];
}

export interface ReportDimensionCoverage {
    dimension: string;
    bucketsConsidered: number;
    bucketsTestable: number;
    gaps: number;
    nearMisses: number;
}

export interface ReportBasisSection {
    basis: EngagementBasis;
    /** What the rates in this section were divided by, in words, for the prompt. */
    denominator: string;
    principalRatedPosts: number;
    principalMedianRatePct: number;
    formats: ReportFormat[];
    bestHours: ReportHour[];
    timezone: string;
    /** Cells hidden by the n<3 rule. Reported so a sparse grid is not read as a full one. */
    suppressedCells: number;
    rank: { position: number; outOf: number } | null;
    peerBenchmarkRatePct: number | null;
    principalVsPeers: number | null;
    comparisonSentence: string;
    peerWindows: { personName: string; label: string; n: number; multipleOfOverall: number }[];
    gaps: ReportGap[];
    /** Considered and rejected, closest to the bar first. Never a finding. */
    nearMisses: ReportNearMiss[];
    /** What each dimension could test, so a dimension that ran on nothing is visible. */
    gapCoverage: ReportDimensionCoverage[];
    overInvested: { label: string; n: number; shareOfOutputPct: number; lift: number; sentence: string }[];
    bestPosts: ReportPost[];
    worstPosts: ReportPost[];
}

export interface ReportPlatformSection {
    platform: Platform;
    /** Every post on this platform in the window, rated or not. */
    totalPosts: number;
    provenance: "LIVE" | "SEEDED" | "MIXED";
    seededAccounts: string[];
    cadence: {
        principalPostsPerWeek: number | null;
        peerMedianPostsPerWeek: number | null;
        principalVsPeers: number | null;
        principalConsistencyPct: number | null;
        peerConsistencyPct: number | null;
        principalLongestSilenceDays: number | null;
        sentence: string;
    } | null;
    formatMixDivergences: { mediaType: string; principalSharePct: number; peerSharePct: number }[];
    bases: ReportBasisSection[];
}

export interface AnalyticsReport {
    generatedAt: string;
    principalName: string | null;
    peerNames: string[];
    window: { from: string; to: string; days: number } | null;
    filter: CorpusFilter;
    /** How much of the corpus behind this report is generated rather than fetched. */
    corpusProvenance: { totalPosts: number; livePosts: number; seededPosts: number; seededPct: number };
    platforms: ReportPlatformSection[];
    /** What could not be computed, and why. Never an empty result without an explanation. */
    notes: string[];
    /** Every list this report capped, with the count dropped. No silent truncation. */
    truncations: string[];
}

// ── Build ────────────────────────────────────────────────────────────────

function provenanceOf(corpora: readonly LoadedCorpus[]): {
    provenance: "LIVE" | "SEEDED" | "MIXED";
    seededAccounts: string[];
} {
    const withPosts = corpora.filter((c) => c.posts.length > 0);
    const seeded = withPosts.filter((c) => c.isSynthetic);

    return {
        provenance:
            seeded.length === 0 ? "LIVE" : seeded.length === withPosts.length ? "SEEDED" : "MIXED",
        seededAccounts: seeded.map((c) => c.personName),
    };
}

function toReportPost(post: {
    id: string;
    postedAt: Date;
    mediaType: string;
    engagement: { rate: number };
    multipleOfMedian: number;
    permalink: string | null;
    isSynthetic: boolean;
    caption: string | null;
}): ReportPost {
    return {
        id: post.id,
        postedAt: post.postedAt.toISOString(),
        mediaType: post.mediaType,
        ratePct: pct(post.engagement.rate),
        multipleOfMedian: mult(post.multipleOfMedian),
        permalink: post.permalink,
        isSynthetic: post.isSynthetic,
        captionExcerpt: post.caption === null ? null : post.caption.slice(0, 140),
    };
}

function buildBasisSection(
    corpora: readonly LoadedCorpus[],
    basis: EngagementBasis,
    platform: Platform,
    truncations: string[],
): ReportBasisSection | null {
    // Re-project every corpus onto this basis only. An account with no posts on
    // it drops out rather than contributing an empty exclusion, which would be
    // noise rather than information.
    const onBasis = corpora
        .map((c) => ({ ...c, rated: partitionByBasis(c.rated)[basis] }))
        .filter((c) => c.rated.length > 0);

    if (onBasis.length === 0) return null;

    const principal = onBasis.find((c) => c.role === "PRINCIPAL");
    if (principal === undefined) return null;

    const context = `${platform} [${basis}]`;

    const formats: FormatAnalysis | null = analyseFormats(principal.rated, context);
    const timing: TimingAnalysis | null = analyseTiming(principal.rated, principal.timezone, context);
    const comparison: Comparison | null = compareAccounts(onBasis, context);
    const gapAnalysis: GapAnalysis | null = findGaps(onBasis, context);
    const posts = topPosts(principal.rated, MAX_TOP_POSTS, context);

    if (formats === null || timing === null) return null;

    const windows: WindowComparison | null = compareWindows(
        onBasis.map((c) => ({
            accountId: c.accountId,
            personName: c.personName,
            role: c.role,
            isSynthetic: c.isSynthetic,
            timezone: c.timezone,
            analysis: analyseTiming(c.rated, c.timezone, `${context} ${c.personName}`),
            occupiedHours: occupiedHours(c.rated, c.timezone),
        })),
    );

    if (formats.formats.length > MAX_FORMATS) {
        truncations.push(
            `${context}: showing ${MAX_FORMATS} of ${formats.formats.length} reportable formats.`,
        );
    }
    if (gapAnalysis && gapAnalysis.gaps.length > MAX_GAPS) {
        truncations.push(`${context}: showing ${MAX_GAPS} of ${gapAnalysis.gaps.length} gaps.`);
    }

    const toPeerEvidence = (peers: readonly PeerEvidence[]): ReportPeerEvidence[] =>
        peers.map((p) => ({
            personName: p.personName,
            n: p.n,
            lift: mult(p.lift),
            clears: p.lift >= GAP_LIFT_THRESHOLD,
            isSynthetic: p.isSynthetic,
        }));

    const gaps: ReportGap[] = (gapAnalysis?.gaps ?? []).slice(0, MAX_GAPS).map((gap) => ({
        dimension: gap.key.dimension,
        label: gap.label,
        kind: gap.kind,
        peerLift: mult(gap.peerLift),
        peerAgreement: `${gap.peerAgreement.clearing} of ${gap.peerAgreement.of}`,
        principalN: gap.principal.n,
        opportunity: mult(gap.opportunity),
        sentence: describeGap(gap, gapAnalysis!.principalName),
        provenanceCaveat: gap.provenance.allSynthetic
            ? `Every peer behind this figure is seeded data (${gap.provenance.syntheticPeers.join(", ")}).`
            : gap.provenance.mixed
              ? `Mixes live and seeded peers — seeded: ${gap.provenance.syntheticPeers.join(", ")}.`
              : null,
        peers: toPeerEvidence(gap.peers),
    }));

    if (gapAnalysis && gapAnalysis.nearMisses.length > MAX_NEAR_MISSES) {
        truncations.push(
            `${context}: showing ${MAX_NEAR_MISSES} of ${gapAnalysis.nearMisses.length} near misses.`,
        );
    }

    const nearMisses: ReportNearMiss[] = (gapAnalysis?.nearMisses ?? [])
        .slice(0, MAX_NEAR_MISSES)
        .map((miss) => ({
            dimension: miss.key.dimension,
            label: miss.label,
            reason: miss.reason,
            peerLift: mult(miss.peerLift),
            peerAgreement: `${miss.peerAgreement.clearing} of ${miss.peerAgreement.of}`,
            principalN: miss.principal.n,
            principalLift: miss.principal.lift === null ? null : mult(miss.principal.lift),
            whatWouldChangeIt: miss.whatWouldChangeIt,
            sentence: describeNearMiss(miss, gapAnalysis!.principalName),
            peers: toPeerEvidence(miss.peers),
        }));

    return {
        basis,
        denominator: basis === "VIEWS" ? "views (realised audience)" : "follower count (potential audience)",
        principalRatedPosts: principal.rated.length,
        principalMedianRatePct: pct(formats.overall.median),
        formats: formats.formats.slice(0, MAX_FORMATS).map((f) => ({
            mediaType: f.mediaType,
            n: f.distribution.n,
            medianRatePct: pct(f.distribution.median),
            multipleOfOverall: mult(f.multipleOfOverall),
            outlierDriven: f.distribution.outlierDriven,
        })),
        bestHours: bestHours(timing, MAX_BEST_HOURS).map((h) => ({
            hour: h.hour,
            label: `${String(h.hour).padStart(2, "0")}:00`,
            n: h.n,
            multipleOfOverall: mult(h.multipleOfOverall),
        })),
        timezone: timing.timezone,
        suppressedCells: timing.suppressedCells,
        rank:
            comparison?.principalRank == null
                ? null
                : { position: comparison.principalRank, outOf: comparison.rankedOutOf },
        peerBenchmarkRatePct: comparison?.peerBenchmark == null ? null : pct(comparison.peerBenchmark),
        principalVsPeers: comparison?.principalVsPeers == null ? null : mult(comparison.principalVsPeers),
        comparisonSentence: comparison === null ? "No comparison available on this basis." : describeComparison(comparison),
        peerWindows: (windows?.peers ?? []).map((w) => ({
            personName: w.personName,
            label: w.label,
            n: w.n,
            multipleOfOverall: mult(w.multipleOfOverall),
        })),
        gaps,
        nearMisses,
        gapCoverage: (gapAnalysis?.coverage ?? []).map((c) => ({
            dimension: c.dimension,
            bucketsConsidered: c.bucketsConsidered,
            bucketsTestable: c.bucketsTestable,
            gaps: c.gaps,
            nearMisses: c.nearMisses,
        })),
        overInvested: (gapAnalysis?.overInvested ?? []).slice(0, MAX_OVER_INVESTED).map((o) => ({
            label: o.label,
            n: o.n,
            shareOfOutputPct: sharePct(o.shareOfOutput),
            lift: mult(o.lift),
            sentence: describeOverInvestment(o, gapAnalysis!.principalName),
        })),
        bestPosts: (posts?.best ?? []).map(toReportPost),
        worstPosts: (posts?.worst ?? []).map(toReportPost),
    };
}

/**
 * Build the analytics document for one filter.
 *
 * Every platform is reported separately and never blended, because a
 * cross-platform average would mix engagement bases. Within a platform, the
 * basis-free dimensions (cadence, format mix) sit at platform level and the
 * rate-bearing ones are nested one level down per basis — which is the shape of
 * the honesty rule rather than a filing convenience.
 */
export async function buildReport(filter: CorpusFilter = {}): Promise<AnalyticsReport> {
    const corpora = await loadCorpora(filter);
    const notes: string[] = [];
    const truncations: string[] = [];

    const principalNames = [...new Set(corpora.filter((c) => c.role === "PRINCIPAL").map((c) => c.personName))];
    const peerNames = [...new Set(corpora.filter((c) => c.role === "COMPETITOR").map((c) => c.personName))];

    if (principalNames.length === 0) {
        notes.push("No principal account is configured — every comparison in this report is unavailable.");
    }
    if (principalNames.length > 1) {
        notes.push(`More than one principal is configured (${principalNames.join(", ")}); using ${principalNames[0]}.`);
    }

    const allPosts = corpora.flatMap((c) => c.posts);
    const seededPosts = allPosts.filter((p) => p.isSynthetic).length;

    const times = allPosts.map((p) => p.postedAt.getTime());
    const window =
        times.length === 0
            ? null
            : {
                  from: new Date(Math.min(...times)).toISOString(),
                  to: new Date(Math.max(...times)).toISOString(),
                  days: Math.max(Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000), 1),
              };

    const platforms = [...new Set(corpora.map((c) => c.platform))].sort();

    const sections: ReportPlatformSection[] = [];

    for (const platform of platforms) {
        const onPlatform = corpora.filter((c) => c.platform === platform);
        const platformPosts = onPlatform.flatMap((c) => c.posts);
        if (platformPosts.length === 0) continue;

        const { provenance, seededAccounts } = provenanceOf(onPlatform);

        // Cadence and format mix are counted over EVERY post, not only rated
        // ones — see cadence.ts. They carry no denominator and therefore no
        // basis, which is why they sit here rather than inside a basis section.
        const cadenceComparison: CadenceComparison | null = compareCadence(
            onPlatform.map((c) => ({
                accountId: c.accountId,
                personName: c.personName,
                role: c.role,
                handle: c.handle,
                isSynthetic: c.isSynthetic,
                timezone: c.timezone,
                posts: c.posts,
            })),
        );

        const mix: FormatMixComparison = compareFormatMix(
            onPlatform.map((c) => ({
                accountId: c.accountId,
                personName: c.personName,
                role: c.role,
                isSynthetic: c.isSynthetic,
                posts: c.posts as readonly CorpusPost[],
            })),
        );

        const bases: ReportBasisSection[] = [];
        for (const basis of ["VIEWS", "FOLLOWERS"] as const) {
            const section = buildBasisSection(onPlatform, basis, platform, truncations);
            if (section !== null) bases.push(section);
        }

        if (bases.length === 0) {
            notes.push(`${platform}: no computable engagement rates — every post is missing metrics or a denominator.`);
        }

        sections.push({
            platform,
            totalPosts: platformPosts.length,
            provenance,
            seededAccounts,
            cadence:
                cadenceComparison === null || cadenceComparison.principal === null
                    ? null
                    : {
                          // The principal's OWN figures are withheld alongside the
                          // comparison when histories do not cover the window, and
                          // not only the cross-account ones. They are computed over
                          // the same window his data does not span, so they are
                          // wrong in the same way — the X run that motivated this
                          // reported him posting in 30% of weeks when he posts most
                          // days, because seven of the ten blocks predated anything
                          // that was fetched. `sentence` explains the blanks.
                          principalPostsPerWeek: cadenceComparison.comparable
                              ? mult(cadenceComparison.principal.postsPerWeek)
                              : null,
                          peerMedianPostsPerWeek:
                              cadenceComparison.peerBenchmark === null ? null : mult(cadenceComparison.peerBenchmark),
                          principalVsPeers:
                              cadenceComparison.principalVsPeers === null ? null : mult(cadenceComparison.principalVsPeers),
                          principalConsistencyPct: cadenceComparison.comparable
                              ? sharePct(cadenceComparison.principal.consistency)
                              : null,
                          peerConsistencyPct:
                              cadenceComparison.peerConsistency === null ? null : sharePct(cadenceComparison.peerConsistency),
                          principalLongestSilenceDays:
                              !cadenceComparison.comparable ||
                              cadenceComparison.principal.longestSilenceDays === null
                                  ? null
                                  : Math.round(cadenceComparison.principal.longestSilenceDays),
                          sentence: describeCadence(cadenceComparison),
                      },
            // Only divergences worth a sentence. A one-point difference in
            // allocation is not a finding, and every row here becomes a number
            // the validator will accept.
            formatMixDivergences: mix.divergences
                .filter((d) => Math.abs(d.difference) >= 0.1)
                .slice(0, MAX_FORMATS)
                .map((d) => ({
                    mediaType: d.mediaType,
                    principalSharePct: sharePct(d.principalShare),
                    peerSharePct: sharePct(d.peerShare),
                })),
            bases,
        });
    }

    if (seededPosts > 0) {
        notes.push(
            `${seededPosts} of ${allPosts.length} posts in this report are seeded, not fetched. Any finding resting ` +
                `on them demonstrates that the pipeline works, not that the finding is true of the real world.`,
        );
    }

    const classified = allPosts.filter((p) => p.theme !== null).length;
    if (classified === 0) {
        notes.push("No post is classified, so theme analysis and theme gaps are unavailable.");
    } else if (classified < allPosts.length) {
        notes.push(`${classified} of ${allPosts.length} posts are classified; theme figures cover that subset only.`);
    }

    return {
        generatedAt: new Date().toISOString(),
        principalName: principalNames[0] ?? null,
        peerNames,
        window,
        filter,
        corpusProvenance: {
            totalPosts: allPosts.length,
            livePosts: allPosts.length - seededPosts,
            seededPosts,
            seededPct: allPosts.length === 0 ? 0 : Math.round((seededPosts / allPosts.length) * 100),
        },
        platforms: sections,
        notes,
        truncations,
    };
}

// ── The evidence index ───────────────────────────────────────────────────

export interface Evidence {
    /** Every number in the report, mapped to the paths it appears at. */
    numbers: Map<number, string[]>;
    /** Every post id the report cites. A recommendation may reference no other. */
    postIds: Set<string>;
}

/**
 * Every numeric literal in a string, as it was WRITTEN.
 *
 * Exported because `validate.ts` must use this exact function rather than its
 * own. Indexing and checking are two halves of one contract, and two regexes
 * that agree today drift apart the first time either is edited — at which point
 * the validator starts rejecting numbers that ARE in the evidence, which is the
 * pressure that gets validators loosened until they stop checking.
 *
 * The strings are returned unparsed because the written form carries the
 * PRECISION, and `validate.ts` needs that to tell a legitimate coarser
 * restatement of a verified figure from a fabricated one.
 */
export function numericLiterals(text: string): string[] {
    return text.match(/-?\d+(?:\.\d+)?/g) ?? [];
}

/**
 * Walk the report and index every number and post id in it.
 *
 * Generic rather than a hand-maintained list of fields, for one reason: a
 * hand-maintained list drifts. Someone adds a figure to the report, forgets to
 * add it to the index, and the validator starts rejecting a number that IS in
 * the evidence — which trains everyone to loosen the validator. A walk cannot
 * fall out of sync with the thing it walks.
 *
 * THE INVARIANT: every number the model can SEE must be a number the validator
 * ACCEPTS. Anything else is a validator that punishes the model for reading its
 * own evidence, and the only way to make it pass is to loosen it until it stops
 * checking anything.
 *
 * The first real run broke that invariant. The report carried
 * `principalVsPeers: 0.61` alongside a pre-written sentence reading "1.63×
 * behind the peer benchmark" — the same fact, correctly rounded from opposite
 * ends. Skipping prose meant a model quoting 1.63 straight out of the evidence
 * would have been rejected as a fabricator. So the pre-written sentences ARE
 * indexed: they are composed by deterministic code from computed figures, which
 * is exactly what "verified" means. Several per-peer figures (`n=8, 1.45×`)
 * exist only in that prose, and indexing them is how they become citable.
 */
export function collectEvidence(report: AnalyticsReport): Evidence {
    const numbers = new Map<number, string[]>();
    const postIds = new Set<string>();

    const record = (value: number, path: string) => {
        if (!Number.isFinite(value)) return;
        const paths = numbers.get(value);
        if (paths) paths.push(path);
        else numbers.set(value, [path]);
    };

    /**
     * Prose this module composed from verified figures. Numeric literals count.
     *
     * `label` and `peerAgreement` are here rather than on the opaque list, and
     * the reason is a second instance of the same invariant break the doc
     * comment below describes — caught by the validator's own tests.
     *
     * A `ReportGap` has no numeric hour field. The hour a gap is ABOUT exists
     * only inside its label, as "20:00". With labels unindexed, the model could
     * read "peers earn 1.72× at 20:00" straight out of its evidence and be
     * rejected as a fabricator the moment it wrote 20:00 back — and a timing
     * recommendation cannot be written without naming the hour. That is the
     * single most important recommendation this product makes, because the
     * principal's own corpus cannot produce one (see gaps.ts).
     *
     * `peerAgreement` is "2 of 3": two computed counts, and a model writing
     * "2 of 3 peers agree" is restating verified evidence, not inventing it.
     *
     * Neither addition meaningfully widens the accepted set — labels are
     * otherwise enum names with no digits in them — and both close a hole where
     * the model is punished for reading what it was given.
     */
    const PROSE_KEYS = new Set([
        "sentence",
        "comparisonSentence",
        "provenanceCaveat",
        "notes",
        "truncations",
        "label",
        "peerAgreement",
    ]);

    /**
     * Fields whose digits are not claims about performance.
     *
     * `captionExcerpt` is the load-bearing one. A caption may read "₹5,000 crore
     * scheme", and 5000 is a fact about the world that this system has not
     * verified and has no way to check. Recommendations cite computed figures,
     * never numbers lifted out of post text — the recommendation prompt says so
     * explicitly, and leaving captions unindexed is what enforces it.
     */
    const OPAQUE_KEYS = new Set([
        "generatedAt",
        "postedAt",
        "permalink",
        "captionExcerpt",
        "timezone",
        "denominator",
        "mediaType",
        "dimension",
        "kind",
        "provenance",
        "basis",
    ]);

    const recordProse = (text: string, path: string) => {
        for (const match of numericLiterals(text)) record(Number(match), path);
    };

    const walk = (node: unknown, path: string) => {
        if (node === null || node === undefined) return;

        if (typeof node === "number") {
            record(node, path);
            return;
        }

        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${path}[${index}]`));
            return;
        }

        if (typeof node === "object") {
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                const childPath = path === "" ? key : `${path}.${key}`;

                if (OPAQUE_KEYS.has(key)) continue;

                if (PROSE_KEYS.has(key)) {
                    if (typeof value === "string") recordProse(value, childPath);
                    else if (Array.isArray(value)) {
                        value.forEach((item, index) => {
                            if (typeof item === "string") recordProse(item, `${childPath}[${index}]`);
                        });
                    }
                    continue;
                }

                // `id` on a report post is the citable database id. Collected
                // separately from numbers because it is checked differently:
                // a number must match a value, an id must exist.
                if (key === "id" && typeof value === "string") {
                    postIds.add(value);
                    continue;
                }

                walk(value, childPath);
            }
        }
    };

    walk(report, "");

    return { numbers, postIds };
}
