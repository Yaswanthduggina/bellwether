// Gap analysis is the module the Day 2 findings forced into existence, and two
// of its tests are the reason it is shaped the way it is.
//
//   1. "THE ENGINE CANNOT SEE A SLOT THE ACCOUNT NEVER POSTS IN" asserts the
//      finding itself: the principal's own timing analysis is run alongside the
//      gap analysis on the same corpus, and only the gap analysis finds the
//      evening. That is the whole justification for the module existing, so it
//      is pinned as a test rather than left as a paragraph in ARCHITECTURE.md.
//
//   2. "VOLUME INVARIANCE" asserts the fix for the trap the Day 2 format test
//      found. Pooling posts across peers conflates format quality with posting
//      habit — it inflated reel-over-link from the planted 3.45× to 6.46×. Here
//      the same peer set is measured twice with one peer's volume tripled, and
//      the reported lift must not move. Pooling would move it 1.67× → 2.00×.

import { describe, expect, it } from "vitest";
import { MixedBasisError, type EngagementBasis, type RatedPost } from "../analytics/engagement";
import { analyseTiming, bestHours, localSlot } from "../analytics/timing";
import {
    describeGap,
    findGaps,
    findGapsByBasis,
    mergeHourWindows,
    GAP_LIFT_THRESHOLD,
    MIN_GAP_N,
    MIN_PEER_ACCOUNTS,
    type ContentPillar,
    type GapCorpus,
    type GapPost,
} from "../analytics/gaps";

const IST = "Asia/Kolkata";

/**
 * A UTC instant that lands on `localHour` in IST on Monday 5 Jan 2026.
 *
 * IST is UTC+5:30 and observes no DST, so this is a fixed shift — but it is
 * asserted below rather than assumed, because a fixture that silently drifts by
 * an hour would make every timing assertion in this file wrong in the same
 * direction and therefore self-consistent.
 */
function istMonday(localHour: number): Date {
    return new Date(Date.UTC(2026, 0, 5, localHour - 5, -30));
}

interface PostSpec {
    rate: number;
    hour?: number;
    mediaType?: GapPost["mediaType"];
    theme?: ContentPillar | null;
    basis?: EngagementBasis;
}

function ratedPost(spec: PostSpec): RatedPost<GapPost> {
    return {
        post: {
            platform: "YOUTUBE",
            mediaType: spec.mediaType ?? "TEXT_ONLY",
            postedAt: istMonday(spec.hour ?? 10),
            theme: spec.theme ?? null,
            likes: null,
            comments: null,
            shares: null,
            views: null,
            saves: null,
        },
        engagement: {
            interactions: spec.rate * 10_000,
            denominator: 10_000,
            basis: spec.basis ?? "VIEWS",
            rate: spec.rate,
        },
    };
}

/** `n` identical posts. Identical rates keep every expected median exact. */
function block(n: number, spec: PostSpec): RatedPost<GapPost>[] {
    return Array.from({ length: n }, () => ratedPost(spec));
}

function corpus(
    personName: string,
    role: "PRINCIPAL" | "COMPETITOR",
    rated: RatedPost<GapPost>[],
    options: { isSynthetic?: boolean } = {},
): GapCorpus<GapPost> {
    return {
        accountId: `acc_${personName}`,
        personName,
        role,
        platform: "YOUTUBE",
        handle: personName.toLowerCase(),
        isSynthetic: options.isSynthetic ?? false,
        timezone: IST,
        rated,
    };
}

describe("the fixture itself", () => {
    it("places istMonday(19) at 19:00 on a Monday in IST", () => {
        // If this drifts, every hour assertion below drifts with it and stays
        // internally consistent — which is exactly how a timing bug survives.
        expect(localSlot(istMonday(19), IST)).toEqual({ dayOfWeek: 1, hour: 19 });
        expect(istMonday(19).toISOString()).toBe("2026-01-05T13:30:00.000Z");
    });
});

// ── The finding this module exists for ───────────────────────────────────

