// "What are they doing that we aren't?" — the other half of question 3.
//
// WHY THIS MODULE EXISTS, AND WHY IT IS NOT OPTIONAL
//
// Day 2 surfaced a finding that reshapes the whole recommendation layer. The
// principal's own best hours came out as 10:00, 11:00 and 08:00 — every one of
// them at roughly 1.0× his own median. The 7–9pm peak that the corpus demonstrably
// contains is nowhere in HIS data, and the timing engine is not wrong: he posts
// between 08:00 and 16:00 and never in the evening.
//
//   AN ACCOUNT'S OWN TIMING DATA CANNOT REVEAL A SLOT IT NEVER POSTS IN.
//
// So a recommendation drawn only from the principal's corpus will always say
// "keep doing roughly what you already do". The evening peak is visible only in
// the competitors' corpora. That makes this file the ONLY defensible source of a
// timing recommendation in the product — not a nice-to-have that rounds out the
// comparison. `recommend.ts` draws its timing evidence from here.
//
// THE STATISTIC, AND THE TRAP IT AVOIDS
//
// The obvious implementation pools every peer's posts in a bucket and compares
// that pool to the principal. A Day 2 test proved that is wrong: pooling format
// statistics across accounts conflates format QUALITY with posting HABIT. The
// accounts that post reels also post in the evening peak on the themes that
// travel, and the pooled figure inflated reel-over-link from the planted 3.45×
// to 6.46×. Pooling would reproduce that error here, one dimension wider.
//
// So nothing is pooled. Each peer is measured against ITSELF —
//
//     lift = (that peer's median rate in this bucket) / (that peer's overall median)
//
// — which is habit-free by construction, because an account's own baseline
// already contains its own habits. The peer figure is then the MEDIAN OF THOSE
// PER-PEER LIFTS, and a gap is only reported when at least MIN_PEER_ACCOUNTS
// separate peers clear the bar. One competitor who posts reels at 8pm and does
// well is that competitor's habit. Three of them agreeing is a pattern.
//
// ON COMPARING HOURS ACROSS ACCOUNTS: every hour here is LOCAL to the account it
// came from, so hour 19 for one account is compared against hour 19 for another
// even if their zones differ. That is deliberate — "evening, where your audience
// is" is the comparable quantity, not a shared UTC instant.

import {
    assertSingleBasis,
    partitionByBasis,
    type EngagementBasis,
    type MediaType,
    type RatedPost,
} from "./engagement";
import { median, describe as describeDistribution } from "./stats";
import { localSlot, type DayOfWeek, type TimingPost } from "./timing";
import type { AccountCorpus, AccountRole } from "./compare";

/**
 * The fixed content taxonomy. Produced by `ai/classify.ts`, consumed here.
 *
 * Fixed rather than model-induced for one reason: the principal and every
 * competitor must land in the SAME categories or a theme gap is meaningless.
 * An induced taxonomy drifts between corpora, and two drifted taxonomies cannot
 * be differenced.
 */
export type ContentPillar =
    | "POLICY_ANNOUNCEMENT"
    | "CONSTITUENCY_VISIT"
    | "PERSONAL_FAMILY"
    | "ATTACK_REBUTTAL"
    | "FESTIVAL_GREETING"
    | "ACHIEVEMENT_CLAIM"
    | "MEDIA_APPEARANCE"
    | "OTHER";

/** Below this, an account is not credited with a sample in a bucket. Matches format.ts. */
export const MIN_GAP_N = 5;

/**
 * How many separate peers must independently clear the bar before a gap is
 * reported. Two, not one: a single account's strong bucket is that account's
 * habit, and a recommendation built on it is a recommendation to imitate one
 * person rather than to follow a pattern.
 *
 * This is a gate on AGREEMENT, not merely on sample. Requiring two peers to
 * merely HAVE data and then reporting the median of their lifts is not the same
 * test, and the difference is not academic — the first real run of this module
 * surfaced an Instagram day-of-week "gap" at 1.38× built from one peer at 1.76×
 * and one at exactly 1.00×. The median of two values interpolates, so a single
 * enthusiastic peer dragged a flat second peer over the line. Two peers must
 * each clear GAP_LIFT_THRESHOLD on their own.
 */
