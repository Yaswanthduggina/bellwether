// Cadence has one trap and it is the whole module: "posts per week" is a
// division, and getting the DENOMINATOR from the corpus instead of from an
// explicit window inverts the answer. An account with two posts three days
// apart would score 4.7 posts/week — higher than an account posting daily —
// because its span collapses to the days it happened to be active.
//
// The first test in this file is that trap. The rest are the distinction the
// module exists to preserve: volume and regularity are different questions, and
// an account can need "post more" or "post on a schedule" independently.

import { describe, expect, it } from "vitest";
import {
    analyseCadence,
    cadenceMatrix,
    compareCadence,
    describeCadence,
    windowSpanning,
    type CadenceCorpus,
    type CadencePost,
    type CadenceWindow,
    type PlatformCadenceCorpus,
} from "../analytics/cadence";

const IST = "Asia/Kolkata";

/** A 28-day window — exactly four 7-day blocks, so every expectation is exact. */
const WINDOW: CadenceWindow = {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-01-29T00:00:00.000Z"),
};

/** Day `n` of the window (0-indexed) at `hour` UTC. */
function day(n: number, hour = 12): Date {
    return new Date(Date.UTC(2026, 0, 1 + n, hour));
}

function corpus(
    personName: string,
    role: "PRINCIPAL" | "COMPETITOR",
    dates: Date[],
    options: { timezone?: string; isSynthetic?: boolean } = {},
): CadenceCorpus<CadencePost> {
    return {
        accountId: `acc_${personName}`,
        personName,
        role,
        handle: personName.toLowerCase(),
        isSynthetic: options.isSynthetic ?? false,
        timezone: options.timezone ?? IST,
        posts: dates.map((postedAt) => ({ postedAt })),
    };
}

describe("the window is the denominator, not the corpus", () => {
    it("does not credit a two-post account with a heavy cadence", () => {
        // Two posts three days apart. Measured against their own span they would
        // score 4.67/week — busier than an account posting every single day.
        // Measured against the 28-day window they score 0.5/week, which is true.
        const quiet = analyseCadence(corpus("Quiet", "PRINCIPAL", [day(10), day(13)]), WINDOW);

        expect(quiet.posts).toBe(2);
        expect(quiet.windowDays).toBe(28);
        expect(quiet.postsPerWeek).toBeCloseTo(0.5, 12);
    });

    it("gives every account in one comparison the same denominator", () => {
        // Busy spans the whole window; Quiet is active for three days of it.
        // A per-account span would hand Quiet the higher rate.
        const comparison = compareCadence(
            [
                corpus("Busy", "PRINCIPAL", Array.from({ length: 28 }, (_, i) => day(i))),
                corpus("Quiet", "COMPETITOR", [day(10), day(13)]),
            ],
            WINDOW,
        )!;

        expect(comparison.principal!.postsPerWeek).toBeCloseTo(7, 12);
        expect(comparison.peers[0].postsPerWeek).toBeCloseTo(0.5, 12);
        expect(comparison.principal!.windowDays).toBe(comparison.peers[0].windowDays);
    });

    it("derives one shared window from the union when none is given", () => {
        const span = windowSpanning([
            corpus("A", "PRINCIPAL", [day(5), day(10)]),
            corpus("B", "COMPETITOR", [day(2), day(20)]),
        ])!;

        expect(span.from).toEqual(day(2));
        expect(span.to).toEqual(day(20));
    });

    it("ignores posts outside the window rather than trusting the caller", () => {
        // A caller that queried 90 days and then asked about 28 must not get a
        // rate computed from posts the window excludes.
        const stats = analyseCadence(
            corpus("A", "PRINCIPAL", [new Date("2025-12-01T12:00:00Z"), day(5), new Date("2026-03-01T12:00:00Z")]),
            WINDOW,
        );

        expect(stats.posts).toBe(1);
    });
});

