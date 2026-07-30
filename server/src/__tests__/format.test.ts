// Format analysis, in two halves.
//
// The first half checks the rules on hand-built fixtures: the n<5 gate, the
// median-based ranking, the outlier headline, the basis guard.
//
// The second half is the one worth reading. It runs the actual seed adapter,
// puts its output through the actual rating and aggregation code, and asserts
// that the engine RECOVERED THE PATTERN THAT WAS DELIBERATELY PLANTED. That is
// a far stronger claim than "it produced a number" — it is the difference
// between a tested pipeline and a pipeline that has been run once.

import { describe, expect, it } from "vitest";
import { createSeedAdapter, FORMAT_QUALITY } from "../adapters/seedAdapter";
import {
    analyseFormats,
    analyseFormatsByBasis,
    formatSpread,
    MIN_FORMAT_N,
    type FormatAnalysis,
} from "../analytics/format";
import {
    MixedBasisError,
    partitionByBasis,
    rateAll,
    type EngagementBasis,
    type EngagementPost,
    type MediaType,
    type RatedPost,
} from "../analytics/engagement";

/** A rated post with a chosen rate, so the aggregation can be checked directly. */
function rated(mediaType: MediaType, rate: number, basis: EngagementBasis = "VIEWS"): RatedPost<EngagementPost> {
    return {
        post: {
            platform: "INSTAGRAM",
            mediaType,
            likes: null,
            comments: null,
            shares: null,
            views: null,
            saves: null,
        },
        engagement: { interactions: rate * 1000, denominator: 1000, basis, rate },
    };
}

function many(mediaType: MediaType, rates: number[], basis: EngagementBasis = "VIEWS") {
    return rates.map((r) => rated(mediaType, r, basis));
}

// ── The rules ────────────────────────────────────────────────────────────

describe("analyseFormats — the sample-size gate", () => {
    it("excludes a format with fewer than MIN_FORMAT_N posts from the statistics", () => {
        const input = [
            ...many("REEL_SHORT_VIDEO", [0.05, 0.06, 0.04, 0.05, 0.06]), // 5 — reportable
            ...many("LINK", [0.9, 0.9, 0.9, 0.9]), // 4 — must not be reported despite huge rates
        ];

        const analysis = analyseFormats(input)!;

        expect(analysis.formats.map((f) => f.mediaType)).toEqual(["REEL_SHORT_VIDEO"]);
        expect(analysis.insufficient).toEqual([{ mediaType: "LINK", n: 4 }]);
    });

    it("reports the disqualifying count rather than hiding the format entirely", () => {
        // "LINK: 4 posts, insufficient" is useful; silently omitting LINK would
        // let a reader assume the account never posts links.
        const analysis = analyseFormats(many("LINK", [0.9, 0.9, 0.9, 0.9]).concat(many("TEXT_ONLY", [0.1, 0.1, 0.1, 0.1, 0.1])))!;
        expect(analysis.insufficient).toContainEqual({ mediaType: "LINK", n: 4 });
    });

    it("gates at exactly MIN_FORMAT_N — five qualifies, four does not", () => {
        const five = analyseFormats(many("CAROUSEL", Array(MIN_FORMAT_N).fill(0.05)))!;
        expect(five.formats).toHaveLength(1);

        const four = analyseFormats(many("CAROUSEL", Array(MIN_FORMAT_N - 1).fill(0.05)))!;
        expect(four.formats).toHaveLength(0);
    });
});

describe("analyseFormats — ranking and headline", () => {
    it("ranks by median, so one freak post cannot promote a format", () => {
        // STEADY: median 0.05, but no outlier.
        // SPIKY:  median 0.01 with a single 1.0 — its MEAN (0.208) beats STEADY's,
        //         and ranking on the mean would put it first. It must not be first.
        const input = [
            ...many("CAROUSEL", [0.05, 0.05, 0.05, 0.05, 0.05]),
            ...many("SINGLE_IMAGE", [0.01, 0.01, 0.01, 0.01, 1.0]),
        ];

        const analysis = analyseFormats(input)!;

        expect(analysis.formats[0].mediaType).toBe("CAROUSEL");
        expect(analysis.formats[1].mediaType).toBe("SINGLE_IMAGE");
        // Confirm the trap was real — the mean genuinely would have inverted this.
        expect(analysis.formats[1].distribution.mean).toBeGreaterThan(analysis.formats[0].distribution.mean);
    });

    it("leads with the median when the distribution is outlier-driven", () => {
        const analysis = analyseFormats(many("SINGLE_IMAGE", [0.01, 0.01, 0.01, 0.01, 1.0]))!;
        const stat = analysis.formats[0];

        expect(stat.distribution.outlierDriven).toBe(true);
        expect(stat.headlineStat).toBe("MEDIAN");
        expect(stat.headline).toBe(stat.distribution.median);
    });

    it("leads with the mean when the distribution is well behaved", () => {
        const analysis = analyseFormats(many("CAROUSEL", [0.05, 0.05, 0.05, 0.05, 0.05]))!;
        const stat = analysis.formats[0];

        expect(stat.distribution.outlierDriven).toBe(false);
        expect(stat.headlineStat).toBe("MEAN");
        expect(stat.headline).toBe(stat.distribution.mean);
    });

    it("expresses each format as a multiple of the overall baseline", () => {
        // Overall set: five at 0.10 and five at 0.02 → overall median 0.06.
        // The 0.10 format is therefore 0.10 / 0.06 ≈ 1.667× the baseline.
        const input = [...many("REEL_SHORT_VIDEO", Array(5).fill(0.1)), ...many("LINK", Array(5).fill(0.02))];
        const analysis = analyseFormats(input)!;

        expect(analysis.overall.median).toBeCloseTo(0.06, 12);
        const reel = analysis.formats.find((f) => f.mediaType === "REEL_SHORT_VIDEO")!;
        expect(reel.multipleOfOverall).toBeCloseTo(0.1 / 0.06, 12);
    });
});

