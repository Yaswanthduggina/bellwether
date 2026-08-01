// Timing is where a plausible-looking bug does the most damage: an off-by-one
// in the timezone conversion moves every post one column, the heatmap still
// renders beautifully, and the recommendation says 8pm when it means 7pm.
//
// So the conversion is tested directly — including against a DST-observing zone,
// which is the only way to prove it is a real conversion rather than a hardcoded
// +5:30 that happens to be right for India.

import { describe, expect, it } from "vitest";
import { DAY_QUALITY, HOUR_QUALITY, plantedCorpus } from "./fixtures/plantedCorpus";
import { MixedBasisError, rateAll, type EngagementBasis, type RatedPost } from "../analytics/engagement";
import {
    analyseTiming,
    analyseTimingByBasis,
    bestHours,
    localSlot,
    LOW_CONFIDENCE_N,
    MIN_CELL_N,
    MIN_MARGINAL_N,
    type TimingPost,
} from "../analytics/timing";

const IST = "Asia/Kolkata";

function ratedAt(iso: string, rate: number, basis: EngagementBasis = "VIEWS"): RatedPost<TimingPost> {
    return {
        post: {
            platform: "INSTAGRAM",
            mediaType: "REEL_SHORT_VIDEO",
            postedAt: new Date(iso),
            likes: null,
            comments: null,
            shares: null,
            views: null,
            saves: null,
        },
        engagement: { interactions: rate * 1000, denominator: 1000, basis, rate },
    };
}

/** n posts in the same slot, so a cell can be pushed over or under a threshold. */
function nPostsAt(iso: string, count: number, rate = 0.05): RatedPost<TimingPost>[] {
    return Array.from({ length: count }, () => ratedAt(iso, rate));
}

// ── The conversion ───────────────────────────────────────────────────────

describe("localSlot — UTC to account-local", () => {
    it("moves a post across midnight AND across the day boundary", () => {
        // 18:30 UTC on Sunday is 00:00 IST on Monday. A naive implementation that
        // read the UTC weekday would file this under Sunday evening — wrong day,
        // wrong hour, and the heatmap would look entirely reasonable.
        expect(localSlot(new Date("2026-06-14T18:30:00Z"), IST)).toEqual({ dayOfWeek: 1, hour: 0 });
    });

    it("renders midnight as hour 0, never as hour 24", () => {
        // Some hour cycles emit "24" for midnight, which would silently create a
        // 25th column that no day×hour grid has a place for.
        const slot = localSlot(new Date("2026-06-14T18:30:00Z"), IST);
        expect(slot.hour).toBe(0);
        expect(slot.hour).toBeLessThan(24);
    });

    it("keeps a mid-morning post on the same local day", () => {
        // 00:30 UTC Sunday → 06:00 IST Sunday.
        expect(localSlot(new Date("2026-06-14T00:30:00Z"), IST)).toEqual({ dayOfWeek: 0, hour: 6 });
    });

    it("applies real DST rules, not a fixed offset", () => {
        // The assertion that proves this is a genuine conversion. Same UTC hour,
        // six months apart, in a zone that observes DST: 12:00Z is 07:00 in
        // January (EST, −5) and 08:00 in July (EDT, −4). A hardcoded offset —
        // which is what a four-day build is tempted to write — cannot produce
        // both. India has no DST, so nothing in the demo data would have caught it.
        expect(localSlot(new Date("2026-01-15T12:00:00Z"), "America/New_York").hour).toBe(7);
        expect(localSlot(new Date("2026-07-15T12:00:00Z"), "America/New_York").hour).toBe(8);
    });

    it("rejects an unknown timezone with an actionable message", () => {
        expect(() => localSlot(new Date(), "Mars/Olympus_Mons")).toThrow(/IANA zone/);
    });
});

// ── Suppression ──────────────────────────────────────────────────────────