describe("volume and regularity are separate findings", () => {
    // Both accounts post exactly 8 times in the same 28-day window. Their
    // posts-per-week is identical and their operations are not.
    const steady = corpus(
        "Steady",
        "PRINCIPAL",
        [0, 3, 7, 10, 14, 17, 21, 24].map((n) => day(n)),
    );
    const bursty = corpus(
        "Bursty",
        "COMPETITOR",
        [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((n) => day(Math.floor(n), 8 + Math.round((n % 1) * 10))),
    );

    it("reports the same volume for both", () => {
        expect(analyseCadence(steady, WINDOW).postsPerWeek).toBeCloseTo(2, 12);
        expect(analyseCadence(bursty, WINDOW).postsPerWeek).toBeCloseTo(2, 12);
    });

    it("separates them on consistency", () => {
        // Steady touches all four 7-day blocks; Bursty spends itself in the first.
        expect(analyseCadence(steady, WINDOW).consistency).toBeCloseTo(1, 12);
        expect(analyseCadence(bursty, WINDOW).consistency).toBeCloseTo(0.25, 12);
    });

    it("leads with the MEDIAN gap, which the mean would hide", () => {
        const stats = analyseCadence(bursty, WINDOW)!;

        // Seven gaps of about an hour. The typical wait between Bursty's posts
        // is an hour — and the account is silent for the other 27 days, which is
        // what longestSilenceDays is for rather than the mean gap.
        expect(stats.gapHours!.median).toBeLessThan(2);
        expect(stats.daysSinceLastPost).toBeGreaterThan(27);
    });

    it("reports the longest silence in days", () => {
        const stats = analyseCadence(corpus("Gappy", "PRINCIPAL", [day(0), day(1), day(15), day(16)]), WINDOW);

        expect(stats.longestSilenceDays).toBeCloseTo(14, 6);
    });
});

describe("burst detection reads local calendar days", () => {
    it("counts 23:00 and 01:00 IST as two days, not one", () => {
        // Both instants land on 5 Jan in UTC (17:30 and 19:30) and on 5 and 6
        // Jan in IST. The account posted once on each of two days.
        const stats = analyseCadence(
            corpus("A", "PRINCIPAL", [
                new Date("2026-01-05T17:30:00.000Z"), // 23:00 IST, 5 Jan
                new Date("2026-01-05T19:30:00.000Z"), // 01:00 IST, 6 Jan
            ]),
            WINDOW,
        );

        expect(stats.maxPostsInOneDay).toBe(1);
    });

    it("still catches a genuine burst inside one local day", () => {
        const stats = analyseCadence(
            corpus("A", "PRINCIPAL", [day(5, 6), day(5, 8), day(5, 10), day(12, 6)]),
            WINDOW,
        );

        expect(stats.maxPostsInOneDay).toBe(3);
    });

    it("honours the account's own zone", () => {
        // The same two instants, read in UTC, ARE the same calendar day.
        const stats = analyseCadence(
            corpus(
                "A",
                "PRINCIPAL",
                [new Date("2026-01-05T17:30:00.000Z"), new Date("2026-01-05T19:30:00.000Z")],
                { timezone: "UTC" },
            ),
            WINDOW,
        );

        expect(stats.maxPostsInOneDay).toBe(2);
    });
});

describe("degenerate inputs", () => {
    it("reports an account that posted nothing as zero, not NaN", () => {
        const stats = analyseCadence(corpus("Silent", "PRINCIPAL", []), WINDOW);

        expect(stats).toMatchObject({
            posts: 0,
            postsPerWeek: 0,
            consistency: 0,
            gapHours: null,
            longestSilenceDays: null,
            daysSinceLastPost: null,
            maxPostsInOneDay: 0,
        });
    });

    it("has no gap distribution from a single post", () => {
        // One post is not an interval. Reporting 0 would claim it posts constantly.
        expect(analyseCadence(corpus("One", "PRINCIPAL", [day(5)]), WINDOW).gapHours).toBeNull();
    });

    it("survives a zero-length window without dividing by zero", () => {
        const instant = day(5);
        const stats = analyseCadence(corpus("A", "PRINCIPAL", [instant]), { from: instant, to: instant });

        expect(Number.isFinite(stats.postsPerWeek)).toBe(true);
    });

    it("returns null when there is nothing to derive a window from", () => {
        expect(compareCadence([corpus("A", "PRINCIPAL", [])])).toBeNull();
    });
});

describe("compareCadence", () => {
    const principal = corpus(
        "Tharoor",
        "PRINCIPAL",
        [0, 7, 14, 21].map((n) => day(n)),
    ); // 1.0/week

    it("benchmarks against the MEDIAN peer, not the mean", () => {
        // Peer rates 2, 3, 20 per week. The median is 3; the mean is 8.33 and
        // would make the principal look eight times worse than he is.
        const comparison = compareCadence(
            [
                principal,
                corpus("A", "COMPETITOR", Array.from({ length: 8 }, (_, i) => day(i * 3))),
                corpus("B", "COMPETITOR", Array.from({ length: 12 }, (_, i) => day(i * 2))),
                corpus("C", "COMPETITOR", Array.from({ length: 80 }, (_, i) => day(i % 28, i % 24))),
            ],
            WINDOW,
        )!;

        expect(comparison.peerBenchmark).toBeCloseTo(3, 12);
        expect(comparison.principalVsPeers).toBeCloseTo(1 / 3, 12);
    });

    it("does not suppress a thin account the way the rate modules do", () => {
        // There is no sample-size problem here. An account that posted twice in
        // 90 days has not given a thin estimate of its posting rate — it has
        // stated it exactly, and it is the most actionable finding available.
        const comparison = compareCadence([principal, corpus("Quiet", "COMPETITOR", [day(3), day(9)])], WINDOW)!;

        expect(comparison.peers[0].posts).toBe(2);
        expect(comparison.peers[0].postsPerWeek).toBeCloseTo(0.5, 12);
    });

    it("says volume and regularity in one sentence without collapsing them", () => {
        const comparison = compareCadence(
            [principal, corpus("A", "COMPETITOR", Array.from({ length: 8 }, (_, i) => day(i * 3)))],
            WINDOW,
        )!;

        const sentence = describeCadence(comparison);
        expect(sentence).toContain("1.0×/week");
        expect(sentence).toContain("2.0×/week");
        expect(sentence).toContain("% of weeks");
    });
});

// ── Truncated histories ──────────────────────────────────────────────────

describe("A COUNT-CAPPED CORPUS PRODUCES A MANUFACTURED CADENCE FINDING", () => {
    // The failure that added `comparable`, reproduced from the X ingest that
    // caused it. Every account was capped at the same NUMBER of posts, but the
    // accounts post at very different rates, so the same count bought very
    // different spans of history. Divided by one shared window, they all came out
    // identical — and "he posts exactly as often as his peers" is a finding, not
    // a null result.

    /** `n` posts, evenly spaced, ending on the last day of the window. */
    function lastNDays(n: number, spanDays: number): Date[] {
        const step = spanDays / n;
        return Array.from({ length: n }, (_, i) => day(28 - spanDays + i * step));
    }

    // 40 posts each. The principal is prolific, so 40 posts is the last 7 days of
    // him; the peers are slower, so 40 posts reaches back across the whole window.
    const cappedPrincipal = corpus("Principal", "PRINCIPAL", lastNDays(40, 7));
    const fullPeerA = corpus("PeerA", "COMPETITOR", lastNDays(40, 28));
    const fullPeerB = corpus("PeerB", "COMPETITOR", lastNDays(40, 28));

    it("would otherwise report the principal and the peers as identical", () => {
        // The arithmetic that made the false finding. Same posts, same window,
        // therefore same rate — measuring the cap rather than the accounts.
        const comparison = compareCadence([cappedPrincipal, fullPeerA, fullPeerB], WINDOW)!;

        expect(comparison.principal!.posts).toBe(40);
        expect(comparison.peers[0]!.posts).toBe(40);
        expect(comparison.principal!.postsPerWeek).toBeCloseTo(comparison.peers[0]!.postsPerWeek, 5);
    });

    it("withholds the comparison instead of publishing 1.00x", () => {
        const comparison = compareCadence([cappedPrincipal, fullPeerA, fullPeerB], WINDOW)!;

        expect(comparison.comparable).toBe(false);
        expect(comparison.truncatedAccounts).toEqual(["Principal"]);
        expect(comparison.principalVsPeers).toBeNull();
        expect(comparison.peerBenchmark).toBeNull();
        // Consistency was the worse of the two: blocks that predate anything we
        // fetched read as weeks the account chose not to post in.
        expect(comparison.peerConsistency).toBeNull();
    });

    it("says why, rather than going quiet", () => {
        const sentence = describeCadence(compareCadence([cappedPrincipal, fullPeerA, fullPeerB], WINDOW)!);

        expect(sentence).toMatch(/withheld/);
        expect(sentence).toMatch(/Principal/);
        expect(sentence).toMatch(/result cap/);
        // And it must not quote the rate it just refused to compare.
        expect(sentence).not.toMatch(/×\/week/);
    });

    it("still compares accounts whose histories all cover the window", () => {
        // The guard must not fire on ordinary data, or it suppresses the module.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", lastNDays(20, 28)),
            fullPeerA,
            fullPeerB,
        ], WINDOW)!;

        expect(comparison.comparable).toBe(true);
        expect(comparison.truncatedAccounts).toEqual([]);
        expect(comparison.principalVsPeers).toBeCloseTo(0.5, 5);
    });

    it("treats an account with no posts as silent, not as truncated", () => {
        // A genuinely dark account is the most actionable finding cadence can
        // produce. Suppressing the comparison for it would hide exactly that.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", lastNDays(20, 28)),
            fullPeerA,
            corpus("Silent", "COMPETITOR", []),
        ], WINDOW)!;

        expect(comparison.comparable).toBe(true);
        expect(comparison.peers.find((p) => p.personName === "Silent")!.postsPerWeek).toBe(0);
    });
});