describe("the engine cannot see a slot the account never posts in", () => {
    // Tharoor posts 09:00–11:00 and never in the evening. Both peers post a
    // daytime block that performs at their own baseline, plus an evening block
    // at 3× it. The evening peak is real and is entirely outside his corpus.
    const principal = corpus("Tharoor", "PRINCIPAL", [
        ...block(6, { rate: 0.03, hour: 9 }),
        ...block(6, { rate: 0.03, hour: 10 }),
        ...block(6, { rate: 0.03, hour: 11 }),
    ]);

    const eveningPeer = (name: string) =>
        corpus(name, "COMPETITOR", [
            ...block(12, { rate: 0.02, hour: 10 }), // sets the baseline: median 0.02
            ...block(6, { rate: 0.06, hour: 19 }), // 3.0× that baseline
        ]);

    const corpora = [principal, eveningPeer("PeerA"), eveningPeer("PeerB")];

    it("the principal's OWN timing analysis reports his best hours at ~1.0x and never mentions 19:00", () => {
        const timing = analyseTiming(principal.rated, IST)!;

        expect(timing.byHour.map((b) => b.hour).sort((a, b) => a - b)).toEqual([9, 10, 11]);

        // Every hour he posts in performs exactly like every other hour he posts
        // in, so "his best hour" carries no information. This is the Day 2
        // result reproduced: a recommendation drawn from here says "carry on".
        for (const bucket of bestHours(timing)) {
            expect(bucket.multipleOfOverall).toBeCloseTo(1, 12);
        }
    });

    it("gap analysis finds the 19:00 slot from the peer corpora instead", () => {
        const analysis = findGaps(corpora)!;

        expect(analysis.gaps).toHaveLength(1);

        const [gap] = analysis.gaps;
        expect(gap.key).toEqual({ dimension: "HOUR", hour: 19 });
        expect(gap.kind).toBe("ABSENT");
        expect(gap.principal.n).toBe(0);
        expect(gap.peerLift).toBeCloseTo(3, 12);
        expect(gap.peerAgreement).toEqual({ clearing: 2, of: 2 });
        expect(gap.opportunity).toBeCloseTo(3, 12);
    });

    it("does not manufacture gaps from dimensions where the peers are merely typical", () => {
        // Everyone posts TEXT_ONLY on a Monday, so those buckets sit at exactly
        // 1.0× for every account. A module that reported them would be reporting
        // the absence of a finding as a finding.
        const analysis = findGaps(corpora)!;
        const dimensions = analysis.gaps.map((g) => g.key.dimension);

        expect(dimensions).not.toContain("FORMAT");
        expect(dimensions).not.toContain("DAY");
    });

    it("names the peers and the sample sizes in the sentence it hands to the AI layer", () => {
        const analysis = findGaps(corpora)!;
        const sentence = describeGap(analysis.gaps[0], analysis.principalName);

        expect(sentence).toContain("no posts in the 19:00 hour");
        expect(sentence).toContain("3.00×");
        expect(sentence).toContain("2 of 2 peers clear");
        expect(sentence).toContain("PeerA (n=6");
        // Nothing here is seeded, so no caveat should be attached.
        expect(sentence).not.toContain("SEEDED");
        expect(sentence).not.toContain("CAVEAT");
    });
});

// ── Agreement, not just sample ───────────────────────────────────────────

