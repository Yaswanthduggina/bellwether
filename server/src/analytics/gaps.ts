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
import { groupContiguousHours, localSlot, type DayOfWeek, type TimingPost } from "./timing";
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
 * reported.
 *
 * ── ONE. THIS WAS TWO, AND THE HISTORY MATTERS ───────────────────────────
 *
 * The original value was 2, on the argument that a single account's strong
 * bucket is that account's HABIT rather than a pattern, and that a
 * recommendation built on it is a recommendation to imitate one person. That
 * argument is not wrong, and the finding that produced it was real: the first
 * run of this module surfaced an Instagram day-of-week "gap" at 1.38× built from
 * one peer at 1.76× and one at exactly 1.00×, where the median of two values
 * interpolated and a single enthusiastic peer dragged a flat one over the line.
 *
 * It is now 1, by product decision: one competitor demonstrably beating its own
 * baseline in a bucket is worth surfacing, and the cost of missing a real
 * opportunity was judged higher than the cost of showing a thin one.
 *
 * WHAT PROTECTS THE READER INSTEAD. Two things carry the weight the gate used
 * to, and neither existed when the gate was written:
 *
 *   1. `peerLift` is now the median of the CLEARING peers, not of every peer
 *      with a sample. That is what kills the 1.38× case specifically — the
 *      interpolation between a strong peer and a flat one can no longer produce
 *      a headline figure that no peer actually achieved. A gap built on one peer
 *      at 1.76× reports 1.76×, which is true of that peer and checkable.
 *   2. `peerAgreement` ("1 of 3") and the per-peer evidence rows ship to the UI,
 *      so a finding resting on a single account is visibly a finding resting on
 *      a single account rather than an anonymous "peers do this".
 *
 * Raising this back to 2 is a one-line change and the near-miss machinery below
 * is written to handle any value — at 1, the only reachable near-miss reason is
 * PRINCIPAL_COMPETITIVE, because every clearing peer now produces a gap.
 */
export const MIN_PEER_ACCOUNTS = 1;

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
    /**
     * Median of the lifts of the peers that CLEARED the bar. The headline figure.
     *
     * Deliberately not the median across every peer with a sample. That version
     * interpolates: one peer at 1.76× and one at 1.00× produced a reported 1.38×,
     * a number no peer achieved and nobody can check against an account. Taking
     * the median of the clearing peers only means the figure is always one a
     * named peer actually earned, which is what makes the evidence rows beside it
     * verifiable. `peerAgreement` carries how many of the peers with data that is.
     */
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

/**
 * Why a candidate bucket did not become a reported gap.
 *
 * Each value corresponds to exactly one gate in `findGaps`, in the order the
 * gates are applied. Kept as a union rather than a message string so the UI can
 * group by reason and the set cannot drift from the gates it describes.
 */
export type NearMissReason =
    /** Fewer peers had a large enough sample than MIN_PEER_ACCOUNTS requires. */
    | "SINGLE_PEER_ONLY"
    /** Enough peers had data; fewer than MIN_PEER_ACCOUNTS cleared the bar. */
    | "NO_PEER_AGREEMENT"
    /** Peers do well here — and so does the principal, so there is no gap. */
    | "PRINCIPAL_COMPETITIVE";

/**
 * A bucket that was evaluated, showed something, and was rejected anyway.
 *
 * WHY THIS EXISTS. Written when MIN_PEER_ACCOUNTS was 2 and the gates rejected
 * nearly everything on a real corpus — the first live run across three platforms
 * returned ONE gap in six basis-platform combinations. "No gap clears the bar",
 * rendered on its own, is indistinguishable to a reader from "we did not look",
 * and it throws away the most useful thing the analysis knows: WHICH buckets came
 * close and what specifically stopped them.
 *
 * WHAT IT DOES NOW THAT THE PEER FLOOR IS 1. Most of what used to land here is a
 * reported gap instead, so this list is short and its remaining job is the one
 * case that is good news rather than a missed test: PRINCIPAL_COMPETITIVE, where
 * peers do well in a bucket AND so does the principal. That still needs saying —
 * a reader scanning a panel cannot otherwise tell a bucket that was checked and
 * cleared from one that was never testable.
 *
 * The entry rule stays narrow: at least one peer must have cleared
 * GAP_LIFT_THRESHOLD on its own. Buckets where nothing happened do not appear.
 *
 * Kept intact rather than trimmed to the one live case, because the floor is a
 * one-line constant and the other reasons become reachable the moment it is
 * raised. Deleting tested machinery to match a tunable setting is how the setting
 * stops being tunable.
 *
 * A near miss is NOT a finding and must never be presented as one. It is the
 * evidence trail behind a refusal.
 */