export const MIN_PEER_ACCOUNTS = 2;

/**
 * How much better than their own baseline peers must perform in a bucket before
 * it counts as an opportunity worth naming, and how far behind the principal
 * must be before "he is present but losing" is worth saying.
 *
 * 1.2 — a 20% lift. Below that the difference is inside the noise of a 90-day
 * sample, and a recommendation to reorganise a communications calendar around it
 * would be spending real effort on a number that will not reproduce.
 */
export const GAP_LIFT_THRESHOLD = 1.2;

/** A post carrying everything the four gap dimensions need to bucket it. */
export interface GapPost extends TimingPost {
    /** Null until `ai/classify.ts` has run. Theme gaps report their own absence. */
    theme: ContentPillar | null;
}

/** An `AccountCorpus` plus the zone the hour and day dimensions are read in. */
export interface GapCorpus<T extends GapPost> extends AccountCorpus<T> {
    timezone: string;
}

export type GapDimension = "FORMAT" | "HOUR" | "DAY" | "THEME";

/**
 * Which bucket a gap is about, as a discriminated union rather than a string.
 *
 * `mergeHourWindows` narrows on this to find contiguous hours, and the UI
 * switches on it to render the right chip — both of which a `key: string` would
 * turn into parsing.
 */
export type GapKey =
    | { dimension: "FORMAT"; mediaType: MediaType }
    | { dimension: "HOUR"; hour: number }
    | { dimension: "DAY"; dayOfWeek: DayOfWeek }
    | { dimension: "THEME"; theme: ContentPillar };

/** One peer's evidence for one bucket. Every figure is that peer's own. */
export interface PeerEvidence {
    accountId: string;
    personName: string;
    isSynthetic: boolean;
    n: number;
    /** This peer's median rate inside the bucket. */
    bucketMedian: number;
    /** This peer's median rate across its whole rated corpus — its own baseline. */
    ownOverallMedian: number;
    /** bucketMedian / ownOverallMedian. Habit-free: the baseline contains the habits. */
    lift: number;
}

/** The principal's own position in a bucket, where he has one worth quoting. */
export interface PrincipalPosition {
    n: number;
    /** Share of the principal's rated posts that land in this bucket, 0–1. */
    shareOfOutput: number;
    /** Null where n < MIN_GAP_N — a thin sample is not given a figure. */
    bucketMedian: number | null;
    lift: number | null;
}

/**
 * Why this bucket is a gap.
 *
 * ABSENT and THIN are kept apart because they call for different sentences. "You
 * have never posted here" is a different conversation from "you have posted here
 * four times and we cannot tell yet" — and only the second one has a cheap next
 * step, which is to post there a few more times.
 */
export type GapKind = "ABSENT" | "THIN" | "UNDERPERFORMING";

/**
 * Whether the evidence behind a gap is real, generated, or both.
 *
 * Mirrors `compare.ts`, and for the same reason: three of the four tracked
 * people have a live YouTube channel and the fourth is seeded, so a genuine
 * finding can rest on a mixture. The first real run made the case for putting
 * this on the Gap rather than only on the analysis — the strongest YouTube gap
 * had its median lift set by the one seeded peer, which a reader is entitled to
 * know before acting on it.
 */
export interface GapProvenance {
    /** True when this gap's peer evidence spans live and generated accounts. */
    mixed: boolean;
    /** True when EVERY peer behind this gap is generated. */
    allSynthetic: boolean;
    syntheticPeers: string[];
}