describe("agreement is a gate, not a footnote", () => {
    // Regression test for a real finding the first live run produced: an
    // Instagram day-of-week gap reported at 1.38× on the strength of ONE peer at
    // 1.76× and a second at exactly 1.00×. The median of two values interpolates,
    // so an enthusiastic peer dragged a flat one over the line and the result
    // read as a two-peer pattern. It was one peer's habit.
    const principal = () => corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, hour: 10 }));

    const peerAt = (name: string, eveningRate: number) =>
        corpus(name, "COMPETITOR", [
            ...block(10, { rate: 0.02, hour: 10 }),
            ...block(6, { rate: eveningRate, hour: 19 }),
        ]);

    it("rejects a gap where only one peer actually clears the bar", () => {
        // Lifts 1.76× and 1.00×; their median is 1.38×, comfortably over the
        // threshold, and the gap must still be refused.
        const analysis = findGaps([principal(), peerAt("Strong", 0.0352), peerAt("Flat", 0.02)])!;

        expect(analysis.gaps.filter((g) => g.key.dimension === "HOUR")).toHaveLength(0);
    });

    it("accepts it once a second peer clears the bar independently", () => {
        const analysis = findGaps([principal(), peerAt("Strong", 0.0352), peerAt("AlsoStrong", 0.026)])!;
        const gap = analysis.gaps.find((g) => g.key.dimension === "HOUR")!;

        expect(gap.peerAgreement).toEqual({ clearing: 2, of: 2 });
    });

    it(`counts a non-clearing peer in 'of' so the ratio stays honest`, () => {
        const analysis = findGaps([
            principal(),
            peerAt("Strong", 0.0352),
            peerAt("AlsoStrong", 0.026),
            peerAt("Flat", 0.02),
        ])!;
        const gap = analysis.gaps.find((g) => g.key.dimension === "HOUR")!;

        // "2 of 3" is the truth. Dropping the flat peer from the denominator
        // would report unanimity that does not exist.
        expect(gap.peerAgreement).toEqual({ clearing: 2, of: 3 });
    });
});

// ── Provenance ───────────────────────────────────────────────────────────

describe("provenance travels with the gap, not just the analysis", () => {
    // The other thing the first live run surfaced: the strongest YouTube gap had
    // its MEDIAN lift set by the single seeded peer. The figure is real
    // arithmetic about a partly-generated world, and the reader has to be told.
    const principal = () => corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, hour: 10 }));

    const strongPeer = (name: string, isSynthetic: boolean) =>
        corpus(
            name,
            "COMPETITOR",
            [...block(10, { rate: 0.02, hour: 10 }), ...block(6, { rate: 0.06, hour: 19 })],
            { isSynthetic },
        );

    it("flags a gap whose evidence spans live and seeded peers", () => {
        const analysis = findGaps([principal(), strongPeer("Live", false), strongPeer("Seeded", true)])!;
        const gap = analysis.gaps[0];

        expect(gap.provenance).toEqual({ mixed: true, allSynthetic: false, syntheticPeers: ["Seeded"] });
        expect(describeGap(gap, "Tharoor")).toContain("mixes live and seeded peers");
    });

    it("says plainly when every peer behind a figure is generated", () => {
        const analysis = findGaps([principal(), strongPeer("SeededA", true), strongPeer("SeededB", true)])!;
        const gap = analysis.gaps[0];

        expect(gap.provenance.allSynthetic).toBe(true);
        expect(describeGap(gap, "Tharoor")).toContain("demonstrates the pipeline, not a real-world finding");
    });

    it("attaches no caveat when every peer is live", () => {
        const analysis = findGaps([principal(), strongPeer("LiveA", false), strongPeer("LiveB", false)])!;

        expect(analysis.gaps[0].provenance).toEqual({ mixed: false, allSynthetic: false, syntheticPeers: [] });
    });
});

// ── The pooling trap ─────────────────────────────────────────────────────