describe("analyseFormats — the basis guard", () => {
    it("throws rather than averaging a VIEWS rate with a FOLLOWERS rate", () => {
        const mixed = [...many("REEL_SHORT_VIDEO", Array(5).fill(0.05), "VIEWS"), ...many("LINK", Array(5).fill(0.002), "FOLLOWERS")];

        expect(() => analyseFormats(mixed, "formats: mixed corpus")).toThrow(MixedBasisError);
    });

    it("names the context so the offending call site is findable", () => {
        const mixed = [...many("REEL_SHORT_VIDEO", Array(5).fill(0.05), "VIEWS"), ...many("LINK", Array(5).fill(0.002), "FOLLOWERS")];
        expect(() => analyseFormats(mixed, "formats: Tharoor / all platforms")).toThrow(/Tharoor \/ all platforms/);
    });

    it("analyseFormatsByBasis splits the same corpus into two valid panels", () => {
        const mixed = [...many("REEL_SHORT_VIDEO", Array(5).fill(0.05), "VIEWS"), ...many("LINK", Array(5).fill(0.002), "FOLLOWERS")];

        const panels = analyseFormatsByBasis(mixed);

        expect(panels.VIEWS!.basis).toBe("VIEWS");
        expect(panels.VIEWS!.formats[0].mediaType).toBe("REEL_SHORT_VIDEO");
        expect(panels.FOLLOWERS!.basis).toBe("FOLLOWERS");
        expect(panels.FOLLOWERS!.formats[0].mediaType).toBe("LINK");
    });

    it("returns null for a basis no post used, instead of an empty-looking panel", () => {
        const viewsOnly = many("REEL_SHORT_VIDEO", Array(5).fill(0.05), "VIEWS");
        expect(analyseFormatsByBasis(viewsOnly).FOLLOWERS).toBeNull();
    });
});

describe("analyseFormats — empty and degenerate input", () => {
    it("returns null for no posts rather than a zero-filled analysis", () => {
        expect(analyseFormats([])).toBeNull();
    });

    it("formatSpread returns null when fewer than two formats qualify", () => {
        const analysis = analyseFormats(many("REEL_SHORT_VIDEO", Array(5).fill(0.05)))!;
        // Only one format qualified — "no gap" and "nothing to compare" are
        // different statements, and returning 1 would conflate them.
        expect(formatSpread(analysis)).toBeNull();
    });
});

// ── The round trip: does the engine find what was planted? ───────────────

