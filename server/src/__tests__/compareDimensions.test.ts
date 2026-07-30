// The Module C MUST names four dimensions on one screen: engagement, cadence,
// format mix and best-performing windows. `compare.test.ts` covers engagement
// and `cadence.test.ts` covers cadence; this file covers the other two.
//
// FORMAT MIX IS NOT FORMAT PERFORMANCE, and conflating them is the mistake this
// half of the comparison exists to prevent:
//
//   format.ts   — how well does each format PERFORM?      (a rate, has a basis)
//   format mix  — how much of the calendar does it TAKE?  (a share, has none)
//
// The advice lives in the gap between them. A format performing at 2× on 4% of
// output is the finding; either figure alone is not one.

import { describe, expect, it } from "vitest";
import { MixedBasisError, type EngagementBasis, type MediaType, type RatedPost } from "../analytics/engagement";
import { analyseTiming, occupiedHours, type TimingPost } from "../analytics/timing";
import {
    compareFormatMix,
    compareWindows,
    type MixCorpus,
    type MixPost,
    type WindowCorpus,
} from "../analytics/compare";

const IST = "Asia/Kolkata";

// ── Format mix ───────────────────────────────────────────────────────────

function mixCorpus(
    personName: string,
    role: "PRINCIPAL" | "COMPETITOR",
    counts: Partial<Record<MediaType, number>>,
): MixCorpus<MixPost> {
    const posts: MixPost[] = [];
    for (const [mediaType, n] of Object.entries(counts)) {
        for (let i = 0; i < (n ?? 0); i += 1) posts.push({ mediaType: mediaType as MediaType });
    }
    return { accountId: `acc_${personName}`, personName, role, isSynthetic: false, posts };
}

describe("format mix — how the calendar is allocated", () => {
    it("reports each format's share of an account's output", () => {
        const result = compareFormatMix([
            mixCorpus("Tharoor", "PRINCIPAL", { TEXT_ONLY: 60, LINK: 30, SINGLE_IMAGE: 10 }),
            mixCorpus("PeerA", "COMPETITOR", { REEL_SHORT_VIDEO: 50, TEXT_ONLY: 50 }),
        ]);

        expect(result.principal!.total).toBe(100);
        expect(result.principal!.shares[0]).toEqual({ mediaType: "TEXT_ONLY", n: 60, share: 0.6 });
        // Shares are of the account's own output, so they sum to 1.
        expect(result.principal!.shares.reduce((t, s) => t + s.share, 0)).toBeCloseTo(1, 12);
    });

    it("includes a format the principal has NEVER used, at a share of 0", () => {
        // The single most actionable row this function can produce: 0% against a
        // 50% peer median. Omitting the row because the count is zero would hide
        // exactly the finding a comms team needs.
        const result = compareFormatMix([
            mixCorpus("Tharoor", "PRINCIPAL", { TEXT_ONLY: 100 }),
            mixCorpus("PeerA", "COMPETITOR", { REEL_SHORT_VIDEO: 50, TEXT_ONLY: 50 }),
            mixCorpus("PeerB", "COMPETITOR", { REEL_SHORT_VIDEO: 50, TEXT_ONLY: 50 }),
        ]);

        const reels = result.divergences.find((d) => d.mediaType === "REEL_SHORT_VIDEO")!;
        expect(reels).toEqual({
            mediaType: "REEL_SHORT_VIDEO",
            principalShare: 0,
            peerShare: 0.5,
            difference: -0.5,
        });
    });

    it("ranks divergences by size regardless of direction", () => {
        // Over-allocation is as much a finding as under-allocation — the "stop"
        // recommendation needs the same evidence as the "start" one.
        const result = compareFormatMix([
            mixCorpus("Tharoor", "PRINCIPAL", { LINK: 80, TEXT_ONLY: 20 }),
            mixCorpus("PeerA", "COMPETITOR", { LINK: 10, TEXT_ONLY: 90 }),
            mixCorpus("PeerB", "COMPETITOR", { LINK: 10, TEXT_ONLY: 90 }),
        ]);

        expect(result.divergences[0].mediaType).toBe("LINK");
        expect(result.divergences[0].difference).toBeCloseTo(0.7, 12);
    });

    it("benchmarks against the MEDIAN peer, so one specialist cannot redefine normal", () => {
        // Peer reel shares are 0, 0 and 0.9. The median is 0; the mean is 0.3
        // and would report a gap built entirely on one competitor's obsession.
        const result = compareFormatMix([
            mixCorpus("Tharoor", "PRINCIPAL", { TEXT_ONLY: 100 }),
            mixCorpus("PeerA", "COMPETITOR", { TEXT_ONLY: 100 }),
            mixCorpus("PeerB", "COMPETITOR", { TEXT_ONLY: 100 }),
            mixCorpus("PeerC", "COMPETITOR", { REEL_SHORT_VIDEO: 90, TEXT_ONLY: 10 }),
        ]);

        expect(result.divergences.find((d) => d.mediaType === "REEL_SHORT_VIDEO")!.peerShare).toBe(0);
    });

    it("produces no divergences with nobody to diverge from", () => {
        const result = compareFormatMix([mixCorpus("Tharoor", "PRINCIPAL", { TEXT_ONLY: 10 })]);

        expect(result.divergences).toHaveLength(0);
        expect(result.principal!.total).toBe(10);
    });
});