describe("analyseTiming — sample-size suppression", () => {
    it("suppresses a cell below MIN_CELL_N entirely", () => {
        // One post in a slot is not a pattern, however good that post was.
        const input = [
            ...nPostsAt("2026-06-15T14:30:00Z", 1, 0.9), // Mon 20:00 IST — huge rate, n=1
            ...nPostsAt("2026-06-16T14:30:00Z", 5, 0.05), // Tue 20:00 IST — modest, n=5
        ];

        const analysis = analyseTiming(input, IST)!;
        const slots = analysis.grid.map((c) => `${c.dayOfWeek}:${c.hour}`);

        expect(slots).toEqual(["2:20"]);
        expect(analysis.suppressedCells).toBe(1);
        expect(analysis.suppressedPosts).toBe(1);
    });

    it("locates the cells it suppressed, so the UI can tell thin from never-used", () => {
        // A grid carrying only its survivors cannot distinguish "you post here
        // rarely" from "you have never posted here" — opposite findings that
        // render identically. These coordinates are what separates them.
        const input = [
            ...nPostsAt("2026-06-15T14:30:00Z", 5), // Mon 20:00 — drawn
            ...nPostsAt("2026-06-16T03:30:00Z", 1), // Tue 09:00 — suppressed
            ...nPostsAt("2026-06-17T05:30:00Z", 1), // Wed 11:00 — suppressed
        ];

        const analysis = analyseTiming(input, IST)!;

        // Day then hour ascending, regardless of the order the corpus arrived in.
        expect(analysis.suppressedSlots).toEqual([
            { dayOfWeek: 2, hour: 9, n: 1 },
            { dayOfWeek: 3, hour: 11, n: 1 },
        ]);
        expect(analysis.suppressedSlots).toHaveLength(analysis.suppressedCells);
        // No distribution rides along — publishing one invites exactly the reading
        // the suppression exists to prevent.
        expect(Object.keys(analysis.suppressedSlots[0])).toEqual(["dayOfWeek", "hour", "n"]);
    });

    it("reports the floors it computed under, so the UI never hardcodes them", () => {
        const analysis = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", 5), IST)!;
        expect(analysis.minCellN).toBe(MIN_CELL_N);
        expect(analysis.minMarginalN).toBe(MIN_MARGINAL_N);
    });

    it("includes a cell at exactly MIN_CELL_N but flags it LOW confidence", () => {
        const analysis = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", MIN_CELL_N), IST)!;

        expect(analysis.grid).toHaveLength(1);
        expect(analysis.grid[0].n).toBe(MIN_CELL_N);
        expect(analysis.grid[0].confidence).toBe("LOW");
    });

    it("clears the flag at LOW_CONFIDENCE_N", () => {
        const analysis = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", LOW_CONFIDENCE_N), IST)!;
        expect(analysis.grid[0].confidence).toBe("OK");
    });

    it("accounts for every rated post — visible cells plus suppressed ones", () => {
        // The arithmetic that makes `suppressedPosts` trustworthy. If posts could
        // vanish between the input and the grid, every cell's n would be suspect.
        const input = [
            ...nPostsAt("2026-06-15T14:30:00Z", 6),
            ...nPostsAt("2026-06-16T03:30:00Z", 2),
            ...nPostsAt("2026-06-17T05:30:00Z", 1),
        ];

        const analysis = analyseTiming(input, IST)!;
        const visible = analysis.grid.reduce((sum, cell) => sum + cell.n, 0);

        expect(visible + analysis.suppressedPosts).toBe(analysis.ratedPosts);
        expect(analysis.ratedPosts).toBe(9);
    });

    it("reports how much of the grid it is not showing", () => {
        // A heatmap with two visible cells is telling the reader something real
        // about their posting spread. Omitting the rest silently hides it.
        const input = [...nPostsAt("2026-06-15T14:30:00Z", 5), ...nPostsAt("2026-06-16T03:30:00Z", 1), ...nPostsAt("2026-06-17T04:30:00Z", 1)];
        const analysis = analyseTiming(input, IST)!;

        expect(analysis.suppressedCells).toBe(2);
        expect(analysis.suppressedPosts).toBe(2);
    });
});