export interface Gap {
    key: GapKey;
    /** Display-ready, computed once here so every surface names the bucket identically. */
    label: string;
    kind: GapKind;
    /** Median of the per-peer lifts. The headline figure for this gap. */
    peerLift: number;
    /**
     * How many qualifying peers independently cleared GAP_LIFT_THRESHOLD, out of
     * how many had a large enough sample to be counted. `clearing` is the gate;
     * `of` is the context that makes it readable ("2 of 3", not just "2").
     */
    peerAgreement: { clearing: number; of: number };
    peers: PeerEvidence[];
    principal: PrincipalPosition;
    provenance: GapProvenance;
    /**
     * The multiple on the table, comparable across kinds so one ranking holds
     * all of them: the forgone lift where the principal is absent or thin, and
     * peerLift ÷ his own lift where he is present but behind.
     */
    opportunity: number;
}

/**
 * A bucket the principal leans on that does not repay the investment.
 *
 * The inverse of a gap, and the source of every "stop" recommendation. Kept
 * separate from `Gap` because the evidence is different: this is measured
 * against the principal's OWN baseline, so it stands even where no peer posts
 * in the bucket at all.
 */
export interface OverInvestment {
    key: GapKey;
    label: string;
    n: number;
    /** Share of the principal's rated posts spent here, 0–1. */
    shareOfOutput: number;
    bucketMedian: number;
    /** Below 1: a post here typically does worse than his typical post. */
    lift: number;
}

export interface GapAnalysis {
    basis: EngagementBasis;
    /** Every gap found, best opportunity first, across all four dimensions. */
    gaps: Gap[];
    /** Where the principal's output is going for a below-baseline return. */
    overInvested: OverInvestment[];
    principalName: string;
    /** Rated posts behind the principal's side of every figure above. */
    principalRatedPosts: number;
    /** Peers that contributed evidence anywhere in this analysis. */
    peersConsidered: string[];
    /**
     * What could not be computed and why — an empty `gaps` array is ambiguous
     * between "no gaps exist" and "the theme dimension has no data yet", and the
     * two mean opposite things to a reader.
     */
    notes: string[];
}

// ── Labels ───────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function labelFor(key: GapKey): string {
    switch (key.dimension) {
        case "FORMAT":
            return key.mediaType;
        case "HOUR":
            return `${String(key.hour).padStart(2, "0")}:00`;
        case "DAY":
            return DAY_NAMES[key.dayOfWeek];
        case "THEME":
            return key.theme;
    }
}

/** Stable map key. Never leaves this module — `GapKey` is the public identity. */
function mapKeyFor(key: GapKey): string {
    switch (key.dimension) {
        case "FORMAT":
            return `FORMAT:${key.mediaType}`;
        case "HOUR":
            return `HOUR:${key.hour}`;
        case "DAY":
            return `DAY:${key.dayOfWeek}`;
        case "THEME":
            return `THEME:${key.theme}`;
    }
}

// ── Bucketing ────────────────────────────────────────────────────────────

/**
 * Every bucket one post belongs to — one per dimension, skipping any the post
 * cannot answer for.
 *
 * A post is deliberately counted in all four. The dimensions are not a partition
 * of the corpus; they are four different questions asked of the same post, and
 * an evening reel about a constituency visit is genuine evidence for all three.
 */
function bucketsFor(post: GapPost, timezone: string): GapKey[] {
    const { dayOfWeek, hour } = localSlot(post.postedAt, timezone);

    const keys: GapKey[] = [
        { dimension: "FORMAT", mediaType: post.mediaType },
        { dimension: "HOUR", hour },
        { dimension: "DAY", dayOfWeek },
    ];

    // Unclassified posts contribute to the other three dimensions and are simply
    // absent from the theme one. Bucketing them as OTHER would invent a finding
    // about a category that means "we could not tell".
    if (post.theme !== null) {
        keys.push({ dimension: "THEME", theme: post.theme });
    }

    return keys;
}

interface AccountBuckets {
    accountId: string;
    personName: string;
    role: AccountRole;
    isSynthetic: boolean;
    ratedPosts: number;
    /** This account's baseline. Every lift in this file is measured against it. */
    overallMedian: number;
    buckets: Map<string, { key: GapKey; rates: number[] }>;
}

