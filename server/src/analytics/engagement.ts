// THE formula. Every comparison in this product goes through this file.
//
// Nothing here touches Prisma or the network — it is arithmetic over plain
// objects, so it can be tested exhaustively without a database. The database
// query lives in the modules that consume it.
//
// Three rules this module exists to enforce:
//
//   1. Interactions are WEIGHTED, because a share and a like are not the same
//      signal (§ INTERACTION_WEIGHTS).
//   2. The denominator is per-platform, and every rate carries the flag saying
//      which denominator it used (§ EngagementBasis).
//   3. Rates computed on different bases are DIFFERENT QUANTITIES and may never
//      be aggregated together (§ assertSingleBasis). This one throws.
//
// Absent is not zero. A post with no share count is not a post with no shares,
// and quietly reading `null` as `0` would understate every rate it touches.
// That distinction is preserved end to end, which is why several functions here
// return `null` rather than a convenient number.

// ── Types ────────────────────────────────────────────────────────────────

export type Platform = "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";

export type MediaType =
    | "REEL_SHORT_VIDEO"
    | "LONG_FORM_VIDEO"
    | "CAROUSEL"
    | "SINGLE_IMAGE"
    | "TEXT_ONLY"
    | "LINK"
    | "LIVE";

/**
 * Which denominator a rate was computed against.
 *
 * This is not decoration. A views-normalised rate and a follower-normalised
 * rate typically differ by an order of magnitude, so the flag is what makes it
 * possible to refuse to mix them instead of producing a plausible average of
 * two incommensurable things.
 */
export type EngagementBasis = "VIEWS" | "FOLLOWERS";

/** The subset of a Post this module needs. Structural, so tests need no database. */
export interface EngagementPost {
    platform: Platform;
    mediaType: MediaType;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
    saves: number | null;
}

/** The subset of an Account this module needs. */
export interface EngagementAccount {
    followerCount: number | null;
}

export interface EngagementRate {
    /** Weighted interactions — the numerator. */
    interactions: number;
    /** What the interactions were divided by. Always > 0. */
    denominator: number;
    basis: EngagementBasis;
    /** interactions / denominator. A proportion, not a percentage — 0.032, not 3.2. */
    rate: number;
}

/**
 * Why a post has no computable rate. Returned rather than thrown: an
 * uncomputable post is a normal event (a platform hid a metric), not an error,
 * and the callers report the count instead of dying on it.
 */
export type EngagementGap = "NO_METRICS" | "NO_DENOMINATOR";

// ── The numerator ────────────────────────────────────────────────────────

/**
 * The effort-and-reach ladder. A like costs a thumb-tap; a share costs the user
 * reputation with their own audience AND distributes the message to people who
 * do not follow the principal — which is the outcome a communications team
 * actually wants, so it carries the most weight.
 *
 * These weights are a documented judgement call, NOT an empirically fitted
 * model — fitting them would need an outcome variable we do not have (reach
 * lift per action type, or downstream follower conversion). They are exported
 * and live in exactly one place so a team that disagrees can change them in one
 * edit. The tests pin the ARITHMETIC, not the weights, so changing them here
 * does not silently break the suite. See DECISIONS.md §2.1.
 */
export const INTERACTION_WEIGHTS = {
    likes: 1,
    comments: 3,
    saves: 4,
    shares: 5,
} as const;

type InteractionField = keyof typeof INTERACTION_WEIGHTS;

const INTERACTION_FIELDS = Object.keys(INTERACTION_WEIGHTS) as InteractionField[];

/**
 * Weighted interaction count, or null if the platform reported none of the four.
 *
 * The null case matters. Every metric absent means "we do not know how this post
 * performed", which is categorically different from "nobody engaged with it".
 * Returning 0 there would drag every average that touched it toward zero and
 * make a data-availability problem look like a content problem.
 *
 * Where SOME metrics are present, the present ones are summed and the absent
 * ones stay absent. That understates the true figure, but it understates it
 * consistently across every post on the platform — and the alternative is
 * inventing values.
 */
export function weightedInteractions(post: EngagementPost): number | null {
    let total = 0;
    let sawAny = false;

    for (const field of INTERACTION_FIELDS) {
        const value = post[field];
        if (value === null || value === undefined) continue;
        sawAny = true;
        total += value * INTERACTION_WEIGHTS[field];
    }

    return sawAny ? total : null;
}

// ── The denominator ──────────────────────────────────────────────────────

/**
 * Platforms whose public metrics include a realised-audience count for every
 * post, regardless of format: YouTube reports views on all videos, and X
 * exposes impressions on posts.
 *
 * MEMBERSHIP IS A CLAIM ABOUT THE SOURCE, NOT ABOUT THE PLATFORM, and X is the
 * entry that proves the difference matters. This set listed X before any X
 * adapter existed, on the strength of the impression count X shows on its own
 * web UI. Building the adapter turned that into a testable question, and the
 * first scraper tried (xtdata) returned no impression field at all — an X corpus
 * read through it would have fallen silently through to the followers basis
 * without erroring, re-basing a whole platform mid-product. The actor this
 * project settled on does return `viewCount` on every tweet, so the entry stands.
 *
 * The rule this leaves behind: an adapter swap that loses a view count is a
 * change to THIS set, and the pipeline will not tell you — see the denominator
 * note in adapters/xAdapter.ts.
 */
const VIEW_NATIVE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["YOUTUBE", "X"]);

/**
 * Formats that carry a view count wherever they appear — an Instagram Reel
 * reports plays even though a carousel on the same account does not.
 */
const VIEW_BEARING_FORMATS: ReadonlySet<MediaType> = new Set<MediaType>([
    "REEL_SHORT_VIDEO",
    "LONG_FORM_VIDEO",
    "LIVE",
]);

