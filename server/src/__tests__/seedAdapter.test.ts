// The seed corpus is not decoration — it is what the analytics engine is tested
// against on Day 2 and what the AI layer cites in the demo. These tests assert the
// three properties that make it useful: it is reproducible, it respects what each
// platform can actually publish, and the patterns planted in it are recoverable.
//
// If the last one ever fails, the format and timing analysis will "correctly" find
// nothing and the recommendations will be vacuous. That is the failure this file
// exists to catch.

import { describe, expect, it } from "vitest";
import { createSeedAdapter } from "../adapters/seedAdapter";

const SINCE = new Date(Date.now() - 90 * 86_400_000);
const HANDLES = ["tharoor", "chaturvedi", "varungandhi", "kanhaiyakumar"];

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}

describe("reproducibility", () => {
    // Seeded RNG, not Math.random(). Without this the demo numbers drift between
    // the README, the screen recording and whatever the reviewer sees.
    it("returns an identical corpus on repeated calls", async () => {
        const adapter = createSeedAdapter("INSTAGRAM");
        const first = await adapter.fetchPosts("tharoor", SINCE);
        const second = await adapter.fetchPosts("tharoor", SINCE);

        expect(second).toEqual(first);
    });

    it("keeps the follower count stable — it is the engagement-rate denominator", async () => {
        const a = await createSeedAdapter("X").fetchAccountMeta("tharoor");
        const b = await createSeedAdapter("X").fetchAccountMeta("tharoor");

        expect(b.followerCount).toBe(a.followerCount);
        expect(a.followerCount).toBeGreaterThan(0);
    });

    it("gives different accounts different corpora", async () => {
        const adapter = createSeedAdapter("INSTAGRAM");
        const one = await adapter.fetchPosts("tharoor", SINCE);
        const two = await adapter.fetchPosts("kanhaiyakumar", SINCE);

        expect(one[0]!.postId).not.toBe(two[0]!.postId);
        expect(one.length).not.toBe(two.length);
    });
});

describe("platform realism", () => {
    it("never puts carousels or text posts on YouTube", async () => {
        const posts = await createSeedAdapter("YOUTUBE").fetchPosts("tharoor", SINCE);
        const types = new Set(posts.map((p) => p.mediaType));

        for (const type of types) {
            expect(["REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"]).toContain(type);
        }
    });

    it("never puts text-only posts or links on Instagram", async () => {
        const posts = await createSeedAdapter("INSTAGRAM").fetchPosts("tharoor", SINCE);
        const types = new Set(posts.map((p) => p.mediaType));

        expect(types.has("TEXT_ONLY")).toBe(false);
        expect(types.has("LINK")).toBe(false);
    });

    it("honours what each platform reports: X has no saves, YouTube no shares", async () => {
        const x = await createSeedAdapter("X").fetchPosts("tharoor", SINCE);
        const youtube = await createSeedAdapter("YOUTUBE").fetchPosts("tharoor", SINCE);

        expect(x.every((p) => p.metrics.saves === null)).toBe(true);
        expect(x.every((p) => p.metrics.shares !== null)).toBe(true);
        expect(youtube.every((p) => p.metrics.shares === null)).toBe(true);
        expect(youtube.every((p) => p.metrics.saves === null)).toBe(true);
    });

    it("keeps posting habits a property of the person across platforms", async () => {
        // Varun Gandhi under-posts everywhere; Tharoor floods everywhere.
        for (const platform of ["INSTAGRAM", "FACEBOOK", "X"] as const) {
            const sparse = await createSeedAdapter(platform).fetchPosts("varungandhi", SINCE);
            const flooding = await createSeedAdapter(platform).fetchPosts("tharoor", SINCE);
            expect(flooding.length).toBeGreaterThan(sparse.length * 2);
        }
    });
});

