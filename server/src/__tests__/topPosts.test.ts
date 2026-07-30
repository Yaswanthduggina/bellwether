// The one thing this suite has to prove: the ranking is on the normalised rate
// and never on raw counts. Sorting by likes is the easiest way to make an
// analytics product look busy while saying nothing — it returns the account's
// widest-reaching posts, which is mostly a fact about reach, not about content.

import { describe, expect, it } from "vitest";
import { MixedBasisError, type EngagementBasis, type MediaType, type RatedPost } from "../analytics/engagement";
import { topPosts, topPostsByBasis, topPostsByFormat, type IdentifiedPost } from "../analytics/topPosts";

let counter = 0;

function ratedPost(
    overrides: Partial<IdentifiedPost> & { rate: number; basis?: EngagementBasis; denominator?: number },
): RatedPost<IdentifiedPost> {
    const { rate, basis = "VIEWS", denominator = 10_000, ...post } = overrides;
    counter += 1;

    return {
        post: {
            id: post.id ?? `db_${counter}`,
            postId: post.postId ?? `p_${counter}`,
            platform: post.platform ?? "INSTAGRAM",
            mediaType: post.mediaType ?? "REEL_SHORT_VIDEO",
            postedAt: post.postedAt ?? new Date("2026-06-15T14:30:00Z"),
            caption: post.caption ?? "a caption",
            permalink: post.permalink === undefined ? "https://example.com/p" : post.permalink,
            isSynthetic: post.isSynthetic ?? false,
            likes: post.likes ?? null,
            comments: post.comments ?? null,
            shares: post.shares ?? null,
            views: post.views ?? null,
            saves: post.saves ?? null,
        },
        engagement: { interactions: rate * denominator, denominator, basis, rate },
    };
}

describe("topPosts — ranks on rate, never on raw counts", () => {
    it("puts a small post with a high rate above a huge post with a low rate", () => {
        // THE assertion. The blockbuster earned 100,000 interactions against
        // 10,000,000 views (1%). The sleeper earned 500 against 5,000 (10%).
        // Sorting by likes inverts this; sorting by rate does not.
        const blockbuster = ratedPost({ postId: "blockbuster", rate: 0.01, denominator: 10_000_000, likes: 100_000 });
        const sleeper = ratedPost({ postId: "sleeper", rate: 0.1, denominator: 5_000, likes: 500 });

        const result = topPosts([blockbuster, sleeper], 2)!;

        expect(result.best[0].postId).toBe("sleeper");
        expect(result.best[1].postId).toBe("blockbuster");
        // And the trap was genuinely there — raw likes really would have flipped it.
        expect(blockbuster.post.likes!).toBeGreaterThan(sleeper.post.likes!);
    });

    it("orders worst-first, so the bottom of the list reads top-down", () => {
        const posts = [0.09, 0.05, 0.01, 0.02].map((rate, i) => ratedPost({ postId: `p${i}`, rate }));
        const result = topPosts(posts, 2)!;

        expect(result.worst.map((p) => p.engagement.rate)).toEqual([0.01, 0.02]);
    });

    it("carries the permalink through, so a finding can be opened", () => {
        const result = topPosts([ratedPost({ rate: 0.05, permalink: "https://youtube.com/watch?v=abc" })], 1)!;
        expect(result.best[0].permalink).toBe("https://youtube.com/watch?v=abc");
    });

    it("expresses each post as a multiple of the corpus median", () => {
        // Rates 0.02, 0.04, 0.06 → median 0.04. The top post is 1.5× the median.
        const posts = [0.02, 0.04, 0.06].map((rate) => ratedPost({ rate }));
        const result = topPosts(posts, 1)!;

        expect(result.overall.median).toBeCloseTo(0.04, 12);
        expect(result.best[0].multipleOfMedian).toBeCloseTo(1.5, 12);
    });

    it("flags a ranking that contains synthetic posts", () => {
        // A seeded top post has no permalink, which otherwise looks identical to
        // a real post whose link was missing. The panel gets badged instead.
        const result = topPosts([ratedPost({ rate: 0.05, isSynthetic: true, permalink: null })], 1)!;

        expect(result.containsSynthetic).toBe(true);
        expect(result.best[0].permalink).toBeNull();
        expect(result.best[0].isSynthetic).toBe(true);
    });

    it("reports the corpus size, so 'top 5' can be read against what it was drawn from", () => {
        const result = topPosts([0.01, 0.02, 0.03].map((rate) => ratedPost({ rate })), 5)!;

        // best and worst deliberately overlap on a thin corpus rather than
        // silently returning fewer rows and implying a richer one.
        expect(result.n).toBe(3);
        expect(result.best).toHaveLength(3);
        expect(result.worst).toHaveLength(3);
    });

    it("returns null for an empty corpus", () => {
        expect(topPosts([], 5)).toBeNull();
    });
});

describe("topPosts — basis handling", () => {
    it("throws rather than ranking a views rate against a followers rate", () => {
        const mixed = [ratedPost({ rate: 0.05, basis: "VIEWS" }), ratedPost({ rate: 0.002, basis: "FOLLOWERS" })];
        expect(() => topPosts(mixed, 5, "top posts: mixed")).toThrow(MixedBasisError);
    });

    it("topPostsByBasis produces one ranking per basis", () => {
        const mixed = [
            ratedPost({ postId: "v1", rate: 0.05, basis: "VIEWS" }),
            ratedPost({ postId: "f1", rate: 0.002, basis: "FOLLOWERS" }),
        ];

        const result = topPostsByBasis(mixed, 5);

        expect(result.VIEWS!.best[0].postId).toBe("v1");
        expect(result.FOLLOWERS!.best[0].postId).toBe("f1");
    });
});

describe("topPostsByFormat", () => {
    it("answers 'what does a good reel look like' separately per format", () => {
        const posts: RatedPost<IdentifiedPost>[] = [
            ratedPost({ postId: "reel_good", mediaType: "REEL_SHORT_VIDEO", rate: 0.09 }),
            ratedPost({ postId: "reel_bad", mediaType: "REEL_SHORT_VIDEO", rate: 0.01 }),
            ratedPost({ postId: "link_good", mediaType: "LINK", rate: 0.004 }),
        ];

        const byFormat = topPostsByFormat(posts, 1);

        expect(byFormat.get("REEL_SHORT_VIDEO")!.best[0].postId).toBe("reel_good");
        expect(byFormat.get("LINK")!.best[0].postId).toBe("link_good");
    });

    it("does not sample-gate the examples the way format statistics are gated", () => {
        // A single post is a legitimate illustration; it is only a STATISTIC that
        // needs five. format.ts enforces the statistical gate; this does not.
        const byFormat = topPostsByFormat([ratedPost({ mediaType: "LIVE" as MediaType, rate: 0.05 })], 3);
        expect(byFormat.get("LIVE")!.best).toHaveLength(1);
    });
});