function bucketAccount<T extends GapPost>(corpus: GapCorpus<T>): AccountBuckets | null {
    if (corpus.rated.length === 0) return null;

    const overall = describeDistribution(corpus.rated.map((r) => r.engagement.rate));
    if (overall === null) return null;

    const buckets = new Map<string, { key: GapKey; rates: number[] }>();

    for (const { post, engagement } of corpus.rated) {
        for (const key of bucketsFor(post, corpus.timezone)) {
            const mapKey = mapKeyFor(key);
            const existing = buckets.get(mapKey);
            if (existing) existing.rates.push(engagement.rate);
            else buckets.set(mapKey, { key, rates: [engagement.rate] });
        }
    }

    return {
        accountId: corpus.accountId,
        personName: corpus.personName,
        role: corpus.role,
        isSynthetic: corpus.isSynthetic,
        ratedPosts: corpus.rated.length,
        overallMedian: overall.median,
        buckets,
    };
}

function medianOf(values: readonly number[]): number {
    return median([...values].sort((a, b) => a - b));
}

// ── The analysis ─────────────────────────────────────────────────────────

/**
 * Find what the peer set is doing that the principal is not, on ONE basis.
 *
 * Every corpus must already be rated on the same basis — mixing throws via
 * `assertSingleBasis`, for the same reason it does everywhere else. Use
 * `findGapsByBasis` for a corpus that legitimately spans both.
 *
 * Returns null when there is no principal, no peer, or no rated post to work
 * from — all three are "no data", not errors.
 */
