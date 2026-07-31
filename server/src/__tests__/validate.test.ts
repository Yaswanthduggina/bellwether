// The anti-fabrication guarantee, tested as a guarantee rather than as a
// function.
//
// Two of these tests are promised by name in README.md — a fabricated number and
// a non-existent post id are both rejected. The rest exist because a validator
// that only catches the obvious case is the more dangerous kind: it produces a
// green tick that means nothing.
//
// The fixture is deliberately a real report shape rather than a hand-built
// evidence Map. What the validator accepts is decided by `collectEvidence`, so
// testing against a synthetic Map would test the two halves of the contract
// against each other's assumptions instead of against the actual report.

import { describe, expect, it } from "vitest";
import { collectEvidence, type AnalyticsReport } from "../analytics/buildReport";
import {
    describeViolations,
    MIN_RECOMMENDATION_N,
    validateRecommendation,
    type Recommendation,
} from "../ai/validate";

const report = {
    generatedAt: "2026-07-31T05:00:00.000Z",
    principalName: "Shashi Tharoor",
    peerNames: ["Kanhaiya Kumar"],
    window: { from: "2026-05-01T00:00:00.000Z", to: "2026-07-29T00:00:00.000Z", days: 89 },
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
                sentence: "Shashi Tharoor posts 2.92×/week, 1.09× more often than the peer median.",
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
                    peerWindows: [{ personName: "Kanhaiya Kumar", label: "20:00", n: 41, multipleOfOverall: 1.72 }],
                    gaps: [
                        {
                            dimension: "HOUR",
                            label: "20:00",
                            kind: "ABSENT",
                            peerLift: 1.72,
                            peerAgreement: "2 of 3",
                            principalN: 0,
                            opportunity: 1.72,
                            sentence: "Evidence: Kanhaiya Kumar (n=41, 1.72×).",
                            provenanceCaveat: null,
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
    notes: [],
    truncations: [],
} as unknown as AnalyticsReport;

const evidence = collectEvidence(report);

/** A recommendation that passes, so each test can break exactly one thing. */
function sound(overrides: Partial<Recommendation> = {}): Recommendation {
    return {
        action: "Move two weekly reels into the 20:00 slot.",
        rationale: "Kanhaiya Kumar earns 1.72× his own median at 20:00 across 41 posts, a slot Tharoor never uses.",
        platform: "YOUTUBE",
        dimension: "HOUR",
        postIds: ["post_abc123"],
        figures: [1.72, 41],
        sampleSize: 41,
        confidence: "HIGH",
        priority: 1,
        ...overrides,
    };
}

describe("validateRecommendation — the baseline", () => {
    it("accepts a recommendation whose every number is in the report", () => {
        const result = validateRecommendation(sound(), evidence);
        expect(result.violations).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it("actually checked something", () => {
        // A validator that passes everything and a validator that checks nothing
        // are indistinguishable from the outside. This pins the difference.
        expect(validateRecommendation(sound(), evidence).numbersChecked).toBeGreaterThan(0);
    });
});

describe("validateRecommendation — fabrication", () => {
    it("rejects a fabricated number in the prose", () => {
        // README promises this test by name. 3.9× is plausible, in range, and
        // nowhere in the analytics.
        const result = validateRecommendation(
            sound({ rationale: "Reels earn 3.9× his own median across 41 posts." }),
            evidence,
        );

        expect(result.ok).toBe(false);
        expect(result.violations.map((v) => v.code)).toContain("UNVERIFIED_NUMBER");
        expect(describeViolations(result.violations)).toContain("3.9");
    });

    it("rejects a fabricated number in the declared figures", () => {
        const result = validateRecommendation(sound({ figures: [1.72, 99.5] }), evidence);

        expect(result.violations.map((v) => v.code)).toContain("UNVERIFIED_FIGURE");
        expect(describeViolations(result.violations)).toContain("99.5");
    });

    it("rejects a number lifted from a post caption", () => {
        // The load-bearing case. "₹5000 crore" is IN the report, inside
        // captionExcerpt, and it is a claim about the world this system has not
        // verified. `collectEvidence` leaves captions unindexed precisely so
        // that quoting one fails here.
        const result = validateRecommendation(
            sound({ rationale: "Lead with the ₹5000 crore scheme — it earned 2.48× the median." }),
            evidence,
        );

        expect(result.ok).toBe(false);
        expect(describeViolations(result.violations)).toContain("5000");
    });

    it("rejects a post id that is not in the report", () => {
        // The other test README promises by name.
        const result = validateRecommendation(sound({ postIds: ["post_does_not_exist"] }), evidence);

        expect(result.ok).toBe(false);
        expect(result.violations.map((v) => v.code)).toContain("UNKNOWN_POST_ID");
        expect(describeViolations(result.violations)).toContain("post_does_not_exist");
    });

    it("reports every violation, not only the first", () => {
        // The retry gets one shot. Naming one of three bad numbers guarantees
        // the second attempt fails on the second one.
        const result = validateRecommendation(
            sound({
                rationale: "Reels earn 3.9× his median, 7.7× on Tuesdays.",
                postIds: ["nope"],
                figures: [42.42],
            }),
            evidence,
        );

        expect(result.violations.length).toBeGreaterThanOrEqual(4);
        expect(new Set(result.violations.map((v) => v.code))).toEqual(
            new Set(["UNVERIFIED_NUMBER", "UNVERIFIED_FIGURE", "UNKNOWN_POST_ID"]),
        );
    });
});

describe("validateRecommendation — the invariant", () => {
    it("accepts a figure that exists only in the report's pre-written prose", () => {
        // Every number the model can SEE must be a number the validator ACCEPTS.
        // 1.63 appears nowhere as a field — only inside comparisonSentence,
        // beside principalVsPeers: 0.61, the same fact rounded from the other
        // end. Rejecting it would punish the model for reading its own evidence.
        const result = validateRecommendation(
            sound({
                rationale: "He ranks 4 of 4, 1.63× behind the peer benchmark, across 37 posts.",
                figures: [1.63],
            }),
            evidence,
        );

        expect(result.violations).toEqual([]);
    });

    it("accepts a time written the way the report writes it", () => {
        // "20:00" tokenises to 20 and 0 on both sides, because indexing and
        // checking share one extraction function. If they ever diverge, this
        // fails rather than the drift being discovered in production.
        expect(validateRecommendation(sound({ action: "Post at 20:00." }), evidence).ok).toBe(true);
    });
});

describe("validateRecommendation — precision", () => {
    it("accepts a verified figure restated less precisely", () => {
        // The report holds 1.72. "1.7" is that figure, coarser. Stating a
        // verified number at lower precision cannot fabricate anything.
        expect(validateRecommendation(sound({ rationale: "About 1.7× his median." }), evidence).ok).toBe(true);
    });

    it("rejects a truncation dressed as a rounding", () => {
        // 1.72 rounds to 1.7, never to 1.8. Rule 2 admits exactly one value per
        // precision — the correct one — so this is not a tolerance band.
        const result = validateRecommendation(sound({ rationale: "About 1.8× his median." }), evidence);
        expect(result.ok).toBe(false);
    });

    it("rejects extra precision invented from a rounded figure", () => {
        // The report is rounded once at build time, so 1.723 is a claim to
        // precision the analytics never had.
        expect(validateRecommendation(sound({ rationale: "Exactly 1.723× his median." }), evidence).ok).toBe(false);
    });
});

describe("validateRecommendation — sample size", () => {
    it(`drops a recommendation resting on fewer than ${MIN_RECOMMENDATION_N} posts`, () => {
        const result = validateRecommendation(sound({ sampleSize: MIN_RECOMMENDATION_N - 1 }), evidence);

        expect(result.ok).toBe(false);
        expect(result.violations.map((v) => v.code)).toContain("SAMPLE_TOO_SMALL");
    });

    it(`accepts exactly ${MIN_RECOMMENDATION_N}`, () => {
        // The threshold is a floor, not a strict inequality. Pinned because
        // off-by-one here silently discards every borderline finding.
        const result = validateRecommendation(
            sound({ sampleSize: MIN_RECOMMENDATION_N, figures: [1.72], rationale: "1.72× his median." }),
            evidence,
        );
        expect(result.violations.map((v) => v.code)).not.toContain("SAMPLE_TOO_SMALL");
    });
});

describe("validateRecommendation — shape", () => {
    it("rejects a recommendation that cites no figure at all", () => {
        // A recommendation with no measured basis is an opinion. The brief's
        // quality bar requires a multiple, a baseline, a sample and an action.
        const result = validateRecommendation(
            sound({ figures: [], rationale: "Reels do better than images.", action: "Post more reels." }),
            evidence,
        );

        expect(result.violations.map((v) => v.code)).toContain("NO_FIGURES");
    });

    it("rejects an empty action", () => {
        const result = validateRecommendation(sound({ action: "   " }), evidence);
        expect(result.violations.map((v) => v.code)).toContain("EMPTY_FIELD");
    });
});