export interface NearMiss {
    key: GapKey;
    label: string;
    reason: NearMissReason;
    /** Median of the per-peer lifts among peers with a large enough sample. */
    peerLift: number;
    peerAgreement: { clearing: number; of: number };
    peers: PeerEvidence[];
    principal: PrincipalPosition;
    /**
     * What would have to be true for this to become a reportable gap — the
     * actionable half. "Watch this bucket" is not a next step; "one more peer
     * clearing 1.2x would make this a finding" is.
     */
    whatWouldChangeIt: string;
}

/** How much of the corpus a dimension could actually speak for. */
export interface DimensionCoverage {
    dimension: GapDimension;
    /** Distinct buckets anyone posted in. */
    bucketsConsidered: number;
    /** Buckets where enough peers had a large enough sample to be testable. */
    bucketsTestable: number;
    gaps: number;
    nearMisses: number;
}

export interface GapAnalysis {
    basis: EngagementBasis;
    /** Every gap found, best opportunity first, across all four dimensions. */
    gaps: Gap[];
    /**
     * Buckets that showed something and were rejected, closest first.
     *
     * Present so that an empty `gaps` array is legible rather than merely blank.
     * See the `NearMiss` docblock — these are not findings.
     */
    nearMisses: NearMiss[];
    /** What each dimension was able to test, so a silent dimension is visible. */
    coverage: DimensionCoverage[];
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
            nearMisses: [],
            coverage: [],
            overInvested: [],
            principalName: principal.personName,
            principalRatedPosts: principal.ratedPosts,
            peersConsidered: [],
            notes,
        };
    }

    // At MIN_PEER_ACCOUNTS = 1 this is unreachable (peers.length === 0 returns
    // above), and it is kept rather than deleted for the same reason the unused
    // near-miss reasons are: the floor is a one-line constant, and this is the
    // note that has to fire the moment it is raised again.
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

    // Counted over POSTS, not over distinct theme buckets. Coverage is the
    // question — "how much of this corpus does the theme dimension actually
    // speak for" — and a corpus where every classified post landed in one
    // category has one bucket and may still be fully classified.
    const themedRated = corpora.flatMap((c) => c.rated).filter((r) => r.post.theme !== null).length;
    const totalRated = corpora.reduce((sum, c) => sum + c.rated.length, 0);

    if (themedRated === 0) {
        notes.push(
            "Theme gaps unavailable: no post in this corpus is classified yet. Run the classification step " +
                "(POST /api/ai/classify) to populate the theme dimension.",
        );
    } else if (themedRated < totalRated) {
        // Partial classification is not neutral here. Classification runs
        // newest-first, so a half-finished pass covers the most RECENT posts —
        // which is exactly the subset most likely to differ from the 90-day
        // average, because it is closest to whatever is currently in the news.
        // A theme finding drawn from it is a finding about the last few weeks
        // wearing a 90-day label.
        const pct = Math.round((themedRated / totalRated) * 100);
        notes.push(
            `Theme gaps cover ${themedRated} of ${totalRated} rated posts (${pct}%). Classification runs ` +
                `newest-first, so this subset skews recent — treat theme findings as provisional until ` +
                `classification is complete.`,
        );
    }

    // Every bucket anyone posts in, so a bucket the principal has never touched
    // is still considered — which is the entire point of the module.
    const allBucketKeys = new Map<string, GapKey>();
    for (const account of [principal, ...usablePeers]) {
        for (const [mapKey, bucket] of account.buckets) allBucketKeys.set(mapKey, bucket.key);
    }

    const gaps: Gap[] = [];
    const nearMisses: NearMiss[] = [];

    /** Per-dimension tallies, so a dimension that could test nothing is visible. */
    const coverageBy = new Map<GapDimension, DimensionCoverage>();
    const coverageFor = (dimension: GapDimension): DimensionCoverage => {
        let row = coverageBy.get(dimension);
        if (row === undefined) {
            row = { dimension, bucketsConsidered: 0, bucketsTestable: 0, gaps: 0, nearMisses: 0 };
            coverageBy.set(dimension, row);
        }
        return row;
    };

    for (const [mapKey, key] of allBucketKeys) {
        const coverage = coverageFor(key.dimension);
        coverage.bucketsConsidered += 1;

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

        evidence.sort((a, b) => b.lift - a.lift);

        const clearingPeers = evidence.filter((e) => e.lift >= GAP_LIFT_THRESHOLD);
        const clearing = clearingPeers.length;

        // The median of the peers that actually cleared the bar — see the note on
        // Gap.peerLift for why this is not the median across every peer with a
        // sample. Where nobody cleared, the median across all of them is the
        // honest figure for a near miss: there is no winning subset to describe.
        const peerLift =
            clearing > 0
                ? medianOf(clearingPeers.map((e) => e.lift))
                : evidence.length === 0
                  ? 0
                  : medianOf(evidence.map((e) => e.lift));

        const principalBucket = principal.buckets.get(mapKey);
        const principalN = principalBucket?.rates.length ?? 0;

        const position: PrincipalPosition = {
            n: principalN,
            shareOfOutput: principal.ratedPosts === 0 ? 0 : principalN / principal.ratedPosts,
            bucketMedian: null,
            lift: null,
        };
        if (principalN >= MIN_GAP_N) {
            const bucketMedian = medianOf(principalBucket!.rates);
            position.bucketMedian = bucketMedian;
            if (principal.overallMedian > 0) position.lift = bucketMedian / principal.overallMedian;
        }

        /**
         * Record a rejected candidate, but only where at least one peer cleared
         * the bar on its own — see the NearMiss docblock for why that is the
         * entry rule and not a softer one.
         */
        const recordNearMiss = (reason: NearMissReason, whatWouldChangeIt: string): void => {
            if (clearing === 0) return;
            coverage.nearMisses += 1;
            nearMisses.push({
                key,
                label: labelFor(key),
                reason,
                peerLift,
                peerAgreement: { clearing, of: evidence.length },
                peers: evidence,
                principal: position,
                whatWouldChangeIt,
            });
        };

        if (evidence.length < MIN_PEER_ACCOUNTS) {
            const only = evidence[0];
            recordNearMiss(
                "SINGLE_PEER_ONLY",
                `Only ${evidence.length} peer has ${MIN_GAP_N}+ posts here` +
                    (only ? ` (${only.personName}, n=${only.n}, ${only.lift.toFixed(2)}x)` : "") +
                    `, and one account's strong bucket is that account's habit. A second peer reaching ` +
                    `${MIN_GAP_N} posts here would make this testable.`,
            );
            continue;
        }

        coverage.bucketsTestable += 1;

        // The agreement gate. Each peer must clear the bar on its own — see the
        // note on MIN_PEER_ACCOUNTS for the real finding this rule killed.
        if (clearing < MIN_PEER_ACCOUNTS) {
            const short = evidence.filter((e) => e.lift < GAP_LIFT_THRESHOLD);
            recordNearMiss(
                "NO_PEER_AGREEMENT",
                `${clearing} of ${evidence.length} peers clear ${GAP_LIFT_THRESHOLD}x here, and ` +
                    `${MIN_PEER_ACCOUNTS} are required` +
                    (short[0] ? `. Closest miss: ${short[0].personName} at ${short[0].lift.toFixed(2)}x` : "") +
                    `. One enthusiastic peer is not a pattern.`,
            );
            continue;
        }

        // There was a third gate here — "enough peers clear it individually, but
        // the median across ALL peers with data does not". It was removed with
        // the same change that made `peerLift` the median of the CLEARING peers,
        // because the two are the same test: a median taken over values that each
        // clear the bar cannot itself fall below it, so the gate could never fire.
        //
        // Worth knowing that it was a real gate rather than a hypothetical one. It
        // was what stopped a bucket where one peer sat at 1.5× and three sat near
        // 0.9× — and that bucket is now REPORTED, as a 1.5× gap with "1 of 4"
        // beside it. That is the intended consequence of the peer floor being 1,
        // not an oversight: the agreement count and the evidence rows are what
        // tell the reader how isolated the finding is.

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
            if (principal.overallMedian === 0) continue; // no baseline to measure against

            const principalLift = position.lift!;

            // He is already at least as good here as the peer set is. Not a gap —
            // but worth showing, because "peers win here and so do you" is a
            // different message from silence, and a reader scanning an empty panel
            // cannot tell which buckets were checked and cleared.
            if (principalLift <= 0 || peerLift / principalLift < GAP_LIFT_THRESHOLD) {
                recordNearMiss(
                    "PRINCIPAL_COMPETITIVE",
                    `Peers earn ${peerLift.toFixed(2)}x their own baseline here, but so does the ` +
                        `principal (${principalLift.toFixed(2)}x over ${principalN} posts) — there is no ` +
                        `shortfall to close.`,
                );
                continue;
            }

            kind = "UNDERPERFORMING";
            opportunity = peerLift / principalLift;
        }

        const syntheticPeers = evidence.filter((e) => e.isSynthetic).map((e) => e.personName);

        coverage.gaps += 1;
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

    // Closest to clearing the bar first. PRINCIPAL_COMPETITIVE sorts last within
    // a tie: it is the one reason that is good news rather than a missed test,
    // so it should not head a list a reader scans for things to act on.
    const REASON_TIEBREAK: Record<NearMissReason, number> = {
        NO_PEER_AGREEMENT: 0,
        SINGLE_PEER_ONLY: 2,
        PRINCIPAL_COMPETITIVE: 3,
    };
    nearMisses.sort((a, b) => b.peerLift - a.peerLift || REASON_TIEBREAK[a.reason] - REASON_TIEBREAK[b.reason]);

    const DIMENSION_ORDER: GapDimension[] = ["FORMAT", "HOUR", "DAY", "THEME"];
    const coverage = DIMENSION_ORDER.filter((d) => coverageBy.has(d)).map((d) => coverageBy.get(d)!);

    const belowPeerFloor = peers.length < MIN_PEER_ACCOUNTS;

    return {
        basis,
        gaps: belowPeerFloor ? [] : gaps,
        nearMisses: belowPeerFloor ? [] : nearMisses,
        coverage,
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
 * Collapse adjacent hour gaps into schedulable windows.
 *
 * The run-finding itself lives in `timing.groupContiguousHours` — including the
 * decision not to merge across midnight — because the comparison view needs the
 * same boundary rule and two copies would be two chances to disagree about it.
 */
export function mergeHourWindows(gaps: readonly Gap[]): HourWindow[] {
    const hourGaps = gaps.filter(
        (g): g is Gap & { key: { dimension: "HOUR"; hour: number } } => g.key.dimension === "HOUR",
    );

    return groupContiguousHours(hourGaps, (g) => g.key.hour)
        .map((run) => ({
            startHour: run.startHour,
            endHour: run.endHour,
            label: run.label,
            peerLift: medianOf(run.items.map((g) => g.peerLift)),
            principalAbsent: run.items.every((g) => g.kind === "ABSENT"),
            hours: run.items as Gap[],
        }))
        .sort((a, b) => b.peerLift - a.peerLift);
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

/**
 * One sentence for a bucket that was considered and rejected.
 *
 * Deliberately phrased so it cannot be mistaken for a finding — it leads with
 * what the peers did, names the gate that stopped it, and ends with what would
 * change it. Same reason `describeGap` lives here: the dashboard, the export and
 * the AI prompt must describe a refusal the same way, and the AI layer in
 * particular must never be handed a near miss it could paraphrase into a claim.
 */
export function describeNearMiss(miss: NearMiss, principalName: string): string {
    const peerList = miss.peers
        .map((p) => `${p.personName} (n=${p.n}, ${p.lift.toFixed(2)}x${p.isSynthetic ? ", SEEDED" : ""})`)
        .join(", ");

    const dimension =
        miss.key.dimension === "HOUR"
            ? `the ${miss.label} hour`
            : miss.key.dimension === "DAY"
              ? miss.label
              : miss.key.dimension === "FORMAT"
                ? `the ${miss.label} format`
                : `the ${miss.label} theme`;

    const position =
        miss.principal.n === 0
            ? `${principalName} has no posts there`
            : `${principalName} has ${miss.principal.n} post(s) there`;

    return (
        `NOT REPORTED as a gap — ${dimension}. ${miss.whatWouldChangeIt} ${position}. ` +
        `Peer evidence considered: ${peerList || "none with a large enough sample"}.`
    );
}

/** As `describeGap`, for the "stop" side. */
export function describeOverInvestment(item: OverInvestment, principalName: string): string {
    return (
        `${principalName} spends ${(item.shareOfOutput * 100).toFixed(0)}% of his output on ${item.label} ` +
        `(n=${item.n}), where a typical post earns ${item.lift.toFixed(2)}× his own baseline.`
    );
}