describe("analyseTiming — the marginals", () => {
    it("collapses day to give the hour-of-day view a usable sample", () => {
        // Three posts at 20:00 IST on three different days: no grid cell reaches
        // MIN_CELL_N, but the hour bucket does. This is why the marginals exist —
        // a 7×24 grid over ninety days is mostly empty by arithmetic.
        const input = [
            ratedAt("2026-06-15T14:30:00Z", 0.05), // Mon 20:00
            ratedAt("2026-06-16T14:30:00Z", 0.06), // Tue 20:00
            ratedAt("2026-06-17T14:30:00Z", 0.04), // Wed 20:00
        ];

        const analysis = analyseTiming(input, IST)!;

        expect(analysis.grid).toHaveLength(0);
        expect(analysis.byHour).toHaveLength(1);
        expect(analysis.byHour[0].hour).toBe(20);
        expect(analysis.byHour[0].n).toBe(3);
    });

    it("holds the marginals to a HIGHER floor than the grid", () => {
        // The load-bearing consequence of splitting the two constants, and the
        // regression this test exists to catch: the grid's floor was lowered to
        // fill in a sparse heatmap, and it must not have dragged the marginals
        // down with it. Two posts is enough to DRAW a cell and not enough to CITE
        // an hour, because only the second of those becomes a recommendation.
        expect(MIN_CELL_N).toBeLessThan(MIN_MARGINAL_N);

        const analysis = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", 2), IST)!;

        expect(analysis.grid).toHaveLength(1);
        expect(analysis.grid[0].n).toBe(2);
        expect(analysis.byHour).toHaveLength(0);
        expect(analysis.byDay).toHaveLength(0);
    });

    it("still drops a marginal one post under its own floor", () => {
        const analysis = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", MIN_MARGINAL_N - 1), IST)!;
        expect(analysis.byHour).toHaveLength(0);

        const atFloor = analyseTiming(nPostsAt("2026-06-15T14:30:00Z", MIN_MARGINAL_N), IST)!;
        expect(atFloor.byHour).toHaveLength(1);
        expect(atFloor.byHour[0].n).toBe(MIN_MARGINAL_N);
    });

    it("bestHours excludes LOW-confidence buckets from what recommendations may cite", () => {
        // The grid and the marginals still expose thin buckets for display. This
        // function feeds the AI layer, and a recommendation is the one place a
        // thin sample does real damage.
        const input = [
            ...nPostsAt("2026-06-15T14:30:00Z", 3, 0.9), // 20:00 IST, n=3, spectacular, LOW
            ...nPostsAt("2026-06-15T09:30:00Z", 6, 0.05), // 15:00 IST, n=6, modest, OK
        ];

        const analysis = analyseTiming(input, IST)!;

        expect(analysis.byHour.map((h) => h.hour)).toEqual([20, 15]); // 20:00 ranks first
        expect(bestHours(analysis).map((h) => h.hour)).toEqual([15]); // but is not quotable
    });
});

describe("analyseTiming — the basis guard and empty input", () => {
    it("throws rather than mixing bases across a heatmap", () => {
        const mixed = [...nPostsAt("2026-06-15T14:30:00Z", 3), ratedAt("2026-06-15T14:30:00Z", 0.002, "FOLLOWERS")];
        expect(() => analyseTiming(mixed, IST, "timing: mixed")).toThrow(MixedBasisError);
    });

    it("analyseTimingByBasis splits it into two valid heatmaps", () => {
        const mixed = [...nPostsAt("2026-06-15T14:30:00Z", 3), ...Array.from({ length: 3 }, () => ratedAt("2026-06-15T14:30:00Z", 0.002, "FOLLOWERS"))];
        const panels = analyseTimingByBasis(mixed, IST);

        expect(panels.VIEWS!.grid).toHaveLength(1);
        expect(panels.FOLLOWERS!.grid).toHaveLength(1);
    });

    it("returns null for no rated posts rather than an empty grid that looks like a finding", () => {
        expect(analyseTiming([], IST)).toBeNull();
    });

    it("records the timezone the result is expressed in", () => {
        // Every hour in the output is meaningless without it, and it must travel
        // with the data rather than being re-derived by the UI.
        expect(analyseTiming(nPostsAt("2026-06-15T14:30:00Z", 3), IST)!.timezone).toBe(IST);
    });
});

// ── Round trip: does the engine find the planted clock? ──────────────────

