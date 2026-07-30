// Comparison is where the brief's warning bites hardest: benchmarking accounts
// with unequal audiences. The peer set spans 0.9M to 1.8M followers, so any
// figure derived from raw counts measures audience size and calls it
// performance. Everything here runs on the normalised rate.
//
// The second theme is provenance. YouTube in this project holds three live
// accounts and one seeded one, so a real comparison can span both. That is
// flagged, not refused — and the distinction between "flagged" and "refused" is
// itself tested, because it is a deliberate design line:
//
//   mixing BASES      → arithmetic error   → throws
//   mixing PROVENANCE → validity caveat    → reported on the result

import { describe, expect, it } from "vitest";
import { MixedBasisError, type EngagementBasis, type EngagementPost, type RatedPost } from "../analytics/engagement";
import {
    compareAccounts,
    compareAccountsByBasis,
    describeComparison,
    MIN_COMPARE_N,
    type AccountCorpus,
} from "../analytics/compare";

function rated(rate: number, basis: EngagementBasis = "VIEWS"): RatedPost<EngagementPost> {
    return {
        post: {
            platform: "YOUTUBE",
            mediaType: "LONG_FORM_VIDEO",
            likes: null,
            comments: null,
            shares: null,
            views: null,
            saves: null,
        },
        engagement: { interactions: rate * 10_000, denominator: 10_000, basis, rate },
    };
}

function corpus(
    personName: string,
    role: "PRINCIPAL" | "COMPETITOR",
    rates: number[],
    options: { isSynthetic?: boolean; basis?: EngagementBasis } = {},
): AccountCorpus<EngagementPost> {
    return {
        accountId: `acc_${personName}`,
        personName,
        role,
        platform: "YOUTUBE",
        handle: personName.toLowerCase(),
        isSynthetic: options.isSynthetic ?? false,
        rated: rates.map((r) => rated(r, options.basis)),
    };
}

const five = (rate: number) => Array(MIN_COMPARE_N).fill(rate);

describe("compareAccounts — never ranks on audience size", () => {
    it("places a smaller account above the principal when its rate is higher", () => {
        // The brief's central warning. The principal here would win on every raw
        // count; on the normalised rate it comes second.
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.02)),
            corpus("Kanhaiya", "COMPETITOR", five(0.05)),
        ])!;

        expect(comparison.principalRank).toBe(2);
        expect(comparison.rankedOutOf).toBe(2);
        expect(comparison.peers[0].personName).toBe("Kanhaiya");
    });

    it("benchmarks against the MEDIAN peer, so one dominant competitor cannot drag it", () => {
        // Peer medians 0.02, 0.03, 0.40 → benchmark 0.03, not the 0.15 mean.
        // Without this, a single outlier peer makes every principal look terrible.
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03)),
            corpus("PeerA", "COMPETITOR", five(0.02)),
            corpus("PeerB", "COMPETITOR", five(0.03)),
            corpus("PeerC", "COMPETITOR", five(0.4)),
        ])!;

        expect(comparison.peerBenchmark).toBeCloseTo(0.03, 12);
        expect(comparison.principalVsPeers).toBeCloseTo(1, 12);
    });

    it("expresses the principal as a multiple of the peer benchmark", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.06)),
            corpus("PeerA", "COMPETITOR", five(0.02)),
            corpus("PeerB", "COMPETITOR", five(0.04)),
        ])!;

        // Peer medians 0.02 and 0.04 → benchmark 0.03. Principal 0.06 → 2×.
        expect(comparison.peerBenchmark).toBeCloseTo(0.03, 12);
        expect(comparison.principalVsPeers).toBeCloseTo(2, 12);
        expect(comparison.principalRank).toBe(1);
    });

    it("ranks on the median, so one viral post cannot promote an account", () => {
        // PeerA's mean is dragged up by a single spike; its median is not.
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", [0.05, 0.05, 0.05, 0.05, 0.05]),
            corpus("PeerA", "COMPETITOR", [0.01, 0.01, 0.01, 0.01, 1.0]),
        ])!;

        expect(comparison.principalRank).toBe(1);
        expect(comparison.peers[0].distribution.mean).toBeGreaterThan(comparison.principal!.distribution.mean);
    });
});

describe("compareAccounts — sample-size exclusion", () => {
    it("excludes an account below MIN_COMPARE_N and names the reason", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03)),
            corpus("PeerA", "COMPETITOR", five(0.02)),
            corpus("Thin", "COMPETITOR", [0.9, 0.9]),
        ])!;

        expect(comparison.peers.map((p) => p.personName)).toEqual(["PeerA"]);
        expect(comparison.excluded).toEqual([
            { accountId: "acc_Thin", personName: "Thin", platform: "YOUTUBE", n: 2, reason: "INSUFFICIENT_POSTS" },
        ]);
    });

    it("distinguishes 'no rated posts' from 'too few rated posts'", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03)),
            corpus("Silent", "COMPETITOR", []),
        ])!;

        expect(comparison.excluded[0].reason).toBe("NO_RATED_POSTS");
    });

    it("returns a null principal rather than a comparison against nothing", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", [0.03, 0.03]),
            corpus("PeerA", "COMPETITOR", five(0.02)),
        ])!;

        expect(comparison.principal).toBeNull();
        expect(comparison.principalVsPeers).toBeNull();
        expect(describeComparison(comparison)).toMatch(/fewer than 5 rated posts/);
    });
});

