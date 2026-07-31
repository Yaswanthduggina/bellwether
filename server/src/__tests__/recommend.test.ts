// The generate → validate → retry → drop pipeline, with the model mocked.
//
// What is worth testing here is the ORCHESTRATION, not the prose: that a bad
// recommendation costs exactly one retry, that a retry which still fails is
// dropped rather than shown, and that the drop is reported rather than swallowed.
// The validator's own judgement is tested in validate.test.ts against a real
// report, and the model's writing quality is not a unit-testable property.
//
// `collectEvidence` is deliberately NOT mocked. Mocking it would let these tests
// agree with an evidence index that does not match the one production builds,
// which is precisely the drift the whole design is guarding against.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsReport } from "../analytics/buildReport";
import type { Recommendation } from "../ai/validate";

const { structuredMock, buildReportMock } = vi.hoisted(() => ({
    structuredMock: vi.fn(),
    buildReportMock: vi.fn(),
}));

vi.mock("../ai/gemini", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../ai/gemini")>()),
    structured: structuredMock,
}));

vi.mock("../analytics/buildReport", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../analytics/buildReport")>()),
    buildReport: buildReportMock,
}));

const { generateRecommendations } = await import("../ai/recommend");

const NO_USAGE = { promptTokens: 10, outputTokens: 20, thoughtTokens: 5 };