export function findGaps<T extends GapPost>(
    corpora: readonly GapCorpus<T>[],
    context = "gap analysis",
): GapAnalysis | null {
    const allRates = corpora.flatMap((c) => c.rated.map((r) => r.engagement));
    const basis = assertSingleBasis(allRates, context);
    if (basis === null) return null;

    const bucketed = corpora.map(bucketAccount).filter((b): b is AccountBuckets => b !== null);

    const principal = bucketed.find((b) => b.role === "PRINCIPAL");
    const peers = bucketed.filter((b) => b.role === "COMPETITOR");

    if (principal === undefined) return null;

    const notes: string[] = [];

    if (peers.length === 0) {
        notes.push("No peer corpus on this basis — gap analysis needs at least one competitor to compare against.");
        return {
            basis,
            gaps: [],
            overInvested: [],
            principalName: principal.personName,
            principalRatedPosts: principal.ratedPosts,
            peersConsidered: [],
            notes,
        };
    }

    if (peers.length < MIN_PEER_ACCOUNTS) {
        notes.push(
            `Only ${peers.length} peer has data on this basis, and a gap requires ${MIN_PEER_ACCOUNTS} independent ` +
                `peers to agree — one account's strong bucket is that account's habit, not a pattern. No gaps reported.`,
        );
    }

    // A lift is a ratio against the account's own median, so an account whose
    // median is 0 has no usable baseline. Excluded from peer evidence rather
    // than contributing an Infinity that would dominate every ranking.
    const unusablePeers = peers.filter((p) => p.overallMedian === 0);
    for (const peer of unusablePeers) {
        notes.push(`${peer.personName} excluded: median engagement rate is 0, so a lift against it is undefined.`);
    }
    const usablePeers = peers.filter((p) => p.overallMedian > 0);

    const themedPosts = [...principal.buckets.keys()].filter((k) => k.startsWith("THEME:")).length;
    if (themedPosts === 0) {
        notes.push(
            "Theme gaps unavailable: no post in this corpus is classified yet. Run the classification step " +
                "(POST /api/ai/classify) to populate the theme dimension.",
        );
    }

    // Every bucket anyone posts in, so a bucket the principal has never touched
    // is still considered — which is the entire point of the module.
    const allBucketKeys = new Map<string, GapKey>();
    for (const account of [principal, ...usablePeers]) {
        for (const [mapKey, bucket] of account.buckets) allBucketKeys.set(mapKey, bucket.key);
    }

    const gaps: Gap[] = [];

    for (const [mapKey, key] of allBucketKeys) {
        const evidence: PeerEvidence[] = [];

        for (const peer of usablePeers) {
            const bucket = peer.buckets.get(mapKey);
            if (bucket === undefined || bucket.rates.length < MIN_GAP_N) continue;

            const bucketMedian = medianOf(bucket.rates);
            evidence.push({
                accountId: peer.accountId,
                personName: peer.personName,
                isSynthetic: peer.isSynthetic,
                n: bucket.rates.length,
                bucketMedian,
                ownOverallMedian: peer.overallMedian,
                lift: bucketMedian / peer.overallMedian,
            });
        }

        if (evidence.length < MIN_PEER_ACCOUNTS) continue;

        // The agreement gate. Each peer must clear the bar on its own — see the
        // note on MIN_PEER_ACCOUNTS for the real finding this rule killed.
        const clearing = evidence.filter((e) => e.lift >= GAP_LIFT_THRESHOLD).length;
        if (clearing < MIN_PEER_ACCOUNTS) continue;

        const peerLift = medianOf(evidence.map((e) => e.lift));
        if (peerLift < GAP_LIFT_THRESHOLD) continue; // peers do not win here either

        const principalBucket = principal.buckets.get(mapKey);
        const principalN = principalBucket?.rates.length ?? 0;

        const position: PrincipalPosition = {
            n: principalN,
            shareOfOutput: principal.ratedPosts === 0 ? 0 : principalN / principal.ratedPosts,
            bucketMedian: null,
            lift: null,
        };

        let kind: GapKind;
        let opportunity: number;

        if (principalN === 0) {
            kind = "ABSENT";
            opportunity = peerLift;
        } else if (principalN < MIN_GAP_N) {
            // Present, but below the bar this product quotes figures at. The
            // count is reported; the rate deliberately is not.
            kind = "THIN";
            opportunity = peerLift;
        } else {
            const bucketMedian = medianOf(principalBucket!.rates);
            position.bucketMedian = bucketMedian;

            if (principal.overallMedian === 0) continue; // no baseline to measure against

            const principalLift = bucketMedian / principal.overallMedian;
            position.lift = principalLift;

            // He is already at least as good here as the peer set is. Not a gap.
            if (principalLift <= 0 || peerLift / principalLift < GAP_LIFT_THRESHOLD) continue;

            kind = "UNDERPERFORMING";
            opportunity = peerLift / principalLift;
        }

        evidence.sort((a, b) => b.lift - a.lift);

        const syntheticPeers = evidence.filter((e) => e.isSynthetic).map((e) => e.personName);

        gaps.push({
            key,
            label: labelFor(key),
            kind,
            peerLift,
            peerAgreement: { clearing, of: evidence.length },
            peers: evidence,
            principal: position,
            provenance: {
                mixed: syntheticPeers.length > 0 && syntheticPeers.length < evidence.length,
                allSynthetic: syntheticPeers.length === evidence.length,
                syntheticPeers,
            },
            opportunity,
        });
    }

    // Biggest multiple first. An absent bucket breaks a tie ahead of an
    // underperforming one: adding a slot the principal has never used is a
    // cleaner action than asking him to get better at something he already does.
    const KIND_TIEBREAK: Record<GapKind, number> = { ABSENT: 0, THIN: 1, UNDERPERFORMING: 2 };
    gaps.sort((a, b) => b.opportunity - a.opportunity || KIND_TIEBREAK[a.kind] - KIND_TIEBREAK[b.kind]);

    return {
        basis,
        gaps: peers.length < MIN_PEER_ACCOUNTS ? [] : gaps,
        overInvested: findOverInvestment(principal),
        principalName: principal.personName,
        principalRatedPosts: principal.ratedPosts,
        peersConsidered: usablePeers.map((p) => p.personName),
        notes,
    };
}

/**
 * Buckets the principal spends real output on for a below-baseline return.
 *
 * Measured entirely against his OWN median, which is why it needs no peer and
 * survives a corpus where the peer set is thin. `shareOfOutput` is the reason
 * this is actionable rather than merely true: a format that underperforms and
 * takes 2% of the calendar is not worth a recommendation, and one that takes
 * 30% is the recommendation.
 */