// ── Best-performing windows ──────────────────────────────────────────────

function istMonday(localHour: number): Date {
    return new Date(Date.UTC(2026, 0, 5, localHour - 5, -30));
}

function timed(rate: number, hour: number, basis: EngagementBasis = "VIEWS"): RatedPost<TimingPost> {
    return {
        post: {
            platform: "YOUTUBE",
            mediaType: "TEXT_ONLY",
            postedAt: istMonday(hour),
            likes: null,
            comments: null,
            shares: null,
            views: null,
            saves: null,
        },
        engagement: { interactions: rate * 10_000, denominator: 10_000, basis, rate },
    };
}

function windowCorpus(
    personName: string,
    role: "PRINCIPAL" | "COMPETITOR",
    posts: RatedPost<TimingPost>[],
): WindowCorpus {
    return {
        accountId: `acc_${personName}`,
        personName,
        role,
        isSynthetic: false,
        timezone: IST,
        analysis: analyseTiming(posts, IST),
        occupiedHours: occupiedHours(posts, IST),
    };
}

/** `n` posts at `hour` earning `rate`. */
function hourBlock(n: number, hour: number, rate: number, basis: EngagementBasis = "VIEWS") {
    return Array.from({ length: n }, () => timed(rate, hour, basis));
}

describe("best-performing windows — the fourth dimension", () => {
    it("merges adjacent strong hours into one schedulable window", () => {
        const peer = windowCorpus("PeerA", "COMPETITOR", [
            ...hourBlock(6, 9, 0.02),
            ...hourBlock(6, 19, 0.08),
            ...hourBlock(6, 20, 0.08),
            ...hourBlock(6, 21, 0.08),
        ]);

        const result = compareWindows([windowCorpus("Tharoor", "PRINCIPAL", hourBlock(10, 10, 0.03)), peer])!;

        expect(result.peers).toHaveLength(1);
        expect(result.peers[0]).toMatchObject({ startHour: 19, endHour: 21, label: "19:00–21:59", n: 18 });
    });

    it("names the hours the principal never posts in at all", () => {
        // An hour he posts in BADLY is still an hour he uses, and telling him to
        // "start" there would be wrong advice about something he already does.
        const result = compareWindows([
            windowCorpus("Tharoor", "PRINCIPAL", [...hourBlock(10, 10, 0.03), ...hourBlock(6, 20, 0.001)]),
            windowCorpus("PeerA", "COMPETITOR", [...hourBlock(6, 9, 0.02), ...hourBlock(6, 19, 0.08), ...hourBlock(6, 20, 0.08)]),
        ])!;

        // 19 is genuinely unused; 20 is used (badly) and must not be listed.
        expect(result.hoursPrincipalNeverUses).toEqual([19]);
    });

    it("does not call an hour he uses RARELY an hour he never uses", () => {
        // THE REGRESSION, caught on the live YouTube corpus: presence was read
        // off `analysis.byHour`, which suppresses buckets under MIN_CELL_N. Two
        // posts at 20:00 vanished from the marginal and the route reported 20:00
        // as an hour the principal had never used — so the advice would have been
        // "start posting at 20:00" to someone already posting at 20:00.
        //
        // One post, deliberately: below MIN_CELL_N=3, so it exists in the corpus
        // and cannot exist in the marginal.
        const principal = windowCorpus("Tharoor", "PRINCIPAL", [
            ...hourBlock(10, 10, 0.03),
            ...hourBlock(1, 20, 0.03),
        ]);

        expect(principal.analysis!.byHour.some((b) => b.hour === 20)).toBe(false);
        expect(principal.occupiedHours).toContain(20);

        const result = compareWindows([
            principal,
            windowCorpus("PeerA", "COMPETITOR", [...hourBlock(6, 9, 0.02), ...hourBlock(6, 19, 0.08), ...hourBlock(6, 20, 0.08)]),
        ])!;

        expect(result.hoursPrincipalNeverUses).toEqual([19]);
    });

    it("excludes low-confidence hours, so a thin slot cannot sit beside a solid one", () => {
        // Four posts at 22:00 earning brilliantly. timing.ts flags that LOW, and
        // a side-by-side comparison is exactly where a thin claim would read as
        // an equal claim to a peer's twenty-post window.
        const result = compareWindows([
            windowCorpus("Tharoor", "PRINCIPAL", hourBlock(10, 10, 0.03)),
            windowCorpus("PeerA", "COMPETITOR", [...hourBlock(20, 9, 0.02), ...hourBlock(4, 22, 0.9)]),
        ])!;

        expect(result.peers.some((w) => w.startHour === 22)).toBe(false);
    });

    it("throws rather than putting a views window beside a followers window", () => {
        expect(() =>
            compareWindows([
                windowCorpus("Tharoor", "PRINCIPAL", hourBlock(10, 10, 0.03, "VIEWS")),
                windowCorpus("PeerA", "COMPETITOR", hourBlock(10, 19, 0.3, "FOLLOWERS")),
            ]),
        ).toThrow(MixedBasisError);
    });

    it("returns null when no account has enough timing data", () => {
        expect(compareWindows([windowCorpus("Tharoor", "PRINCIPAL", [])])).toBeNull();
    });
});