function makeReport(overrides: { bases?: unknown[] } = {}): AnalyticsReport {
    return {
        generatedAt: "2026-07-31T05:00:00.000Z",
        principalName: "Shashi Tharoor",
        peerNames: ["Kanhaiya Kumar"],
        window: { from: "2026-05-01T00:00:00.000Z", to: "2026-07-29T00:00:00.000Z", days: 89 },
        filter: {},
        corpusProvenance: { totalPosts: 139, livePosts: 108, seededPosts: 31, seededPct: 22 },
        platforms: [
            {
                platform: "YOUTUBE",
                totalPosts: 139,
                provenance: "MIXED",
                seededAccounts: ["Varun Gandhi"],
                cadence: null,
                formatMixDivergences: [],
                bases: overrides.bases ?? [
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
                        bestHours: [],
                        timezone: "Asia/Kolkata",
                        suppressedCells: 26,
                        rank: { position: 4, outOf: 4 },
                        peerBenchmarkRatePct: 6.2,
                        principalVsPeers: 0.61,
                        comparisonSentence: "Ranks 4 of 4, 1.63× behind the peer benchmark, across 37 posts.",
                        peerWindows: [],
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
                        overInvested: [],
                        bestPosts: [
                            {
                                id: "post_abc123",
                                postedAt: "2026-06-14T13:30:00.000Z",
                                mediaType: "REEL_SHORT_VIDEO",
                                ratePct: 9.44,
                                multipleOfMedian: 2.48,
                                permalink: "https://youtube.com/watch?v=123",
                                isSynthetic: false,
                                captionExcerpt: "A ₹5000 crore scheme",
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
}

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
    return {
        action: "Move two weekly reels into the 20:00 slot.",
        rationale: "Peers earn 1.72× their own median at 20:00 across 41 posts.",
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

beforeEach(() => {
    structuredMock.mockReset();
    buildReportMock.mockReset();
    buildReportMock.mockResolvedValue(makeReport());
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("generateRecommendations — the happy path", () => {
    it("returns validated recommendations ranked by priority", async () => {
        structuredMock.mockResolvedValueOnce({
            value: {
                recommendations: [
                    rec({ priority: 3, action: "Third. Peers earn 1.72× at 20:00." }),
                    rec({ priority: 1, action: "First. Peers earn 1.72× at 20:00." }),
                ],
            },
            usage: NO_USAGE,
        });

        const run = await generateRecommendations();

        expect(run.recommendations.map((r) => r.priority)).toEqual([1, 3]);
        expect(run.dropped).toEqual([]);
        expect(run.repaired).toBe(0);
        // One call: nothing needed repairing.
        expect(structuredMock).toHaveBeenCalledTimes(1);
    });

    it("resolves cited post ids to the report posts, for the evidence chips", () => {
        structuredMock.mockResolvedValueOnce({ value: { recommendations: [rec()] }, usage: NO_USAGE });

        return generateRecommendations().then((run) => {
            expect(run.citedPosts["post_abc123"]?.ratePct).toBe(9.44);
        });
    });

    it("reports the size of the verified-number set", async () => {
        // A large jump here means the report grew and validation quietly
        // weakened — see the cap rationale in buildReport.ts.
        structuredMock.mockResolvedValueOnce({ value: { recommendations: [rec()] }, usage: NO_USAGE });

        const run = await generateRecommendations();
        expect(run.evidence.numbers).toBeGreaterThan(0);
        expect(run.evidence.postIds).toBe(1);
    });
});

describe("generateRecommendations — retry and drop", () => {
    it("spends exactly one retry on a bad recommendation and keeps the repair", async () => {
        structuredMock
            .mockResolvedValueOnce({
                value: { recommendations: [rec({ rationale: "Peers earn 9.99× their median across 41 posts." })] },
                usage: NO_USAGE,
            })
            .mockResolvedValueOnce({ value: rec(), usage: NO_USAGE });

        const run = await generateRecommendations();

        expect(structuredMock).toHaveBeenCalledTimes(2);
        expect(run.repaired).toBe(1);
        expect(run.recommendations).toHaveLength(1);
        expect(run.dropped).toEqual([]);
    });

    it("names the specific violation in the retry, not just 'invalid'", async () => {
        structuredMock
            .mockResolvedValueOnce({
                value: { recommendations: [rec({ rationale: "Peers earn 9.99× their median across 41 posts." })] },
                usage: NO_USAGE,
            })
            .mockResolvedValueOnce({ value: rec(), usage: NO_USAGE });

        await generateRecommendations();

        // A retry that says "your output failed validation" produces a second
        // attempt that fails the same way.
        expect(structuredMock.mock.calls[1]![0].contents).toContain("9.99");
    });

    it("drops a recommendation that fails twice, and reports why", async () => {
        structuredMock
            .mockResolvedValueOnce({
                value: { recommendations: [rec({ rationale: "Peers earn 9.99× their median across 41 posts." })] },
                usage: NO_USAGE,
            })
            .mockResolvedValueOnce({
                value: rec({ rationale: "Peers earn 8.88× their median across 41 posts." }),
                usage: NO_USAGE,
            });

        const run = await generateRecommendations();

        expect(run.recommendations).toEqual([]);
        expect(run.dropped).toHaveLength(1);
        expect(run.dropped[0]!.violations.map((v) => v.code)).toContain("UNVERIFIED_NUMBER");
        expect(run.generated).toBe(1);
        // The drop must be visible in the response, not only in a log line.
        expect(run.notes.join(" ")).toContain("discarded");
    });

    it("keeps the good recommendations when another one is dropped", async () => {
        structuredMock
            .mockResolvedValueOnce({
                value: {
                    recommendations: [
                        rec({ priority: 1 }),
                        rec({ priority: 2, rationale: "Peers earn 9.99× their median across 41 posts." }),
                    ],
                },
                usage: NO_USAGE,
            })
            .mockResolvedValueOnce({
                value: rec({ priority: 2, rationale: "Still 9.99× wrong across 41 posts." }),
                usage: NO_USAGE,
            });

        const run = await generateRecommendations();

        expect(run.recommendations).toHaveLength(1);
        expect(run.recommendations[0]!.priority).toBe(1);
        expect(run.dropped).toHaveLength(1);
    });

    it("records a failed retry CALL as a drop rather than losing the run", async () => {
        // "The model was unreachable" must not read as "the model fabricated",
        // and it must not take the other recommendations down with it.
        structuredMock
            .mockResolvedValueOnce({
                value: {
                    recommendations: [rec({ priority: 1 }), rec({ priority: 2, sampleSize: 2 })],
                },
                usage: NO_USAGE,
            })
            .mockRejectedValueOnce(new Error("fetch failed"));

        const run = await generateRecommendations();

        expect(run.recommendations).toHaveLength(1);
        expect(run.dropped).toHaveLength(1);
        expect(run.dropped[0]!.violations.some((v) => v.message.includes("fetch failed"))).toBe(true);
    });
});

describe("generateRecommendations — nothing to say", () => {
    it("does not call the model when the filter produced no computable rates", async () => {
        buildReportMock.mockResolvedValue(makeReport({ bases: [] }));

        const run = await generateRecommendations({ platform: "X" });

        // Spending a call to be told there is nothing to analyse is worse than
        // saying so. A reviewer WILL hit this with an over-narrow filter.
        expect(structuredMock).not.toHaveBeenCalled();
        expect(run.recommendations).toEqual([]);
        expect(run.notes.join(" ")).toContain("Widen the filter");
    });
});
