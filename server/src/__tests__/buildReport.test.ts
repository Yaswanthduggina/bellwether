// `collectEvidence` decides what the recommendation validator will accept, so
// its failure modes are the validator's failure modes:
//
//   indexes too little → the model is rejected for quoting evidence it was
//                        given, and the only way to make it pass is to loosen
//                        the validator until it stops checking anything
//   indexes too much   → every plausible number appears somewhere and "checked
//                        against the analytics" stops meaning anything
//
// The first of those actually happened on the first real run and has its own
// test below. `buildReport` itself is composition over modules that are each
// tested against hand-computed fixtures elsewhere; the logic worth testing here
// is the walk.

import { describe, expect, it } from "vitest";
import { collectEvidence, type AnalyticsReport } from "../analytics/buildReport";

/**
 * Shaped like a real report, trimmed to what the walk has to reason about.
 * The figures mirror an actual YouTube run so the prose/field tension the
 * regression test targets is the real one.
 */
const report = {
    generatedAt: "2026-07-30T15:34:46.520Z",
    principalName: "Shashi Tharoor",
    peerNames: ["Kanhaiya Kumar"],
    window: { from: "2026-05-01T07:25:57.000Z", to: "2026-07-29T03:23:23.000Z", days: 89 },
    filter: { platform: "YOUTUBE" },
    corpusProvenance: { totalPosts: 139, livePosts: 108, seededPosts: 31, seededPct: 22 },
    platforms: [
        {
            platform: "YOUTUBE",
            totalPosts: 139,
            provenance: "MIXED",
            seededAccounts: ["Varun Gandhi"],
            cadence: {
                principalPostsPerWeek: 2.92,
                peerMedianPostsPerWeek: 2.68,
                principalVsPeers: 1.09,
                principalConsistencyPct: 69,
                peerConsistencyPct: 92,
                principalLongestSilenceDays: 8,
                sentence: "Shashi Tharoor posts 2.9×/week across 37 posts, 1.09× more often than the peer median.",
            },
            formatMixDivergences: [{ mediaType: "REEL_SHORT_VIDEO", principalSharePct: 84, peerSharePct: 52 }],
            bases: [
                {
                    basis: "VIEWS",
                    denominator: "views (realised audience)",
                    principalRatedPosts: 37,
                    principalMedianRatePct: 3.8,
                    formats: [
                        {
                            mediaType: "REEL_SHORT_VIDEO",
                            n: 31,
                            medianRatePct: 3.95,
                            multipleOfOverall: 1.04,
                            outlierDriven: false,
                        },
                    ],
                    bestHours: [{ hour: 18, label: "18:00", n: 11, multipleOfOverall: 1.11 }],
                    timezone: "Asia/Kolkata",
                    suppressedCells: 26,
                    rank: { position: 4, outOf: 4 },
                    peerBenchmarkRatePct: 6.2,
                    principalVsPeers: 0.61,
                    comparisonSentence:
                        "Shashi Tharoor ranks 4 of 4 on median engagement rate, 1.63× behind the peer benchmark, across 37 posts.",
                    peerWindows: [
                        { personName: "Priyanka Chaturvedi", label: "10:00", n: 5, multipleOfOverall: 1.4 },
                    ],
                    gaps: [
                        {
                            dimension: "FORMAT",
                            label: "REEL_SHORT_VIDEO",
                            kind: "UNDERPERFORMING",
                            peerLift: 1.43,
                            peerAgreement: "2 of 3",
                            principalN: 31,
                            opportunity: 1.38,
                            sentence: "Evidence: Priyanka Chaturvedi (n=8, 1.45×), Kanhaiya Kumar (n=25, 1.08×).",
                            provenanceCaveat: "Mixes live and seeded peers — seeded: Varun Gandhi.",
                        },
                    ],
                    overInvested: [
                        {
                            label: "Thursday",
                            n: 10,
                            shareOfOutputPct: 27,
                            lift: 0.8,
                            sentence: "Spends 27% of his output on Thursday (n=10), earning 0.80× his own baseline.",
                        },
                    ],
                    bestPosts: [
                        {
                            id: "post_abc123",
                            postedAt: "2026-06-14T13:30:00.000Z",
                            mediaType: "REEL_SHORT_VIDEO",
                            ratePct: 9.44,
                            multipleOfMedian: 2.48,
                            permalink: "https://youtube.com/watch?v=12345678901",
                            isSynthetic: false,
                            captionExcerpt: "A ₹5000 crore scheme for 250 villages",
                        },
                    ],
                    worstPosts: [],
                },
            ],
        },
    ],
    notes: ["31 of 139 posts in this report are seeded, not fetched."],
    truncations: [],
} as unknown as AnalyticsReport;