/**
 * Views normalise better than followers: followers are a POTENTIAL audience,
 * views are a realised one. "Of the people who actually saw this, how many
 * acted" is what format and timing analysis is genuinely asking — normalising
 * by followers instead conflates a content-quality question with an
 * audience-size question.
 *
 * Views are used only where the platform or format genuinely reports them. A
 * view count of 0 is treated as unusable rather than as a zero denominator:
 * dividing by it yields Infinity, and a post credited with infinite engagement
 * would top every ranking in the product.
 */
export function chooseDenominator(
    post: EngagementPost,
    account: EngagementAccount,
): { denominator: number; basis: EngagementBasis } | null {
    const viewsQualify = VIEW_NATIVE_PLATFORMS.has(post.platform) || VIEW_BEARING_FORMATS.has(post.mediaType);

    if (viewsQualify && post.views !== null && post.views > 0) {
        return { denominator: post.views, basis: "VIEWS" };
    }

    // Falls through to followers when views are absent or zero. The basis flag
    // records which one was actually used, so the mixing guard downstream sees
    // the truth rather than the intent.
    if (account.followerCount !== null && account.followerCount > 0) {
        return { denominator: account.followerCount, basis: "FOLLOWERS" };
    }

    return null;
}

// ── The rate ─────────────────────────────────────────────────────────────

/**
 * Engagement rate for one post, or a reason it could not be computed.
 *
 * Returns a proportion (0.032), never a percentage (3.2). Formatting is the
 * UI's job; doing it here would mean every downstream comparison silently
 * carrying a factor of 100 that some code paths applied and others did not.
 */
export function engagementRate(
    post: EngagementPost,
    account: EngagementAccount,
): EngagementRate | { gap: EngagementGap } {
    const interactions = weightedInteractions(post);
    if (interactions === null) return { gap: "NO_METRICS" };

    const denominator = chooseDenominator(post, account);
    if (denominator === null) return { gap: "NO_DENOMINATOR" };

    return {
        interactions,
        denominator: denominator.denominator,
        basis: denominator.basis,
        rate: interactions / denominator.denominator,
    };
}

/** Narrowing helper — `engagementRate` returns a union and every caller needs this. */
export function isRate(result: EngagementRate | { gap: EngagementGap }): result is EngagementRate {
    return (result as EngagementRate).rate !== undefined;
}

export interface RatedPost<T> {
    post: T;
    engagement: EngagementRate;
}

export interface RateBatchResult<T> {
    rated: RatedPost<T>[];
    /** Posts that could not be rated, by reason. Reported, never silently dropped. */
    gaps: Record<EngagementGap, number>;
}

/**
 * Rate a batch, keeping the original objects attached so callers can group by
 * mediaType, hour or account without a second lookup.
 *
 * The gap counts are part of the return value rather than a log line because
 * "we could rate 40 of 90 posts" is something a reader of the dashboard is
 * entitled to know. A statistic computed over an unstated fraction of the
 * corpus is the quiet version of a made-up number.
 */
export function rateAll<T extends EngagementPost>(
    posts: T[],
    account: EngagementAccount,
): RateBatchResult<T> {
    const rated: RatedPost<T>[] = [];
    const gaps: Record<EngagementGap, number> = { NO_METRICS: 0, NO_DENOMINATOR: 0 };

    for (const post of posts) {
        const result = engagementRate(post, account);
        if (isRate(result)) {
            rated.push({ post, engagement: result });
        } else {
            gaps[result.gap] += 1;
        }
    }

    return { rated, gaps };
}

// ── The mixing guard ─────────────────────────────────────────────────────

/**
 * Thrown when code tries to combine rates computed against different
 * denominators.
 *
 * Deliberately loud. A views-based rate and a followers-based rate differ by
 * roughly an order of magnitude, so their average is a number that looks
 * precise and means nothing — and unlike a crash, nobody notices it. Better a
 * developer hits this in a test than a comms manager acts on the result.
 *
 * The fix at a call site is never to suppress this. It is to split the
 * comparison into one panel per basis, which is what the UI does.
 */
export class MixedBasisError extends Error {
    constructor(
        readonly context: string,
        readonly bases: EngagementBasis[],
    ) {
        super(
            `${context}: cannot aggregate across engagement bases [${bases.join(", ")}]. ` +
                `A VIEWS-normalised rate and a FOLLOWERS-normalised rate are different quantities; ` +
                `split the comparison by basis instead of averaging them.`,
        );
        this.name = "MixedBasisError";
    }
}

/**
 * Assert that every rate in a set shares one basis, and return it.
 *
 * Every aggregation in the analytics layer calls this before it computes
 * anything. An empty set has no basis to conflict with, so it returns null and
 * lets the caller handle "no data" as its own case.
 */
export function assertSingleBasis(rates: readonly EngagementRate[], context: string): EngagementBasis | null {
    if (rates.length === 0) return null;

    const bases = new Set<EngagementBasis>();
    for (const rate of rates) bases.add(rate.basis);

    if (bases.size > 1) {
        throw new MixedBasisError(context, [...bases].sort());
    }

    return [...bases][0];
}

/**
 * Split a rated batch by basis.
 *
 * This is the sanctioned way to handle a mixed corpus, and it is why
 * `assertSingleBasis` can afford to throw: the caller has a correct alternative
 * that takes one line. A YouTube-and-Instagram comparison legitimately spans
 * both bases — it becomes two panels, not one blended average.
 */
export function partitionByBasis<T>(rated: readonly RatedPost<T>[]): Record<EngagementBasis, RatedPost<T>[]> {
    const out: Record<EngagementBasis, RatedPost<T>[]> = { VIEWS: [], FOLLOWERS: [] };
    for (const item of rated) out[item.engagement.basis].push(item);
    return out;
}