describe("compareAccounts — provenance is reported, not averaged away", () => {
    it("flags a comparison that spans live and seeded accounts", () => {
        // The real YouTube case: three tracked people have a verified channel,
        // the fourth does not. This must not silently read as an all-live result.
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03), { isSynthetic: false }),
            corpus("Chaturvedi", "COMPETITOR", five(0.04), { isSynthetic: false }),
            corpus("VarunGandhi", "COMPETITOR", five(0.05), { isSynthetic: true }),
        ])!;

        expect(comparison.provenance.mixed).toBe(true);
        expect(comparison.provenance.syntheticAccounts).toEqual(["VarunGandhi"]);
        expect(comparison.provenance.liveAccounts).toEqual(expect.arrayContaining(["Tharoor", "Chaturvedi"]));
    });

    it("does not flag a uniformly live comparison", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03)),
            corpus("PeerA", "COMPETITOR", five(0.04)),
        ])!;

        expect(comparison.provenance.mixed).toBe(false);
    });

    it("does not flag a uniformly seeded comparison — it is consistent, if synthetic", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03), { isSynthetic: true }),
            corpus("PeerA", "COMPETITOR", five(0.04), { isSynthetic: true }),
        ])!;

        expect(comparison.provenance.mixed).toBe(false);
        expect(comparison.provenance.liveAccounts).toEqual([]);
    });

    it("REPORTS mixed provenance but THROWS on mixed basis — the design line", () => {
        // Two different kinds of problem, handled two different ways on purpose.
        // A mixed basis yields a meaningless number; mixed provenance yields a
        // real number about a partly-invented world, and the reader is told.
        const mixedProvenance = [
            corpus("Tharoor", "PRINCIPAL", five(0.03), { isSynthetic: false }),
            corpus("PeerA", "COMPETITOR", five(0.04), { isSynthetic: true }),
        ];
        expect(() => compareAccounts(mixedProvenance)).not.toThrow();

        const mixedBasis = [
            corpus("Tharoor", "PRINCIPAL", five(0.03), { basis: "VIEWS" }),
            corpus("PeerA", "COMPETITOR", five(0.004), { basis: "FOLLOWERS" }),
        ];
        expect(() => compareAccounts(mixedBasis, "compare: mixed basis")).toThrow(MixedBasisError);
    });
});

describe("compareAccountsByBasis", () => {
    it("splits a cross-platform set into one comparison per basis", () => {
        const corpora: AccountCorpus<EngagementPost>[] = [
            {
                ...corpus("Tharoor", "PRINCIPAL", []),
                rated: [...five(0.03).map((r) => rated(r, "VIEWS")), ...five(0.002).map((r) => rated(r, "FOLLOWERS"))],
            },
            {
                ...corpus("PeerA", "COMPETITOR", []),
                rated: [...five(0.05).map((r) => rated(r, "VIEWS")), ...five(0.001).map((r) => rated(r, "FOLLOWERS"))],
            },
        ];

        const panels = compareAccountsByBasis(corpora);

        expect(panels.VIEWS!.basis).toBe("VIEWS");
        expect(panels.VIEWS!.principalRank).toBe(2); // 0.03 behind 0.05
        expect(panels.FOLLOWERS!.basis).toBe("FOLLOWERS");
        expect(panels.FOLLOWERS!.principalRank).toBe(1); // 0.002 ahead of 0.001
    });

    it("omits an account from a panel it has no posts on, rather than excluding it as empty", () => {
        // A YouTube-only competitor should not appear as "NO_RATED_POSTS" in the
        // followers panel — that is noise, not information.
        const corpora: AccountCorpus<EngagementPost>[] = [
            { ...corpus("Tharoor", "PRINCIPAL", []), rated: five(0.03).map((r) => rated(r, "VIEWS")) },
            { ...corpus("PeerA", "COMPETITOR", []), rated: five(0.05).map((r) => rated(r, "VIEWS")) },
        ];

        const panels = compareAccountsByBasis(corpora);

        expect(panels.VIEWS!.excluded).toEqual([]);
        expect(panels.FOLLOWERS).toBeNull();
    });
});

describe("describeComparison", () => {
    it("states rank, multiple, direction and sample size in one sentence", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.06)),
            corpus("PeerA", "COMPETITOR", five(0.02)),
            corpus("PeerB", "COMPETITOR", five(0.04)),
        ])!;

        const sentence = describeComparison(comparison);

        expect(sentence).toMatch(/ranks 1 of 3/);
        expect(sentence).toMatch(/2\.00× ahead of/);
        expect(sentence).toMatch(/across 5 posts/);
    });

    it("inverts the multiple when the principal is behind, so it never reads as 0.50× ahead", () => {
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.02)),
            corpus("PeerA", "COMPETITOR", five(0.04)),
            corpus("PeerB", "COMPETITOR", five(0.04)),
        ])!;

        expect(describeComparison(comparison)).toMatch(/2\.00× behind/);
    });

    it("attaches the seeded caveat to the sentence itself, not only to the object", () => {
        // The sentence travels into the Markdown export and the AI prompt. A flag
        // that only exists on the object would be lost in both.
        const comparison = compareAccounts([
            corpus("Tharoor", "PRINCIPAL", five(0.03), { isSynthetic: false }),
            corpus("PeerA", "COMPETITOR", five(0.02), { isSynthetic: true }),
        ])!;

        expect(describeComparison(comparison)).toMatch(/mixes live and seeded accounts.*PeerA/);
    });
});