describe("NARROWING TO THE WINDOW EVERY ACCOUNT ACTUALLY COVERS", () => {
    // The other half of the count-cap story. Withholding the comparison is
    // correct but it is not free: the panel goes blank on the one platform whose
    // ingestion is capped, and a blank panel reads as a broken pipeline rather
    // than as a refusal. Where every account's history is complete from some
    // later date, there IS a shared denominator — it is just a shorter one, and
    // measuring over it is honest in a way that dividing by the union is not.
    //
    // The fallback fires only when the caller left the window unspecified. A
    // named window is a question about a period, and answering a different one
    // quietly is worse than answering nothing.

    /** Every day from `from` to day 28 inclusive. */
    function daily(from: number): Date[] {
        return Array.from({ length: 29 - from }, (_, i) => day(from + i));
    }

    /** Every other day from `from` to day 28. */
    function alternate(from: number): Date[] {
        const dates: Date[] = [];
        for (let n = from; n <= 28; n += 2) dates.push(day(n));
        return dates;
    }

    it("re-runs the comparison over the covered span instead of withholding it", () => {
        // Principal capped to the last 20 days; peers reach back to day 0. The
        // union window is 28 days and nobody can be compared over it.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", daily(8)),
            corpus("PeerA", "COMPETITOR", alternate(0)),
            corpus("PeerB", "COMPETITOR", alternate(0)),
        ])!;

        expect(comparison.comparable).toBe(true);
        expect(comparison.truncatedAccounts).toEqual([]);
        expect(comparison.narrowed).not.toBeNull();
        expect(comparison.narrowed!.accounts).toEqual(["Principal"]);
        expect(Math.round(comparison.narrowed!.requestedDays)).toBe(28);
        expect(Math.round(comparison.narrowed!.days)).toBe(20);
        // The window starts where the principal's history does, not where the
        // peers' does — that is the whole point of the narrowing.
        expect(comparison.window.from.getTime()).toBe(day(8).getTime());

        // And the finding it recovers is a real one: 21 posts in 20 days against
        // peers posting on alternate days is roughly double, not the 1.00x the
        // union window manufactures.
        expect(comparison.principalVsPeers).toBeGreaterThan(1.8);
        expect(comparison.principalVsPeers).toBeLessThan(2.2);
    });

    it("states the shortened denominator before quoting any rate", () => {
        const sentence = describeCadence(
            compareCadence([
                corpus("Principal", "PRINCIPAL", daily(8)),
                corpus("PeerA", "COMPETITOR", alternate(0)),
                corpus("PeerB", "COMPETITOR", alternate(0)),
            ])!,
        );

        // Leading, not trailing: a reader who meets the denominator after the
        // numbers has already read them as covering the full period.
        expect(sentence).toMatch(/^Measured over the last 20 days rather than 28/);
        expect(sentence).toMatch(/Principal/);
        // Consistency over three blocks is not evidence, and the sentence that
        // quotes it has to say so.
        expect(sentence).toMatch(/weak evidence/);
    });

    it("refuses to narrow below two weekly blocks", () => {
        // An 8-day window would buy a posts-per-week figure at the price of a
        // consistency figure that reads 100% for anyone who posted at all.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", daily(20)),
            corpus("PeerA", "COMPETITOR", alternate(0)),
            corpus("PeerB", "COMPETITOR", alternate(0)),
        ])!;

        expect(comparison.comparable).toBe(false);
        expect(comparison.narrowed).toBeNull();
        expect(comparison.principalVsPeers).toBeNull();
        expect(Math.round((comparison.window.to.getTime() - comparison.window.from.getTime()) / 86_400_000)).toBe(28);
    });

    it("does not narrow a window the caller named", () => {
        const comparison = compareCadence(
            [
                corpus("Principal", "PRINCIPAL", daily(8)),
                corpus("PeerA", "COMPETITOR", alternate(0)),
                corpus("PeerB", "COMPETITOR", alternate(0)),
            ],
            WINDOW,
        )!;

        expect(comparison.comparable).toBe(false);
        expect(comparison.narrowed).toBeNull();
        expect(comparison.narrowingTried).toBe(false);
        // ...and the sentence must not claim a fallback it never attempted.
        expect(describeCadence(comparison)).not.toMatch(/Narrowing/);
    });

    it("keeps withholding when the shorter window is still not comparable", () => {
        // A peer silent through the start of the covered span is a real finding
        // about that peer, not a coverage artefact — and it means there is no
        // shared denominator at any length. The result reverts to the window
        // that was asked for, so the blanks are never paired with a window
        // nobody was measured over.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", daily(8)),
            corpus("PeerA", "COMPETITOR", alternate(0)),
            corpus("Quiet", "COMPETITOR", [day(0), day(26), day(27), day(28)]),
        ])!;

        expect(comparison.comparable).toBe(false);
        expect(comparison.narrowed).toBeNull();
        expect(comparison.narrowingTried).toBe(true);
        expect(comparison.window.from.getTime()).toBe(day(0).getTime());
        expect(describeCadence(comparison)).toMatch(/Narrowing to the span every account covers was tried/);
    });

    it("lets a silent account stay in the comparison rather than collapse the window", () => {
        // An account with no posts has no history to be missing. Letting it set
        // the window would hand the quietest account the denominator.
        const comparison = compareCadence([
            corpus("Principal", "PRINCIPAL", daily(8)),
            corpus("PeerA", "COMPETITOR", alternate(0)),
            corpus("Silent", "COMPETITOR", []),
        ])!;

        expect(comparison.comparable).toBe(true);
        expect(Math.round(comparison.narrowed!.days)).toBe(20);
        expect(comparison.peers.find((p) => p.personName === "Silent")!.postsPerWeek).toBe(0);
    });
});