describe("peers are measured against themselves, never pooled", () => {
    /**
     * Both peers earn exactly 1.5× their own baseline on reels. `scale`
     * multiplies PeerA's volume without changing its shape — so its lift is
     * unchanged by construction, and any movement in the reported figure can
     * only have come from pooling.
     */
    function reelCorpora(scale: number): GapCorpus<GapPost>[] {
        return [
            // The principal never posts a reel: makes this an ABSENT gap so the
            // peer figure is reported directly rather than as a ratio.
            corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, mediaType: "TEXT_ONLY" })),
            corpus("PeerA", "COMPETITOR", [
                ...block(10 * scale, { rate: 0.09, mediaType: "REEL_SHORT_VIDEO" }),
                ...block(10 * scale, { rate: 0.03, mediaType: "TEXT_ONLY" }),
            ]), // own median 0.06 → reel lift 1.5
            corpus("PeerB", "COMPETITOR", [
                ...block(10, { rate: 0.06, mediaType: "REEL_SHORT_VIDEO" }),
                ...block(10, { rate: 0.02, mediaType: "TEXT_ONLY" }),
            ]), // own median 0.04 → reel lift 1.5
        ];
    }

    function reelGap(scale: number) {
        const analysis = findGaps(reelCorpora(scale))!;
        return analysis.gaps.find((g) => g.key.dimension === "FORMAT")!;
    }

    it("reports the median of the per-peer lifts", () => {
        const gap = reelGap(1);

        expect(gap.key).toEqual({ dimension: "FORMAT", mediaType: "REEL_SHORT_VIDEO" });
        expect(gap.peerLift).toBeCloseTo(1.5, 12);
        expect(gap.peers.map((p) => p.lift)).toEqual([expect.closeTo(1.5, 12), expect.closeTo(1.5, 12)]);
    });

    it("does not move when one peer's volume triples — pooling would", () => {
        // Pooled, the same two fixtures give 0.075/0.045 = 1.67× at scale 1 and
        // 0.09/0.045 = 2.00× at scale 3: a 33% swing produced entirely by one
        // account posting more, which is the Day 2 bug in a different costume.
        expect(reelGap(3).peerLift).toBeCloseTo(reelGap(1).peerLift, 12);
        expect(reelGap(3).peerLift).toBeCloseTo(1.5, 12);
    });
});

// ── Evidence thresholds ──────────────────────────────────────────────────

describe("thresholds", () => {
    const principal = () => corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, hour: 10 }));

    const strongPeer = (name: string) =>
        corpus(name, "COMPETITOR", [
            ...block(10, { rate: 0.02, hour: 10 }),
            ...block(6, { rate: 0.06, hour: 19 }),
        ]);

    it(`requires ${MIN_PEER_ACCOUNTS} independent peers — one peer's strong slot is that peer's habit`, () => {
        const analysis = findGaps([principal(), strongPeer("PeerA")])!;

        expect(analysis.gaps).toHaveLength(0);
        expect(analysis.notes.join(" ")).toContain(`requires ${MIN_PEER_ACCOUNTS} independent`);
    });

    it(`ignores a peer with fewer than ${MIN_GAP_N} posts in the bucket`, () => {
        // PeerB has four evening posts. It is not counted, which drops the
        // qualifying peer count to one and kills the gap.
        const thinPeer = corpus("PeerB", "COMPETITOR", [
            ...block(10, { rate: 0.02, hour: 10 }),
            ...block(MIN_GAP_N - 1, { rate: 0.06, hour: 19 }),
        ]);

        const analysis = findGaps([principal(), strongPeer("PeerA"), thinPeer])!;
        expect(analysis.gaps.filter((g) => g.key.dimension === "HOUR")).toHaveLength(0);
    });

    it(`ignores a bucket where the peers themselves are below ${GAP_LIFT_THRESHOLD}x their own baseline`, () => {
        // Peers post in the evening but do no better there than anywhere else.
        // The principal is absent from it — and that absence costs him nothing.
        const flatPeer = (name: string) =>
            corpus(name, "COMPETITOR", [
                ...block(10, { rate: 0.02, hour: 10 }),
                ...block(6, { rate: 0.021, hour: 19 }),
            ]);

        const analysis = findGaps([principal(), flatPeer("PeerA"), flatPeer("PeerB")])!;
        expect(analysis.gaps).toHaveLength(0);
    });

    it("excludes a peer whose own median is 0, and says so", () => {
        const zeroPeer = corpus("PeerZero", "COMPETITOR", [
            ...block(15, { rate: 0, hour: 10 }),
            ...block(6, { rate: 0.06, hour: 19 }),
        ]);

        const analysis = findGaps([principal(), strongPeer("PeerA"), strongPeer("PeerB"), zeroPeer])!;

        expect(analysis.peersConsidered).not.toContain("PeerZero");
        expect(analysis.notes.join(" ")).toContain("PeerZero excluded");
        // The two usable peers still produce the gap.
        expect(analysis.gaps[0].peerAgreement).toEqual({ clearing: 2, of: 2 });
    });
});

// ── Gap kinds ────────────────────────────────────────────────────────────

