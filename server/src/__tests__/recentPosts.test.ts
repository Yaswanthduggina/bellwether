// The activity list is the one place in this product where an UNRATED post must
// survive, so most of what is worth asserting here is about the posts that every
// other module deliberately drops.

import { describe, expect, it } from "vitest";
import {
    clampRecentCount,
    DEFAULT_RECENT_COUNT,
    MAX_RECENT_COUNT,
    recentPosts,
    type RecentPostInput,
} from "../analytics/recentPosts";

const ACCOUNT = { followerCount: 1_000_000 };

/** `postedAt` is taken as an ISO string here and parsed once, at the bottom. */
function post(
    overrides: Partial<Omit<RecentPostInput, "postedAt">> & { postId: string; postedAt: string },
): RecentPostInput {
    return {
        id: `db-${overrides.postId}`,
        platform: "INSTAGRAM",
        mediaType: "CAROUSEL",
        caption: null,
        permalink: `https://example.test/${overrides.postId}`,
        isSynthetic: false,
        likes: 1000,
        comments: 100,
        shares: 10,
        views: null,
        saves: null,
        ...overrides,
        postedAt: new Date(overrides.postedAt),
    };
}

describe("recentPosts — ordering", () => {
    it("returns newest first regardless of the order it was handed", () => {
        const result = recentPosts(
            [
                post({ postId: "old", postedAt: "2026-06-01T10:00:00Z" }),
                post({ postId: "new", postedAt: "2026-07-01T10:00:00Z" }),
                post({ postId: "mid", postedAt: "2026-06-15T10:00:00Z" }),
            ],
            ACCOUNT,
        );

        expect(result.map((p) => p.postId)).toEqual(["new", "mid", "old"]);
    });

    it("does not depend on the caller's ORDER BY", () => {
        // `loadCorpora` sorts postedAt desc in SQL today. A list whose
        // correctness rests on a query in another file is one refactor from
        // being quietly wrong, so the module sorts defensively — this asserts it
        // actually does, by handing it the worst possible order.
        const ascending = [
            post({ postId: "a", postedAt: "2026-01-01T00:00:00Z" }),
            post({ postId: "b", postedAt: "2026-02-01T00:00:00Z" }),
            post({ postId: "c", postedAt: "2026-03-01T00:00:00Z" }),
        ];

        expect(recentPosts(ascending, ACCOUNT).map((p) => p.postId)).toEqual(["c", "b", "a"]);
    });

    it("breaks ties deterministically so identical requests agree", () => {
        // Two posts can share a timestamp. Without a tiebreak the list would
        // reorder itself between two identical requests, which reads as a bug.
        const sameInstant = [
            post({ postId: "zulu", postedAt: "2026-06-01T10:00:00Z" }),
            post({ postId: "alpha", postedAt: "2026-06-01T10:00:00Z" }),
        ];

        expect(recentPosts(sameInstant, ACCOUNT).map((p) => p.postId)).toEqual(["alpha", "zulu"]);
        expect(recentPosts([...sameInstant].reverse(), ACCOUNT).map((p) => p.postId)).toEqual(["alpha", "zulu"]);
    });

    it("takes the newest `count`, not the first `count`", () => {
        const posts = Array.from({ length: 20 }, (_, i) =>
            post({ postId: `p${String(i).padStart(2, "0")}`, postedAt: `2026-06-${String(i + 1).padStart(2, "0")}T10:00:00Z` }),
        );

        const result = recentPosts(posts, ACCOUNT, 3);
        expect(result.map((p) => p.postId)).toEqual(["p19", "p18", "p17"]);
    });

    it("returns everything it has when the corpus is shorter than `count`", () => {
        expect(recentPosts([post({ postId: "only", postedAt: "2026-06-01T10:00:00Z" })], ACCOUNT, 10)).toHaveLength(1);
    });
});

