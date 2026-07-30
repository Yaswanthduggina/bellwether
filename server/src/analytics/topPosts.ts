// Best and worst performers, with a link back to the post.
//
// The rule this module exists to enforce: NOTHING IS RANKED ON RAW COUNTS.
// Sorting by likes produces a list of the account's biggest posts, which is
// mostly a list of the days it had the most followers or the widest reach — and
// it is the single easiest way to make an analytics product look busy while
// saying nothing. Ranking is on the normalised rate, always.
//
// The permalink is part of the output rather than an afterthought. A "top post"
// a comms manager cannot open is a number, not a finding, and the traceability
// requirement runs from the recommendation all the way back to the post.

import {
    assertSingleBasis,
    partitionByBasis,
    type EngagementBasis,
    type EngagementRate,
    type MediaType,
    type RatedPost,
} from "./engagement";
import { describe as describeDistribution, type Distribution } from "./stats";
import type { TimingPost } from "./timing";

/** The identifying fields a post needs to be citable in the UI or by the AI layer. */
export interface IdentifiedPost extends TimingPost {
    /** Database id — what a recommendation's evidence chip resolves against. */
    id: string;
    /** The platform's own id, for the audit trail. */
    postId: string;
    permalink: string | null;
    caption: string | null;
    /** Carried through so a SEEDED badge can be rendered on the row itself. */
    isSynthetic: boolean;
}

export interface RankedPost {
    id: string;
    postId: string;
    platform: IdentifiedPost["platform"];
    mediaType: MediaType;
    postedAt: Date;
    caption: string | null;
    /** Null for synthetic posts — there is nothing real to link to. */
    permalink: string | null;
    isSynthetic: boolean;
    engagement: EngagementRate;
    /** Rate as a multiple of the corpus median. The "3.1×" in a recommendation. */
    multipleOfMedian: number;
}

export interface TopPostsResult {
    basis: EngagementBasis;
    best: RankedPost[];
    worst: RankedPost[];
    /** The corpus these were drawn from. `best` means "best of this many". */
    n: number;
    overall: Distribution;
    /**
     * True when any post in this ranking is synthetic. The UI badges the panel,
     * because a "top post" with no permalink is otherwise indistinguishable from
     * a real one whose link happened to be missing.
     */
    containsSynthetic: boolean;
}

function rank(item: RatedPost<IdentifiedPost>, median: number): RankedPost {
    const { post, engagement } = item;
    return {
        id: post.id,
        postId: post.postId,
        platform: post.platform,
        mediaType: post.mediaType,
        postedAt: post.postedAt,
        caption: post.caption,
        permalink: post.permalink,
        isSynthetic: post.isSynthetic,
        engagement,
        multipleOfMedian: median === 0 ? 0 : engagement.rate / median,
    };
}

/**
 * Best and worst `count` posts by engagement rate.
 *
 * `best` and `worst` are allowed to overlap when the corpus is smaller than
 * 2×count, and deliberately so: silently returning fewer rows would misrepresent
 * a thin corpus as a rich one. The caller can compare `n` against `count`.
 */
export function topPosts(
    rated: readonly RatedPost<IdentifiedPost>[],
    count = 5,
    context = "top posts",
): TopPostsResult | null {
    const basis = assertSingleBasis(
        rated.map((r) => r.engagement),
        context,
    );
    if (basis === null) return null;

    const overall = describeDistribution(rated.map((r) => r.engagement.rate));
    if (overall === null) return null;

    const sorted = [...rated].sort((a, b) => b.engagement.rate - a.engagement.rate);

    const best = sorted.slice(0, count).map((item) => rank(item, overall.median));
    const worst = sorted
        .slice(-count)
        .reverse() // worst-first reads better than a truncated ascending tail
        .map((item) => rank(item, overall.median));

    return {
        basis,
        best,
        worst,
        n: rated.length,
        overall,
        containsSynthetic: [...best, ...worst].some((p) => p.isSynthetic),
    };
}

/**
 * Top posts per media format.
 *
 * Answers "what does a good reel look like for this account", which is the
 * question that follows immediately after the format statistics say reels win —
 * and the one the format numbers alone cannot answer.
 *
 * Formats are NOT sample-gated here the way they are in format.ts. A single
 * example post is a legitimate illustration; it is only a statistic that needs
 * five. The caller decides whether to show the accompanying figure.
 */
export function topPostsByFormat(
    rated: readonly RatedPost<IdentifiedPost>[],
    count = 3,
    context = "top posts by format",
): Map<MediaType, TopPostsResult> {
    const byFormat = new Map<MediaType, RatedPost<IdentifiedPost>[]>();
    for (const item of rated) {
        const bucket = byFormat.get(item.post.mediaType);
        if (bucket) bucket.push(item);
        else byFormat.set(item.post.mediaType, [item]);
    }

    const out = new Map<MediaType, TopPostsResult>();
    for (const [mediaType, items] of byFormat) {
        const result = topPosts(items, count, `${context} [${mediaType}]`);
        if (result) out.set(mediaType, result);
    }
    return out;
}

/** Top posts split by basis, for a corpus that legitimately spans both. */
export function topPostsByBasis(
    rated: readonly RatedPost<IdentifiedPost>[],
    count = 5,
    context = "top posts",
): Record<EngagementBasis, TopPostsResult | null> {
    const split = partitionByBasis(rated);
    return {
        VIEWS: topPosts(split.VIEWS, count, `${context} [VIEWS]`),
        FOLLOWERS: topPosts(split.FOLLOWERS, count, `${context} [FOLLOWERS]`),
    };
}