describe("gap kinds", () => {
    const peers = () => [
        corpus("PeerA", "COMPETITOR", [...block(10, { rate: 0.02, hour: 10 }), ...block(6, { rate: 0.06, hour: 19 })]),
        corpus("PeerB", "COMPETITOR", [...block(10, { rate: 0.02, hour: 10 }), ...block(6, { rate: 0.06, hour: 19 })]),
    ];

    function eveningGap(principalPosts: RatedPost<GapPost>[]) {
        const analysis = findGaps([corpus("Tharoor", "PRINCIPAL", principalPosts), ...peers()])!;
        return analysis.gaps.find((g) => g.key.dimension === "HOUR" && g.key.hour === 19);
    }

    it("ABSENT when the principal has never posted in the bucket", () => {
        const gap = eveningGap(block(20, { rate: 0.03, hour: 10 }))!;

        expect(gap.kind).toBe("ABSENT");
        expect(gap.principal).toMatchObject({ n: 0, shareOfOutput: 0, bucketMedian: null, lift: null });
    });

    it("THIN when he is present but below the bar for quoting a rate", () => {
        const gap = eveningGap([
            ...block(20, { rate: 0.03, hour: 10 }),
            ...block(MIN_GAP_N - 2, { rate: 0.03, hour: 19 }),
        ])!;

        expect(gap.kind).toBe("THIN");
        expect(gap.principal.n).toBe(MIN_GAP_N - 2);
        // The count is reported; the rate is withheld. A three-post median is
        // not a figure this product puts in front of anyone.
        expect(gap.principal.bucketMedian).toBeNull();
        expect(gap.principal.lift).toBeNull();
    });

    it("UNDERPERFORMING when he posts there in volume and still loses", () => {
        // Principal's evening posts sit at his own baseline (1.0×) while peers
        // reach 3.0× theirs. Opportunity is the ratio of the two lifts.
        const gap = eveningGap([...block(20, { rate: 0.03, hour: 10 }), ...block(10, { rate: 0.03, hour: 19 })])!;

        expect(gap.kind).toBe("UNDERPERFORMING");
        expect(gap.principal.n).toBe(10);
        expect(gap.principal.lift).toBeCloseTo(1, 12);
        expect(gap.opportunity).toBeCloseTo(3, 12);
    });

    it("reports nothing when he already matches the peer lift", () => {
        // 10 evening posts at 0.09 against a 0.03 baseline — 3.0×, the same as
        // the peer set. There is no gap here, and inventing one would send a
        // comms team to fix something that is already working.
        expect(eveningGap([...block(20, { rate: 0.03, hour: 10 }), ...block(10, { rate: 0.09, hour: 19 })])).toBeUndefined();
    });
});

// ── Over-investment: the "stop" side ─────────────────────────────────────

describe("over-investment", () => {
    const peer = (name: string) => corpus(name, "COMPETITOR", block(20, { rate: 0.03, hour: 10 }));

    it("flags a bucket that takes real output for a below-baseline return", () => {
        // Half his output goes to LINK, which returns half his baseline.
        const principal = corpus("Tharoor", "PRINCIPAL", [
            ...block(20, { rate: 0.06, mediaType: "TEXT_ONLY" }),
            ...block(20, { rate: 0.03, mediaType: "LINK" }),
        ]);

        const analysis = findGaps([principal, peer("PeerA"), peer("PeerB")])!;
        const link = analysis.overInvested.find(
            (o) => o.key.dimension === "FORMAT" && o.key.mediaType === "LINK",
        )!;

        expect(link.n).toBe(20);
        expect(link.shareOfOutput).toBeCloseTo(0.5, 12);
        // Overall median is (0.03 + 0.06) / 2 = 0.045; LINK sits at 0.03.
        expect(link.lift).toBeCloseTo(0.03 / 0.045, 12);
    });

    it("ignores a weak bucket too small to be worth changing", () => {
        // The same 0.67× return, but on 6 of 106 posts. True, and not worth a
        // recommendation — fixing it cannot move the account.
        const principal = corpus("Tharoor", "PRINCIPAL", [
            ...block(100, { rate: 0.06, mediaType: "TEXT_ONLY" }),
            ...block(6, { rate: 0.03, mediaType: "LINK" }),
        ]);

        const analysis = findGaps([principal, peer("PeerA"), peer("PeerB")])!;
        expect(analysis.overInvested.filter((o) => o.key.dimension === "FORMAT")).toHaveLength(0);
    });
});