function findOverInvestment(principal: AccountBuckets): OverInvestment[] {
    if (principal.overallMedian <= 0 || principal.ratedPosts === 0) return [];

    /** Below this share of output, fixing the bucket cannot move the account. */
    const MIN_SHARE = 0.1;

    const out: OverInvestment[] = [];

    for (const [, bucket] of principal.buckets) {
        if (bucket.rates.length < MIN_GAP_N) continue;

        const shareOfOutput = bucket.rates.length / principal.ratedPosts;
        if (shareOfOutput < MIN_SHARE) continue;

        const bucketMedian = medianOf(bucket.rates);
        const lift = bucketMedian / principal.overallMedian;

        // Symmetric with GAP_LIFT_THRESHOLD: 1/1.2 ≈ 0.83, so a bucket has to be
        // ~17% below baseline to be called out, not merely a shade under it.
        if (lift > 1 / GAP_LIFT_THRESHOLD) continue;

        out.push({ key: bucket.key, label: labelFor(bucket.key), n: bucket.rates.length, shareOfOutput, bucketMedian, lift });
    }

    // Worst return first, but weighted by how much output is at stake — a 0.5×
    // bucket holding 40% of the calendar outranks a 0.4× bucket holding 11%.
    out.sort((a, b) => b.shareOfOutput / b.lift - a.shareOfOutput / a.lift);

    return out;
}

/**
 * The entry point for a corpus that spans platforms.
 *
 * Same reasoning as everywhere else: a set covering YouTube (views) and
 * Instagram carousels (followers) contains both bases and cannot be one
 * analysis. Either side may be null, meaning no post used that denominator.
 */
export function findGapsByBasis<T extends GapPost>(
    corpora: readonly GapCorpus<T>[],
    context = "gap analysis",
): Record<EngagementBasis, GapAnalysis | null> {
    const split: Record<EngagementBasis, GapCorpus<T>[]> = { VIEWS: [], FOLLOWERS: [] };

    for (const corpus of corpora) {
        const byBasis = partitionByBasis(corpus.rated);
        if (byBasis.VIEWS.length > 0) split.VIEWS.push({ ...corpus, rated: byBasis.VIEWS });
        if (byBasis.FOLLOWERS.length > 0) split.FOLLOWERS.push({ ...corpus, rated: byBasis.FOLLOWERS });
    }

    return {
        VIEWS: split.VIEWS.length > 0 ? findGaps(split.VIEWS, `${context} [VIEWS]`) : null,
        FOLLOWERS: split.FOLLOWERS.length > 0 ? findGaps(split.FOLLOWERS, `${context} [FOLLOWERS]`) : null,
    };
}

// ── Hour windows ─────────────────────────────────────────────────────────

export interface HourWindow {
    /** Local hour the window opens, inclusive. */
    startHour: number;
    /** Local hour the window closes, inclusive — 19 and 21 means 19:00–21:59. */
    endHour: number;
    label: string;
    /** Median of the merged hours' peer lifts. */
    peerLift: number;
    /** True when the principal posts in none of the merged hours. */
    principalAbsent: boolean;
    hours: Gap[];
}

/**
 * Collapse adjacent hour gaps into windows.
 *
 * A comms manager schedules a window, not an hour — "post between 19:00 and
 * 21:00" is an instruction, "post at 19:00, and also at 20:00, and also at
 * 21:00" is three instructions that mean the same thing. Three separate
 * recommendations built from one contiguous finding would also read as three
 * independent pieces of evidence, which they are not.
 *
 * Wrap-around is not merged: a 23:00 and a 00:00 gap stay separate, because a
 * window that crosses midnight is a different scheduling instruction and the
 * corpus here gives no reason to assume it.
 */