describe("planted signal is recoverable", () => {
    // These mirror the constants in seedAdapter.ts. If the generative model is ever
    // rewritten so the rate cancels out to noise again, these fail.

    it("spreads posts across many hours of the day", async () => {
        // The original generator put every post at the same hour, which would have
        // rendered the day x hour heatmap (FR7) as a single vertical stripe.
        const posts = await createSeedAdapter("FACEBOOK").fetchPosts("chaturvedi", SINCE);
        const hours = new Set(posts.map((p) => new Date(p.postedAt).getUTCHours()));

        expect(hours.size).toBeGreaterThan(2);
    });

    it("spreads posts across all seven weekdays", async () => {
        const posts = await createSeedAdapter("FACEBOOK").fetchPosts("tharoor", SINCE);
        const days = new Set(posts.map((p) => new Date(p.postedAt).getUTCDay()));

        expect(days.size).toBe(7);
    });

    it("makes short video out-earn static images on engagement RATE, not raw likes", async () => {
        // The distinction matters: reach is generated first and interactions derived
        // from it, so a format winning here is winning on quality, not just exposure.
        const rates: Record<string, number[]> = { REEL_SHORT_VIDEO: [], SINGLE_IMAGE: [] };

        for (const handle of HANDLES) {
            const adapter = createSeedAdapter("FACEBOOK");
            const followers = (await adapter.fetchAccountMeta(handle)).followerCount!;

            for (const post of await adapter.fetchPosts(handle, SINCE)) {
                const bucket = rates[post.mediaType];
                if (!bucket) continue;

                const m = post.metrics;
                const interactions =
                    (m.likes ?? 0) + 3 * (m.comments ?? 0) + 5 * (m.shares ?? 0) + 4 * (m.saves ?? 0);
                bucket.push(interactions / followers);
            }
        }

        expect(rates["REEL_SHORT_VIDEO"]!.length).toBeGreaterThan(10);
        expect(rates["SINGLE_IMAGE"]!.length).toBeGreaterThan(10);
        expect(median(rates["REEL_SHORT_VIDEO"]!)).toBeGreaterThan(median(rates["SINGLE_IMAGE"]!));
    });

    it("keeps views independent of likes so the views-based rate can vary", async () => {
        // The original generator set views = likes * k, which made
        // interactions/views a constant and destroyed the YouTube metric entirely.
        const posts = await createSeedAdapter("YOUTUBE").fetchPosts("kanhaiyakumar", SINCE);
        const ratios = posts.filter((p) => p.metrics.views).map((p) => (p.metrics.likes ?? 0) / p.metrics.views!);

        const spread = Math.max(...ratios) / Math.min(...ratios);
        expect(spread).toBeGreaterThan(2);
    });

    it("plants the principal-versus-competitor gap the product must surface", async () => {
        const adapter = createSeedAdapter("INSTAGRAM");
        const principal = await adapter.fetchPosts("tharoor", SINCE);
        const rival = await adapter.fetchPosts("chaturvedi", SINCE);

        const reelShare = (posts: typeof principal) =>
            posts.filter((p) => p.mediaType === "REEL_SHORT_VIDEO").length / posts.length;

        // The competitor leans on short video; the principal does not. This is the
        // headline finding gap analysis is meant to discover on its own.
        expect(reelShare(rival)).toBeGreaterThan(reelShare(principal) * 2);
    });
});

describe("contract", () => {
    it("respects the sinceDate window", async () => {
        const cutoff = new Date(Date.now() - 30 * 86_400_000);
        const posts = await createSeedAdapter("X").fetchPosts("tharoor", cutoff);

        expect(posts.length).toBeGreaterThan(0);
        expect(posts.every((p) => new Date(p.postedAt) >= cutoff)).toBe(true);
    });

    it("marks every generated row synthetic and gives it no permalink", async () => {
        const posts = await createSeedAdapter("X").fetchPosts("tharoor", SINCE);

        expect(posts.every((p) => p.isSynthetic)).toBe(true);
        expect(posts.every((p) => p.permalink === null)).toBe(true);
        expect(posts.every((p) => p.caption?.startsWith("[synthetic]"))).toBe(true);
    });

    it("reports itself as the seed source for the audit trail", () => {
        expect(createSeedAdapter("X").source).toBe("seed");
    });
});
