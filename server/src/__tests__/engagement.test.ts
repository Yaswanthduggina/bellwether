// The engagement rate is the one number every other number in this product is
// derived from. If the weighting is wrong, every format comparison is wrong; if
// the denominator is wrong, every cross-account comparison is wrong; and if the
// basis guard leaks, the dashboard shows an average of two incommensurable
// quantities that nobody will notice is meaningless.
//
// So this suite is deliberately paranoid about three things: absent-vs-zero,
// which denominator was chosen, and the refusal to mix bases.
//
// NOTE ON WEIGHTS: the arithmetic assertions derive their expected values from
// INTERACTION_WEIGHTS rather than hard-coding the products. That is intentional
// and is the claim the README makes — the tests pin the arithmetic, not the
// judgement call. Exactly one test ("the documented ladder") asserts the weight
// VALUES, so changing them fails one clearly-named test telling you to update
// the documentation, instead of failing twenty that look like real breakage.

import { describe, expect, it } from "vitest";
import {
    assertSingleBasis,
    chooseDenominator,
    engagementRate,
    EngagementPost,
    INTERACTION_WEIGHTS,
    isRate,
    MixedBasisError,
    partitionByBasis,
    rateAll,
    weightedInteractions,
    type EngagementRate,
} from "../analytics/engagement";

function post(overrides: Partial<EngagementPost> = {}): EngagementPost {
    return {
        platform: "INSTAGRAM",
        mediaType: "SINGLE_IMAGE",
        likes: 100,
        comments: 10,
        shares: 5,
        views: null,
        saves: 2,
        ...overrides,
    };
}

const W = INTERACTION_WEIGHTS;

// ── Numerator ────────────────────────────────────────────────────────────

describe("weightedInteractions", () => {
    it("weights each action by its own coefficient", () => {
        const expected = 100 * W.likes + 10 * W.comments + 5 * W.shares + 2 * W.saves;
        expect(weightedInteractions(post())).toBe(expected);
    });

    it("is not a raw sum — a share counts for more than a like", () => {
        // The whole reason the weighting exists. One share must outweigh one like,
        // or the formula is a plain total wearing a costume.
        const oneShare = post({ likes: null, comments: null, shares: 1, saves: null });
        const oneLike = post({ likes: 1, comments: null, shares: null, saves: null });

        expect(weightedInteractions(oneShare)!).toBeGreaterThan(weightedInteractions(oneLike)!);
    });

    it("returns null when the platform reported no interaction metrics at all", () => {
        // "We do not know how this performed" must stay distinguishable from
        // "nobody engaged". Returning 0 here would drag every average toward zero
        // and make a data-availability problem look like a content problem.
        expect(weightedInteractions(post({ likes: null, comments: null, shares: null, saves: null }))).toBeNull();
    });

    it("sums only the metrics present, leaving absent ones absent", () => {
        const partial = post({ likes: 50, comments: null, shares: null, saves: null });
        expect(weightedInteractions(partial)).toBe(50 * W.likes);
    });

    it("treats an explicit zero as a real measurement, not as absent", () => {
        // A post that genuinely earned zero likes is a data point. It must not be
        // confused with a post whose like count was never reported.
        const zeroed = post({ likes: 0, comments: 0, shares: 0, saves: 0 });
        expect(weightedInteractions(zeroed)).toBe(0);
        expect(weightedInteractions(zeroed)).not.toBeNull();
    });

    it("the documented ladder: shares > saves > comments > likes", () => {
        // The ONLY test that asserts the weight values themselves. If it fails,
        // the weights were changed on purpose — update README.md §engagement and
        // DECISIONS.md §2.1 to match, then update this test.
        expect(W.likes).toBe(1);
        expect(W.comments).toBe(3);
        expect(W.saves).toBe(4);
        expect(W.shares).toBe(5);
        expect(W.shares).toBeGreaterThan(W.saves);
        expect(W.saves).toBeGreaterThan(W.comments);
        expect(W.comments).toBeGreaterThan(W.likes);
    });
});

// ── Denominator ──────────────────────────────────────────────────────────