export function mergeHourWindows(gaps: readonly Gap[]): HourWindow[] {
    const hourGaps = gaps
        .filter((g): g is Gap & { key: { dimension: "HOUR"; hour: number } } => g.key.dimension === "HOUR")
        .sort((a, b) => a.key.hour - b.key.hour);

    const windows: HourWindow[] = [];
    let run: (Gap & { key: { dimension: "HOUR"; hour: number } })[] = [];

    const flush = () => {
        if (run.length === 0) return;
        const startHour = run[0].key.hour;
        const endHour = run[run.length - 1].key.hour;
        windows.push({
            startHour,
            endHour,
            label:
                startHour === endHour
                    ? `${String(startHour).padStart(2, "0")}:00`
                    : `${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:59`,
            peerLift: medianOf(run.map((g) => g.peerLift)),
            principalAbsent: run.every((g) => g.kind === "ABSENT"),
            hours: [...run],
        });
        run = [];
    };

    for (const gap of hourGaps) {
        if (run.length > 0 && gap.key.hour !== run[run.length - 1].key.hour + 1) flush();
        run.push(gap);
    }
    flush();

    return windows.sort((a, b) => b.peerLift - a.peerLift);
}

// ── Narrative ────────────────────────────────────────────────────────────

/**
 * One sentence a comms manager can read, with the evidence attached.
 *
 * Lives here rather than in the UI so the dashboard, the Markdown export and the
 * AI prompt all describe the same gap the same way — and so the AI layer is
 * handed a sentence built from verified numbers rather than asked to compose one
 * from figures it might round differently.
 */
export function describeGap(gap: Gap, principalName: string): string {
    const peerList = gap.peers
        .map((p) => `${p.personName} (n=${p.n}, ${p.lift.toFixed(2)}×${p.isSynthetic ? ", SEEDED" : ""})`)
        .join(", ");

    const agreement =
        `${gap.peerAgreement.clearing} of ${gap.peerAgreement.of} peers clear the ` +
        `${GAP_LIFT_THRESHOLD}× bar here independently`;

    // Appended rather than woven in, so the caveat cannot be lost when a caller
    // truncates the sentence — and so the AI layer receives it as a distinct
    // clause it can be instructed to preserve.
    const caveat = gap.provenance.allSynthetic
        ? ` CAVEAT: every peer behind this figure is seeded data (${gap.provenance.syntheticPeers.join(", ")}) — it demonstrates the pipeline, not a real-world finding.`
        : gap.provenance.mixed
          ? ` NOTE: this figure mixes live and seeded peers — seeded: ${gap.provenance.syntheticPeers.join(", ")}.`
          : "";

    const dimension =
        gap.key.dimension === "HOUR"
            ? `the ${gap.label} hour`
            : gap.key.dimension === "DAY"
              ? gap.label
              : gap.key.dimension === "FORMAT"
                ? `the ${gap.label} format`
                : `the ${gap.label} theme`;

    switch (gap.kind) {
        case "ABSENT":
            return (
                `${principalName} has no posts in ${dimension}, where peers earn ${gap.peerLift.toFixed(2)}× ` +
                `their own typical post — ${agreement}. Evidence: ${peerList}.${caveat}`
            );
        case "THIN":
            return (
                `${principalName} has only ${gap.principal.n} post(s) in ${dimension} — below the ${MIN_GAP_N}-post ` +
                `bar for quoting a rate — while peers earn ${gap.peerLift.toFixed(2)}× their own typical post there. ` +
                `${agreement}. Evidence: ${peerList}.${caveat}`
            );
        case "UNDERPERFORMING":
            return (
                `In ${dimension}, ${principalName} earns ${gap.principal.lift!.toFixed(2)}× his own baseline across ` +
                `${gap.principal.n} posts, against ${gap.peerLift.toFixed(2)}× for the peer set — a ` +
                `${gap.opportunity.toFixed(2)}× shortfall. ${agreement}. Evidence: ${peerList}.${caveat}`
            );
    }
}

/** As `describeGap`, for the "stop" side. */
export function describeOverInvestment(item: OverInvestment, principalName: string): string {
    return (
        `${principalName} spends ${(item.shareOfOutput * 100).toFixed(0)}% of his output on ${item.label} ` +
        `(n=${item.n}), where a typical post earns ${item.lift.toFixed(2)}× his own baseline.`
    );
}