describe("recentPosts — unrated posts survive", () => {
    it("keeps a post whose metrics the platform withheld, with the reason", () => {
        // THE POINT OF THE MODULE. Every performance path drops this row; the
        // activity list must not, because the post still happened. Dropping it
        // would answer "what did we post" with a list missing some of what was
        // posted.
        const result = recentPosts(
            [
                post({ postId: "hidden", postedAt: "2026-06-02T10:00:00Z", likes: null, comments: null, shares: null }),
                post({ postId: "normal", postedAt: "2026-06-01T10:00:00Z" }),
            ],
            ACCOUNT,
        );

        expect(result.map((p) => p.postId)).toEqual(["hidden", "normal"]);
        expect(result[0].ratePct).toBeNull();
        expect(result[0].unratedReason).toBe("NO_METRICS");
    });

    it("distinguishes a missing numerator from a missing denominator", () => {
        const noDenominator = recentPosts(
            [post({ postId: "x", postedAt: "2026-06-01T10:00:00Z" })],
            { followerCount: null },
        );

        expect(noDenominator[0].unratedReason).toBe("NO_DENOMINATOR");
        expect(noDenominator[0].ratePct).toBeNull();
    });

    it("never reports both a rate and a reason, or neither", () => {
        // The UI branches on exactly this: a rate cell shows a figure or an
        // explanation, and there is no third state to render.
        const mixed = recentPosts(
            [
                post({ postId: "rated", postedAt: "2026-06-03T10:00:00Z" }),
                post({ postId: "nometrics", postedAt: "2026-06-02T10:00:00Z", likes: null, comments: null, shares: null }),
            ],
            ACCOUNT,
        );

        for (const row of mixed) {
            expect(row.ratePct === null).toBe(row.unratedReason !== null);
            expect(row.ratePct === null).toBe(row.basis === null);
        }
    });
});

describe("recentPosts — the figures on a row", () => {
    it("reports the rate as a percentage, with the basis that produced it", () => {
        // 1000 likes ×1 + 100 comments ×3 + 10 shares ×5 = 1350 interactions.
        // Over 1,000,000 followers that is 0.135%.
        const [row] = recentPosts([post({ postId: "p", postedAt: "2026-06-01T10:00:00Z" })], ACCOUNT);

        expect(row.ratePct).toBeCloseTo(0.135, 10);
        expect(row.basis).toBe("FOLLOWERS");
    });

    it("rates a view-bearing format on views even when followers are available", () => {
        // The same account, the same hour: a reel normalises on views and the
        // carousel does not. Both belong in this list, which is why the row
        // carries its own basis rather than the panel carrying one.
        const rows = recentPosts(
            [
                post({ postId: "reel", postedAt: "2026-06-01T11:00:00Z", mediaType: "REEL_SHORT_VIDEO", views: 100_000 }),
                post({ postId: "carousel", postedAt: "2026-06-01T10:00:00Z" }),
            ],
            ACCOUNT,
        );

        expect(rows[0].basis).toBe("VIEWS");
        expect(rows[0].ratePct).toBeCloseTo(1.35, 10);
        expect(rows[1].basis).toBe("FOLLOWERS");
    });

    it("passes raw counts through untouched, keeping absent distinct from zero", () => {
        const [row] = recentPosts(
            [post({ postId: "p", postedAt: "2026-06-01T10:00:00Z", likes: 0, shares: null })],
            ACCOUNT,
        );

        expect(row.likes).toBe(0);
        expect(row.shares).toBeNull();
    });

    it("truncates the caption to the same length the report uses", () => {
        const long = "क".repeat(400);
        const [row] = recentPosts([post({ postId: "p", postedAt: "2026-06-01T10:00:00Z", caption: long })], ACCOUNT);

        expect(row.captionExcerpt).toHaveLength(140);
    });

    it("carries the permalink and the seeded flag so a row can be opened or badged", () => {
        const [row] = recentPosts(
            [post({ postId: "p", postedAt: "2026-06-01T10:00:00Z", isSynthetic: true, permalink: null })],
            ACCOUNT,
        );

        expect(row.permalink).toBeNull();
        expect(row.isSynthetic).toBe(true);
    });
});

describe("clampRecentCount", () => {
    it("falls back to the default for anything unparseable", () => {
        expect(clampRecentCount(undefined)).toBe(DEFAULT_RECENT_COUNT);
        expect(clampRecentCount("abc")).toBe(DEFAULT_RECENT_COUNT);
    });

    it("refuses to serve the whole corpus through a hand-edited query string", () => {
        expect(clampRecentCount("100000")).toBe(MAX_RECENT_COUNT);
        expect(clampRecentCount("0")).toBe(1);
        expect(clampRecentCount("-5")).toBe(1);
    });

    it("accepts a sensible number", () => {
        expect(clampRecentCount("25")).toBe(25);
        expect(clampRecentCount("10.7")).toBe(10);
    });
});