describe("the matrix: one comparison per platform, never one across them", () => {
    /** Every day from `from` to day 28 inclusive. */
    function daily(from: number): Date[] {
        return Array.from({ length: 29 - from }, (_, i) => day(from + i));
    }

    /** Every other day from `from` to day 28. */
    function alternate(from: number): Date[] {
        const dates: Date[] = [];
        for (let n = from; n <= 28; n += 2) dates.push(day(n));
        return dates;
    }

    function on(
        platform: string,
        personName: string,
        role: "PRINCIPAL" | "COMPETITOR",
        dates: Date[],
    ): PlatformCadenceCorpus<CadencePost> {
        return { ...corpus(personName, role, dates), accountId: `${platform}_${personName}`, platform };
    }

    it("keeps every platform the principal is on, instead of the first one found", () => {
        // THE BUG THIS FUNCTION EXISTS FOR. `compareOverWindow` picks the
        // principal with `stats.find`, so a single comparison over every corpus
        // at once reported ONE of the principal's platforms and dropped the
        // rest — silently, because the surviving number looked perfectly normal.
        const corpora = [
            on("YOUTUBE", "P", "PRINCIPAL", daily(0)),
            on("X", "P", "PRINCIPAL", [day(0), day(14)]),
            on("YOUTUBE", "Peer", "COMPETITOR", alternate(0)),
            on("X", "Peer", "COMPETITOR", alternate(0)),
        ];

        const blended = compareCadence(corpora)!;
        expect(blended.principal!.posts).toBe(29); // one platform, and only one

        const matrix = cadenceMatrix(corpora);
        const principal = matrix.rows.find((r) => r.role === "PRINCIPAL")!;
        expect(matrix.platforms).toEqual(["X", "YOUTUBE"]);
        expect(principal.cells["YOUTUBE"]!.posts).toBe(29);
        expect(principal.cells["X"]!.posts).toBe(2);
    });

    it("measures each column over its own window", () => {
        // X spans 14 days here and YouTube 28. Sharing one window across the two
        // would divide the X column by a fortnight it has no data for.
        const matrix = cadenceMatrix([
            on("YOUTUBE", "P", "PRINCIPAL", daily(0)),
            on("X", "P", "PRINCIPAL", [day(0), day(7), day(14)]),
        ]);

        expect(matrix.windows["YOUTUBE"]!.days).toBeCloseTo(28, 6);
        expect(matrix.windows["X"]!.days).toBeCloseTo(14, 6);

        const principal = matrix.rows[0]!;
        expect(principal.cells["YOUTUBE"]!.postsPerWeek).toBeCloseTo((29 * 7) / 28, 6);
        expect(principal.cells["X"]!.postsPerWeek).toBeCloseTo((3 * 7) / 14, 6);
    });

    it("withholds a whole column when one account cannot cover its window", () => {
        // Every cell in the column is divided by the same window, so they are
        // all wrong in the same way — not just the cross-account figures.
        const matrix = cadenceMatrix([
            on("X", "P", "PRINCIPAL", daily(0)),
            on("X", "Late", "COMPETITOR", [day(27), day(28)]),
            on("YOUTUBE", "P", "PRINCIPAL", daily(0)),
            on("YOUTUBE", "Late", "COMPETITOR", alternate(0)),
        ]);

        expect(matrix.windows["X"]!.comparable).toBe(false);
        expect(matrix.windows["X"]!.truncatedAccounts).toContain("Late");
        expect(matrix.rows.every((r) => r.cells["X"]!.postsPerWeek === null)).toBe(true);
        // The post count survives — it is a fact about the account either way.
        expect(matrix.rows[0]!.cells["X"]!.posts).toBe(29);

        // The healthy column is untouched by its neighbour.
        expect(matrix.windows["YOUTUBE"]!.comparable).toBe(true);
        expect(matrix.rows[0]!.cells["YOUTUBE"]!.postsPerWeek).toBeGreaterThan(0);
    });

    it("leaves no cell where a person is not tracked on a platform", () => {
        // Absent, not zero. A 0.0/wk cell would claim the account exists and
        // posted nothing, which is a different and much stronger statement.
        const matrix = cadenceMatrix([
            on("X", "P", "PRINCIPAL", daily(0)),
            on("X", "Peer", "COMPETITOR", alternate(0)),
            on("YOUTUBE", "P", "PRINCIPAL", daily(0)),
        ]);

        const peer = matrix.rows.find((r) => r.personName === "Peer")!;
        expect(peer.cells["YOUTUBE"]).toBeUndefined();
        expect(peer.cells["X"]).toBeDefined();
    });

    it("drops a platform with no posts rather than showing an empty column", () => {
        const matrix = cadenceMatrix([
            on("X", "P", "PRINCIPAL", daily(0)),
            on("FACEBOOK", "P", "PRINCIPAL", []),
        ]);

        expect(matrix.platforms).toEqual(["X"]);
        expect(matrix.windows["FACEBOOK"]).toBeUndefined();
    });

    it("puts the principal first and holds the order steady", () => {
        const matrix = cadenceMatrix([
            on("X", "Zeta", "COMPETITOR", alternate(0)),
            on("X", "Alpha", "COMPETITOR", alternate(0)),
            on("X", "Modi", "PRINCIPAL", daily(0)),
        ]);

        expect(matrix.rows.map((r) => r.personName)).toEqual(["Modi", "Alpha", "Zeta"]);
    });
});