describe("round trip — the engine recovers the planted timing pattern", () => {
    function ratedXPostsFor(handle: string): RatedPost<TimingPost>[] {
        const { followerCount, posts } = plantedCorpus("X", handle);
        return rateAll(posts, { followerCount }).rated;
    }

    it("finds the evening peak for an account that posts both evening and midday", () => {
        // priyankac19 posts at 18–21 and at 13. The fixture plants HOUR_QUALITY
        // 1.85 at 20:00 against 1.15 at 13:00, so the engine should rank the
        // evening hours above the midday one. Tested within a single account, so
        // the account's own themes and formats cannot explain the difference.
        expect(HOUR_QUALITY[20]).toBeGreaterThan(HOUR_QUALITY[13]);

        const analysis = analyseTiming(ratedXPostsFor("priyankac19"), IST, "round trip")!;
        const hours = analysis.byHour.map((h) => h.hour);

        expect(hours.length).toBeGreaterThan(1);
        expect(hours[0]).toBeGreaterThanOrEqual(18); // best hour is an evening one
        expect(hours.indexOf(13)).toBeGreaterThan(0); // 13:00 is not the best hour
    });

    it("converts to IST such that the recovered hours are the ones the fixture planted", () => {
        // The fixture places posts at specific LOCAL hours. If the conversion in
        // timing.ts disagreed with the one in the fixture by even an hour, the
        // recovered set would not be a subset of the planted set — this is the
        // end-to-end check on the timezone handling.
        const PLANTED_HOURS = new Set([18, 19, 20, 21, 13]); // priyankac19's postingHours

        const analysis = analyseTiming(ratedXPostsFor("priyankac19"), IST, "round trip")!;

        for (const bucket of analysis.byHour) {
            expect(PLANTED_HOURS.has(bucket.hour)).toBe(true);
        }
    });

    it("finds the midweek lift when day-of-week is pooled across accounts", () => {
        // Pooling is legitimate HERE and not for formats: posting day is drawn
        // uniformly at random by the fixture, so it is uncorrelated with which
        // account posted — unlike format choice, which is an account habit. See
        // the confound test in format.test.ts.
        const pooled = ["ShashiTharoor", "priyankac19", "varungandhi", "kanhaiyakumar"].flatMap(ratedXPostsFor);

        const analysis = analyseTiming(pooled, IST, "round trip: pooled days")!;
        const medianFor = (day: number) => analysis.byDay.find((d) => d.dayOfWeek === day)?.distribution.median ?? 0;

        // Planted: Tue/Thu 1.12, Wed 1.10 against Sat 0.82, Sun 0.85.
        const midweek = [2, 3, 4].map(medianFor);
        const weekend = [0, 6].map(medianFor);

        expect(DAY_QUALITY[2]).toBeGreaterThan(DAY_QUALITY[6]);
        expect(Math.min(...midweek)).toBeGreaterThan(0);
        // Averaged across three midweek days vs two weekend days — more robust
        // than a single-day comparison at ~40 posts per bucket.
        const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        expect(avg(midweek)).toBeGreaterThan(avg(weekend));
    });

    it("leaves most of a real 7x24 grid empty, and says so", () => {
        // The honest consequence of 168 cells and fewer than 100 posts. This is
        // asserted rather than hidden, because it is the reason the marginals
        // exist and the reason a recommendation must never cite a grid cell.
        //
        // This used to assert that suppression discarded more cells than it kept,
        // which was true only of the old drawing floor — lowering MIN_CELL_N to 2
        // inverted it (17 drawn against 9 suppressed) without touching the
        // property that actually matters. Sparsity is about the 168, not about
        // the ratio between the two piles of occupied cells.
        const analysis = analyseTiming(ratedXPostsFor("priyankac19"), IST, "round trip")!;

        // Every cell the account has ever posted in, drawn or not, is still a
        // small minority of the grid. The rest is untouched hours.
        const occupied = analysis.grid.length + analysis.suppressedCells;
        expect(occupied).toBeLessThan(168 / 2);

        // Suppression has not quietly become a no-op, and every suppressed cell
        // is located rather than merely counted.
        expect(analysis.suppressedCells).toBeGreaterThan(0);
        expect(analysis.suppressedSlots).toHaveLength(analysis.suppressedCells);

        // And the marginals are what make the data usable: collapsing day gives
        // each hour bucket several times the sample of the cells it replaces.
        const smallest = (ns: number[]) => Math.min(...ns);
        expect(smallest(analysis.byHour.map((h) => h.n))).toBeGreaterThan(
            smallest(analysis.grid.map((c) => c.n)),
        );
    });
});