describe("chooseDenominator — views-first, where views are real", () => {
    const account = { followerCount: 1_000_000 };

    it("uses views on YouTube", () => {
        const result = chooseDenominator(post({ platform: "YOUTUBE", mediaType: "LONG_FORM_VIDEO", views: 50_000 }), account);
        expect(result).toEqual({ denominator: 50_000, basis: "VIEWS" });
    });

    it("uses views on X, where impressions are public", () => {
        const result = chooseDenominator(post({ platform: "X", mediaType: "TEXT_ONLY", views: 20_000 }), account);
        expect(result).toEqual({ denominator: 20_000, basis: "VIEWS" });
    });

    it("uses views for an Instagram reel, which reports plays", () => {
        const result = chooseDenominator(post({ platform: "INSTAGRAM", mediaType: "REEL_SHORT_VIDEO", views: 30_000 }), account);
        expect(result).toEqual({ denominator: 30_000, basis: "VIEWS" });
    });

    it("uses followers for an Instagram carousel even if a view count is present", () => {
        // A carousel's "views" are not a comparable realised-audience count, so
        // the format gate matters as much as the platform gate.
        const result = chooseDenominator(post({ platform: "INSTAGRAM", mediaType: "CAROUSEL", views: 30_000 }), account);
        expect(result).toEqual({ denominator: 1_000_000, basis: "FOLLOWERS" });
    });

    it("falls back to followers when views are absent", () => {
        const result = chooseDenominator(post({ platform: "INSTAGRAM", mediaType: "REEL_SHORT_VIDEO", views: null }), account);
        expect(result).toEqual({ denominator: 1_000_000, basis: "FOLLOWERS" });
    });
});

describe("chooseDenominator — the division-by-zero cases", () => {
    it("refuses a zero view count and falls back to followers", () => {
        // Dividing by zero yields Infinity, and a post credited with infinite
        // engagement would top every ranking in the product.
        const result = chooseDenominator(
            post({ platform: "YOUTUBE", mediaType: "LONG_FORM_VIDEO", views: 0 }),
            { followerCount: 500_000 },
        );
        expect(result).toEqual({ denominator: 500_000, basis: "FOLLOWERS" });
    });

    it("returns null when neither views nor followers give a usable denominator", () => {
        expect(chooseDenominator(post({ views: null }), { followerCount: null })).toBeNull();
        expect(chooseDenominator(post({ views: 0 }), { followerCount: 0 })).toBeNull();
    });
});

// ── The rate ─────────────────────────────────────────────────────────────

describe("engagementRate", () => {
    it("computes interactions ÷ denominator against a hand-checked fixture", () => {
        // 100 likes, 10 comments, 5 shares, 2 saves over 10,000 views.
        // Under the documented weights: 100 + 30 + 25 + 8 = 163 → 163/10000 = 0.0163
        const result = engagementRate(
            post({ platform: "YOUTUBE", mediaType: "LONG_FORM_VIDEO", views: 10_000 }),
            { followerCount: 1_000_000 },
        );

        expect(isRate(result)).toBe(true);
        const rate = result as EngagementRate;

        const expectedInteractions = 100 * W.likes + 10 * W.comments + 5 * W.shares + 2 * W.saves;
        expect(rate.interactions).toBe(expectedInteractions);
        expect(rate.denominator).toBe(10_000);
        expect(rate.basis).toBe("VIEWS");
        expect(rate.rate).toBeCloseTo(expectedInteractions / 10_000, 12);
    });

    it("returns a proportion, not a percentage", () => {
        // Formatting is the UI's job. If this returned 1.63 instead of 0.0163,
        // every downstream comparison would carry a factor of 100 that some code
        // paths applied and others did not.
        const result = engagementRate(
            post({ platform: "YOUTUBE", mediaType: "LONG_FORM_VIDEO", views: 10_000 }),
            { followerCount: 1_000_000 },
        );
        expect((result as EngagementRate).rate).toBeLessThan(1);
    });

    it("reports NO_METRICS rather than a zero rate when nothing was measured", () => {
        const result = engagementRate(
            post({ likes: null, comments: null, shares: null, saves: null }),
            { followerCount: 1_000_000 },
        );
        expect(isRate(result)).toBe(false);
        expect(result).toEqual({ gap: "NO_METRICS" });
    });

    it("reports NO_DENOMINATOR when there is nothing to normalise against", () => {
        const result = engagementRate(post({ views: null }), { followerCount: null });
        expect(result).toEqual({ gap: "NO_DENOMINATOR" });
    });

    it("never produces Infinity or NaN across the awkward inputs", () => {
        const awkward: Array<[EngagementPost, { followerCount: number | null }]> = [
            [post({ views: 0 }), { followerCount: 0 }],
            [post({ platform: "YOUTUBE", views: 0 }), { followerCount: 10 }],
            [post({ likes: 0, comments: 0, shares: 0, saves: 0 }), { followerCount: 10 }],
            [post({ likes: null, comments: null, shares: null, saves: null }), { followerCount: null }],
        ];

        for (const [p, account] of awkward) {
            const result = engagementRate(p, account);
            if (isRate(result)) {
                expect(Number.isFinite(result.rate)).toBe(true);
            }
        }
    });
});

