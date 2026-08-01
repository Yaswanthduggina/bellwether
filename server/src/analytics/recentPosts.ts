// "What have we posted lately?" — the activity list.
//
// Every other post list in this product is RANKED, and ranked on the normalised
// rate rather than raw counts, because a list sorted by likes is a list of the
// account's biggest audiences rather than its best content (see topPosts.ts).
// This one is ordered by RECENCY and is not a ranking at all, which changes two
// rules that hold everywhere else:
//
//   - It shows posts that could not be rated. Everything measuring PERFORMANCE
//     runs on `rated`; this measures ACTIVITY, and a post whose like count the
//     platform withheld still happened. Dropping it would answer "what did we
//     post" with a list that quietly omits some of what was posted — the same
//     distinction corpus.ts draws between `posts` and `rated`.
//   - It applies no sample-size gate. A gate exists to stop a thin sample being
//     read as a pattern, and a list of individual posts makes no claim about a
//     pattern. Ten posts here are ten posts, not evidence about a format.
//
// The rate is still shown per row where it could be computed, with the basis
// that produced it, because the same figure carries different meaning on
// different denominators. Where it could not be computed the row says WHY rather
// than rendering a blank — "the platform hid the metrics" and "this post flopped"
// are opposite findings and must not look alike.
//
// Nothing here feeds the AI layer. This is a route of its own rather than a
// block in the report for exactly that reason: the report is the document the
// recommendation model is grounded against, and captions are deliberately kept
// out of its evidence index (buildReport.ts § OPAQUE_KEYS).

import {
    engagementRate,
    isRate,
    type EngagementAccount,
    type EngagementBasis,
    type EngagementGap,
    type MediaType,
    type Platform,
} from "./engagement";
import type { IdentifiedPost } from "./topPosts";

/** Ten is what a comms manager scans without scrolling. Callers may override. */
export const DEFAULT_RECENT_COUNT = 10;

/** Hard ceiling on `count`, so a hand-edited query string cannot ask for the corpus. */
export const MAX_RECENT_COUNT = 50;

/**
 * Matches `buildReport`'s excerpt length, deliberately.
 *
 * Two different truncations of the same caption in one product is a difference
 * the reader will notice and cannot explain.
 */
const CAPTION_EXCERPT_CHARS = 140;

export interface RecentPostInput extends IdentifiedPost {
    /** Present on a corpus post; optional so the module stays testable without one. */
    theme?: string | null;
}

export interface RecentPost {
    id: string;
    postId: string;
    platform: Platform;
    mediaType: MediaType;
    /** The UTC instant. Rendering it in the account's zone is the UI's job. */
    postedAt: Date;
    captionExcerpt: string | null;
    permalink: string | null;
    isSynthetic: boolean;
    theme: string | null;
    /** Raw counts, exactly as the platform reported them. Null means absent, not zero. */
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
    saves: number | null;
    /** The post's own engagement rate as a percentage, or null if it has none. */
    ratePct: number | null;
    /** Which denominator `ratePct` used. Null exactly when `ratePct` is null. */
    basis: EngagementBasis | null;
    /** Why there is no rate. Null exactly when there is one. */
    unratedReason: EngagementGap | null;
}

/**
 * The most recent `count` posts, newest first.
 *
 * Sorted here rather than trusting the caller: `loadCorpora` happens to order by
 * `postedAt desc` in SQL today, and a list whose correctness depends on an ORDER
 * BY in another file is one refactor away from being silently wrong. Ties break
 * on `postId` so the output is stable — two posts can share a timestamp, and a
 * list that reorders itself between identical requests looks like a bug.
 */
export function recentPosts<T extends RecentPostInput>(
    posts: readonly T[],
    account: EngagementAccount,
    count: number = DEFAULT_RECENT_COUNT,
): RecentPost[] {
    const ordered = [...posts].sort(
        (a, b) => b.postedAt.getTime() - a.postedAt.getTime() || a.postId.localeCompare(b.postId),
    );

    return ordered.slice(0, Math.max(0, count)).map((post) => {
        const result = engagementRate(post, account);
        const rated = isRate(result);

        return {
            id: post.id,
            postId: post.postId,
            platform: post.platform,
            mediaType: post.mediaType,
            postedAt: post.postedAt,
            captionExcerpt: post.caption === null ? null : post.caption.slice(0, CAPTION_EXCERPT_CHARS),
            permalink: post.permalink,
            isSynthetic: post.isSynthetic,
            theme: post.theme ?? null,
            likes: post.likes,
            comments: post.comments,
            shares: post.shares,
            views: post.views,
            saves: post.saves,
            // × 100 here rather than in the UI, matching every other percentage
            // the API emits. Two places formatting the same quantity is two
            // places to disagree about the factor of 100.
            ratePct: rated ? result.rate * 100 : null,
            basis: rated ? result.basis : null,
            unratedReason: rated ? null : result.gap,
        };
    });
}

/** Clamp a caller-supplied `count` into something a route can serve. */
export function clampRecentCount(raw: unknown): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_RECENT_COUNT;
    return Math.min(MAX_RECENT_COUNT, Math.max(1, Math.floor(parsed)));
}