// ── Themes ───────────────────────────────────────────────────────────────

describe("themes", () => {
    const peerWithTheme = (name: string) =>
        corpus(name, "COMPETITOR", [
            ...block(10, { rate: 0.02, theme: "POLICY_ANNOUNCEMENT" }),
            ...block(6, { rate: 0.06, theme: "CONSTITUENCY_VISIT" }),
        ]);

    it("reports its own absence when nothing has been classified yet", () => {
        // The corpus is 100% unclassified today, and an empty gaps array would
        // otherwise read as "no theme gaps exist".
        const analysis = findGaps([
            corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03 })),
            corpus("PeerA", "COMPETITOR", block(20, { rate: 0.03 })),
            corpus("PeerB", "COMPETITOR", block(20, { rate: 0.03 })),
        ])!;

        expect(analysis.notes.join(" ")).toContain("Theme gaps unavailable");
    });

    it("flags a partially classified corpus as provisional rather than reporting it flat", () => {
        // Classification runs newest-first, so a half-finished pass covers the
        // most RECENT posts — the subset most likely to differ from the 90-day
        // average. A theme finding drawn from it is a finding about the last few
        // weeks wearing a 90-day label, and the reader has to be told.
        const analysis = findGaps([
            corpus("Tharoor", "PRINCIPAL", [
                ...block(10, { rate: 0.03, theme: "POLICY_ANNOUNCEMENT" }),
                ...block(10, { rate: 0.03, theme: null }),
            ]),
            peerWithTheme("PeerA"),
            peerWithTheme("PeerB"),
        ])!;

        const notes = analysis.notes.join(" ");
        expect(notes).toContain("Theme gaps cover");
        expect(notes).toContain("skews recent");
        expect(notes).not.toContain("Theme gaps unavailable");
    });

    it("says nothing about coverage once every post is classified", () => {
        const analysis = findGaps([
            corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, theme: "POLICY_ANNOUNCEMENT" })),
            peerWithTheme("PeerA"),
            peerWithTheme("PeerB"),
        ])!;

        expect(analysis.notes.join(" ")).not.toContain("Theme gaps cover");
    });

    it("finds a theme the principal does not cover once classification has run", () => {
        const analysis = findGaps([
            corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, theme: "POLICY_ANNOUNCEMENT" })),
            peerWithTheme("PeerA"),
            peerWithTheme("PeerB"),
        ])!;

        const theme = analysis.gaps.find((g) => g.key.dimension === "THEME")!;
        expect(theme.key).toEqual({ dimension: "THEME", theme: "CONSTITUENCY_VISIT" });
        expect(theme.kind).toBe("ABSENT");
        expect(analysis.notes.join(" ")).not.toContain("Theme gaps unavailable");
    });

    it("leaves an unclassified post out of the theme dimension rather than calling it OTHER", () => {
        // A null theme means "we could not tell", and bucketing it as OTHER
        // would produce a finding about a category that means nothing.
        const analysis = findGaps([
            corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, theme: null })),
            peerWithTheme("PeerA"),
            peerWithTheme("PeerB"),
        ])!;

        expect(analysis.gaps.some((g) => g.key.dimension === "THEME" && g.key.theme === "OTHER")).toBe(false);
    });
});

// ── Hour windows ─────────────────────────────────────────────────────────