// ── Batch rating ─────────────────────────────────────────────────────────

describe("rateAll", () => {
    it("keeps the original post attached so callers can group without a second lookup", () => {
        const posts = [post({ mediaType: "REEL_SHORT_VIDEO", views: 1000, platform: "INSTAGRAM" })];
        const { rated } = rateAll(posts, { followerCount: 100_000 });

        expect(rated).toHaveLength(1);
        expect(rated[0].post.mediaType).toBe("REEL_SHORT_VIDEO");
    });

    it("counts unratable posts by reason instead of dropping them silently", () => {
        // "We could rate 2 of 4 posts" is something a reader of the dashboard is
        // entitled to know — an unstated denominator is the quiet version of a
        // made-up number.
        const posts = [
            post({ views: null }),
            post({ views: null }),
            post({ likes: null, comments: null, shares: null, saves: null }),
            post({ likes: null, comments: null, shares: null, saves: null }),
        ];

        const { rated, gaps } = rateAll(posts, { followerCount: 100_000 });

        expect(rated).toHaveLength(2);
        expect(gaps.NO_METRICS).toBe(2);
        expect(gaps.NO_DENOMINATOR).toBe(0);
    });
});

// ── The mixing guard — the load-bearing one ──────────────────────────────

function rateWithBasis(basis: "VIEWS" | "FOLLOWERS"): EngagementRate {
    return { interactions: 100, denominator: 1000, basis, rate: 0.1 };
}

describe("assertSingleBasis", () => {
    it("returns the shared basis when every rate agrees", () => {
        const rates = [rateWithBasis("VIEWS"), rateWithBasis("VIEWS")];
        expect(assertSingleBasis(rates, "format stats")).toBe("VIEWS");
    });

    it("THROWS when asked to aggregate across bases", () => {
        // The single most important assertion in this file. A views-normalised
        // rate and a followers-normalised rate differ by roughly an order of
        // magnitude; averaging them yields a number that looks precise and means
        // nothing, and unlike a crash, nobody notices it.
        const mixed = [rateWithBasis("VIEWS"), rateWithBasis("FOLLOWERS")];

        expect(() => assertSingleBasis(mixed, "format stats")).toThrow(MixedBasisError);
    });

    it("names the context and both bases in the error, so the call site is findable", () => {
        const mixed = [rateWithBasis("FOLLOWERS"), rateWithBasis("VIEWS")];

        expect(() => assertSingleBasis(mixed, "compare: Tharoor vs peers")).toThrow(/compare: Tharoor vs peers/);
        expect(() => assertSingleBasis(mixed, "compare: Tharoor vs peers")).toThrow(/FOLLOWERS/);
        expect(() => assertSingleBasis(mixed, "compare: Tharoor vs peers")).toThrow(/VIEWS/);
    });

    it("returns null for an empty set rather than inventing a basis", () => {
        expect(assertSingleBasis([], "format stats")).toBeNull();
    });
});

describe("partitionByBasis", () => {
    it("splits a mixed corpus into the two panels the UI renders", () => {
        // This is the sanctioned alternative to mixing, and why assertSingleBasis
        // can afford to throw: the correct fix at a call site is one line.
        const rated = [
            { post: post(), engagement: rateWithBasis("VIEWS") },
            { post: post(), engagement: rateWithBasis("FOLLOWERS") },
            { post: post(), engagement: rateWithBasis("VIEWS") },
        ];

        const split = partitionByBasis(rated);

        expect(split.VIEWS).toHaveLength(2);
        expect(split.FOLLOWERS).toHaveLength(1);
        expect(() => assertSingleBasis(split.VIEWS.map((r) => r.engagement), "panel")).not.toThrow();
        expect(() => assertSingleBasis(split.FOLLOWERS.map((r) => r.engagement), "panel")).not.toThrow();
    });
});