describe("round trip — the engine recovers the planted format pattern", () => {
    // X is the cleanest platform to assert against: it reports impressions on
    // every post, so every X post rates on the VIEWS basis and formats are
    // directly comparable. On Instagram and Facebook only video formats carry
    // views, which legitimately splits the corpus across two bases — tested
    // separately below.
    //
    // Note the seed generator divides interactions into likes/comments/shares/
    // saves by fixed proportions, and the analytics layer then re-weights them.
    // Within one platform that is a constant factor, so it cancels out of every
    // RATIO below. The assertions are therefore about ordering and multiples,
    // never absolute rate values — which is also the only honest thing to assert
    // about a stochastic generator.

    const HANDLES = ["ShashiTharoor", "priyankac19", "varungandhi", "kanhaiyakumar"];

    async function ratedXPostsFor(handle: string): Promise<RatedPost<EngagementPost>[]> {
        const adapter = createSeedAdapter("X");
        const since = new Date(Date.now() - 90 * 86_400_000);

        const meta = await adapter.fetchAccountMeta(handle);
        const raw = await adapter.fetchPosts(handle, since);

        const posts: EngagementPost[] = raw.map((p) => ({
            platform: p.platform,
            mediaType: p.mediaType,
            likes: p.metrics.likes,
            comments: p.metrics.comments,
            shares: p.metrics.shares,
            views: p.metrics.views,
            saves: p.metrics.saves,
        }));

        return rateAll(posts, { followerCount: meta.followerCount }).rated;
    }

    async function xAnalysisFor(handle: string): Promise<FormatAnalysis> {
        return analyseFormats(await ratedXPostsFor(handle), `round trip: X / ${handle}`)!;
    }

    it("rates every X post on the VIEWS basis, since X reports impressions on all of them", async () => {
        const analysis = await xAnalysisFor("ShashiTharoor");
        expect(analysis.basis).toBe("VIEWS");
        expect(analysis.ratedPosts).toBeGreaterThan(50);
    });

    it("ranks REEL_SHORT_VIDEO first for a reel-heavy account — planted at FORMAT_QUALITY 1.9", async () => {
        // kanhaiyakumar's X mix is reel-dominated, so every format clears n>=5.
        const analysis = await xAnalysisFor("kanhaiyakumar");

        expect(FORMAT_QUALITY.REEL_SHORT_VIDEO).toBe(Math.max(...Object.values(FORMAT_QUALITY)));
        expect(analysis.formats[0].mediaType).toBe("REEL_SHORT_VIDEO");
    });

    it("ranks LINK last for the principal — the format platforms suppress, planted at 0.55", async () => {
        const analysis = await xAnalysisFor("ShashiTharoor");
        const ranked = analysis.formats.map((f) => f.mediaType);

        // LINK must have cleared the n>=5 gate for this assertion to mean anything.
        expect(ranked).toContain("LINK");
        expect(ranked[ranked.length - 1]).toBe("LINK");
    });

    it("recovers the reel-over-link multiple within the account that posts both", async () => {
        // Planted ratio is 1.9 / 0.55 = 3.45 for format alone. The generator layers
        // log-normal noise on top, so this asserts a band rather than a point —
        // wide enough not to be flaky, tight enough that a pipeline which lost the
        // signal (landing near 1.0) fails.
        const analysis = await xAnalysisFor("ShashiTharoor");
        const spread = formatSpread(analysis)!;

        expect(spread.worst.mediaType).toBe("LINK");
        expect(spread.multiple).toBeGreaterThan(1.5);
        expect(spread.multiple).toBeLessThan(8);
    });

    it("POOLING FORMATS ACROSS ACCOUNTS CONFOUNDS FORMAT WITH POSTING HABIT", async () => {
        // Found by this suite, and worth stating loudly because it is a real
        // analytical failure mode rather than a quirk of the fixture.
        //
        // In the seeded world — as in the real one — the accounts that post reels
        // are also the accounts that post in the evening peak on the themes that
        // travel. Pool all four accounts' X posts together and "reels" inherits
        // those accounts' hour and theme advantages, inflating the format effect
        // well past the 3.45 that was actually planted.
        //
        // The product therefore reports format analysis PER ACCOUNT. This test
        // exists so that if someone later pools it for convenience, the reason not
        // to is written down where they will find it.
        const perAccount = await ratedXPostsFor("ShashiTharoor");
        const pooled = (await Promise.all(HANDLES.map(ratedXPostsFor))).flat();

        const reelMedian = (set: RatedPost<EngagementPost>[]) => {
            const rates = set.filter((r) => r.post.mediaType === "REEL_SHORT_VIDEO").map((r) => r.engagement.rate);
            return analyseFormats(set)!.formats.find((f) => f.mediaType === "REEL_SHORT_VIDEO")?.distribution.median
                ?? rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)];
        };

        // The pooled "reel" figure is inflated by WHO posts reels, not by the format.
        expect(reelMedian(pooled)).toBeGreaterThan(reelMedian(perAccount));
    });

    it("finds the Instagram corpus genuinely split across both bases", async () => {
        // Instagram reports plays on reels but not on carousels, so the same
        // account's posts land on different denominators. This is the real-world
        // case the mixing guard exists for, and it is present in the demo data —
        // not a hypothetical.
        const adapter = createSeedAdapter("INSTAGRAM");
        const since = new Date(Date.now() - 90 * 86_400_000);
        const meta = await adapter.fetchAccountMeta("ShashiTharoor");
        const raw = await adapter.fetchPosts("ShashiTharoor", since);

        const posts: EngagementPost[] = raw.map((p) => ({
            platform: p.platform,
            mediaType: p.mediaType,
            likes: p.metrics.likes,
            comments: p.metrics.comments,
            shares: p.metrics.shares,
            views: p.metrics.views,
            saves: p.metrics.saves,
        }));

        const { rated: allRated } = rateAll(posts, { followerCount: meta.followerCount });
        const split = partitionByBasis(allRated);

        expect(split.VIEWS.length).toBeGreaterThan(0);
        expect(split.FOLLOWERS.length).toBeGreaterThan(0);

        // Aggregating the whole thing must throw; splitting it must not.
        expect(() => analyseFormats(allRated, "round trip: Instagram")).toThrow(MixedBasisError);
        expect(() => analyseFormatsByBasis(allRated, "round trip: Instagram")).not.toThrow();
    });
});