describe("mergeHourWindows", () => {
    const principal = () => corpus("Tharoor", "PRINCIPAL", block(20, { rate: 0.03, hour: 10 }));

    const peerAcross = (name: string, hours: number[]) =>
        corpus(name, "COMPETITOR", [
            ...block(20, { rate: 0.02, hour: 10 }),
            ...hours.flatMap((h) => block(6, { rate: 0.06, hour: h })),
        ]);

    it("collapses contiguous hours into one schedulable window", () => {
        const analysis = findGaps([principal(), peerAcross("PeerA", [19, 20, 21]), peerAcross("PeerB", [19, 20, 21])])!;
        const windows = mergeHourWindows(analysis.gaps);

        expect(windows).toHaveLength(1);
        expect(windows[0]).toMatchObject({ startHour: 19, endHour: 21, label: "19:00–21:59", principalAbsent: true });
        expect(windows[0].hours).toHaveLength(3);
    });

    it("keeps non-adjacent hours as separate windows", () => {
        const analysis = findGaps([principal(), peerAcross("PeerA", [8, 19, 20]), peerAcross("PeerB", [8, 19, 20])])!;
        const windows = mergeHourWindows(analysis.gaps);

        expect(windows.map((w) => w.label).sort()).toEqual(["08:00", "19:00–20:59"]);
    });

    it("does not merge across midnight", () => {
        // 23:00 and 00:00 are adjacent on a clock and not adjacent as an
        // instruction — "post between 23:00 and 00:59" is a different ask, and
        // nothing in the corpus justifies inferring it.
        const analysis = findGaps([principal(), peerAcross("PeerA", [23, 0]), peerAcross("PeerB", [23, 0])])!;
        const windows = mergeHourWindows(analysis.gaps);

        expect(windows.map((w) => w.label).sort()).toEqual(["00:00", "23:00"]);
    });
});

// ── The basis guard ──────────────────────────────────────────────────────

describe("the basis guard applies here too", () => {
    it("throws rather than comparing a views-normalised gap against a followers-normalised one", () => {
        expect(() =>
            findGaps([
                corpus("Tharoor", "PRINCIPAL", block(10, { rate: 0.03, basis: "VIEWS" })),
                corpus("PeerA", "COMPETITOR", block(10, { rate: 0.3, basis: "FOLLOWERS" })),
            ]),
        ).toThrow(MixedBasisError);
    });

    it("findGapsByBasis splits a mixed corpus into one analysis per basis instead", () => {
        const mixed = (name: string, role: "PRINCIPAL" | "COMPETITOR", viewRate: number, followerRate: number) =>
            corpus(name, role, [
                ...block(10, { rate: viewRate, hour: 10, basis: "VIEWS" }),
                ...block(6, { rate: viewRate * 3, hour: 19, basis: "VIEWS" }),
                ...block(10, { rate: followerRate, hour: 10, basis: "FOLLOWERS" }),
            ]);

        const byBasis = findGapsByBasis([
            corpus("Tharoor", "PRINCIPAL", [
                ...block(20, { rate: 0.03, hour: 10, basis: "VIEWS" }),
                ...block(20, { rate: 0.3, hour: 10, basis: "FOLLOWERS" }),
            ]),
            mixed("PeerA", "COMPETITOR", 0.02, 0.2),
            mixed("PeerB", "COMPETITOR", 0.02, 0.2),
        ]);

        expect(byBasis.VIEWS!.basis).toBe("VIEWS");
        expect(byBasis.FOLLOWERS!.basis).toBe("FOLLOWERS");
        // The evening lift exists only on the views side of the corpus.
        expect(byBasis.VIEWS!.gaps.some((g) => g.key.dimension === "HOUR" && g.key.hour === 19)).toBe(true);
        expect(byBasis.FOLLOWERS!.gaps).toHaveLength(0);
    });
});

// ── No-data cases ────────────────────────────────────────────────────────

describe("no-data cases return null or a note, never a fabricated finding", () => {
    it("returns null with no rated posts at all", () => {
        expect(findGaps([corpus("Tharoor", "PRINCIPAL", [])])).toBeNull();
    });

    it("returns null when there is no principal to find gaps for", () => {
        expect(findGaps([corpus("PeerA", "COMPETITOR", block(10, { rate: 0.03 }))])).toBeNull();
    });

    it("says why rather than returning an empty list when there are no peers", () => {
        const analysis = findGaps([corpus("Tharoor", "PRINCIPAL", block(10, { rate: 0.03 }))])!;

        expect(analysis.gaps).toHaveLength(0);
        expect(analysis.notes.join(" ")).toContain("at least one competitor");
    });
});