describe("collectEvidence — what the validator will accept", () => {
    const evidence = collectEvidence(report);

    it("indexes computed figures with the path they came from", () => {
        expect(evidence.numbers.has(3.95)).toBe(true);
        expect(evidence.numbers.get(3.95)![0]).toContain("formats[0].medianRatePct");
        expect(evidence.numbers.has(6.2)).toBe(true);
        expect(evidence.numbers.has(89)).toBe(true);
    });

    it("collects post ids separately from numbers", () => {
        // A number must MATCH a value; an id must EXIST. Different checks.
        expect(evidence.postIds.has("post_abc123")).toBe(true);
        expect(evidence.postIds.size).toBe(1);
    });

    it("indexes numbers that appear only in the pre-written prose", () => {
        // THE REGRESSION. The report holds principalVsPeers: 0.61 and a sentence
        // reading "1.63× behind" — the same fact rounded from opposite ends. A
        // model quoting 1.63 straight out of the evidence it was handed must not
        // be rejected as a fabricator.
        expect(evidence.numbers.has(0.61)).toBe(true);
        expect(evidence.numbers.has(1.63)).toBe(true);
    });

    it("indexes the hour a gap is about, which exists only in its label", () => {
        // THE SECOND INSTANCE OF THE SAME REGRESSION, found by validate.test.ts.
        //
        // `ReportGap` carries no numeric hour field — the hour lives in
        // `label: "18:00"` and nowhere else. While labels were unindexed, a
        // model could read "peers earn 1.43× at 18:00" out of its own evidence
        // and be rejected as a fabricator for writing 18:00 back.
        //
        // That is not a cosmetic rejection. A timing recommendation cannot be
        // written without naming the hour, and timing is the one thing the
        // principal's own corpus cannot produce (gaps.ts) — so the hole sat
        // exactly on this product's most important output.
        const withHourLabel = structuredClone(report) as AnalyticsReport;
        withHourLabel.platforms[0]!.bases[0]!.gaps[0] = {
            ...withHourLabel.platforms[0]!.bases[0]!.gaps[0]!,
            dimension: "HOUR",
            label: "18:00",
        };

        expect(collectEvidence(withHourLabel).numbers.has(18)).toBe(true);
    });

    it("indexes peer agreement counts", () => {
        // "2 of 3" is two computed counts. A model writing "2 of 3 peers agree"
        // is restating verified evidence.
        expect(evidence.numbers.has(2)).toBe(true);
        expect(evidence.numbers.has(3)).toBe(true);
    });

    it("still refuses to index numbers that come from post captions", () => {
        // The counterweight to the two tests above. Widening what counts as
        // indexable prose must not reach captions: "₹5000 crore" is a claim
        // about the world this system has not verified and cannot check.
        expect(evidence.numbers.has(5000)).toBe(false);
        expect(evidence.numbers.has(250)).toBe(false);
    });

    it("indexes per-peer figures that exist nowhere but the prose", () => {
        // "Priyanka Chaturvedi (n=8, 1.45×)" — these appear in no structured
        // field, and indexing the sentence is the only thing making them citable.
        expect(evidence.numbers.has(8)).toBe(true);
        expect(evidence.numbers.has(1.45)).toBe(true);
        expect(evidence.numbers.has(1.08)).toBe(true);
    });

    it("indexes figures stated in the notes", () => {
        expect(evidence.numbers.has(139)).toBe(true);
    });

    it("does NOT index numbers lifted out of a post caption", () => {
        // "₹5000 crore ... 250 villages" is a claim about the world that this
        // system has not verified and cannot check. Recommendations cite computed
        // figures; leaving captions unindexed is what enforces that.
        expect(evidence.numbers.has(5000)).toBe(false);
        expect(evidence.numbers.has(250)).toBe(false);
    });

    it("does NOT index digits from timestamps, permalinks or labels", () => {
        // 2026 (a year), 12345678901 (a video id) and 10 from the "10:00" label
        // are not performance claims. 10 is separately present as overInvested.n,
        // so the label test uses the video id and the year.
        expect(evidence.numbers.has(2026)).toBe(false);
        expect(evidence.numbers.has(12345678901)).toBe(false);
    });

    it("records every path a repeated number appears at", () => {
        // 4 appears twice in `rank`. The validator names the path in its error,
        // so a figure with several sources should carry all of them.
        expect(evidence.numbers.get(4)).toEqual(
            expect.arrayContaining([expect.stringContaining("rank.position"), expect.stringContaining("rank.outOf")]),
        );
    });

    it("holds the invariant: every number in prose the model sees is accepted", () => {
        // Stated as a property rather than as individual cases, so a new prose
        // field added to the report cannot quietly break it.
        const prose: string[] = [];
        const gather = (node: unknown): void => {
            if (node === null || typeof node !== "object") return;
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                if (["sentence", "comparisonSentence", "provenanceCaveat"].includes(key) && typeof value === "string") {
                    prose.push(value);
                } else if ((key === "notes" || key === "truncations") && Array.isArray(value)) {
                    prose.push(...(value as string[]));
                } else {
                    gather(value);
                }
            }
        };
        gather(report);

        const unindexed = prose
            .flatMap((sentence) => sentence.match(/-?\d+(?:\.\d+)?/g) ?? [])
            .filter((literal) => !evidence.numbers.has(Number(literal)));

        expect(unindexed).toEqual([]);
    });

    it("keeps the accepted set small enough for the check to mean something", () => {
        // The counter-intuitive rule: a bigger report is a WEAKER validator,
        // because a number appearing anywhere in the evidence is by definition
        // citable. This fixture is one platform; the real full-corpus report
        // indexes ~200. A jump into the thousands means the caps have stopped
        // working and validation has quietly become a formality.
        expect(evidence.numbers.size).toBeLessThan(80);
    });
});
