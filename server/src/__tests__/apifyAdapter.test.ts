// No network. The Apify client is stubbed and the actors' real output shape is
// replayed through it, because what is worth pinning here is the translation
// layer: media-type classification (a Reel misfiled as a photo corrupts the
// format analysis Question 1 depends on), and the -1 / absent / zero distinction
// on metrics (a hidden like count written as -1 fails the row; written as 0 it
// silently understates every rate computed from it).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actorCall = vi.fn();
const listItems = vi.fn();

vi.mock("apify-client", () => ({
    ApifyClient: class {
        actor(id: string) {
            return { call: (input: unknown) => actorCall(id, input) };
        }
        dataset(id: string) {
            return { listItems: () => listItems(id) };
        }
    },
}));

const { createApifyAdapter, resolveMediaType } = await import("../adapters/apifyAdapter");

const SINCE = new Date("2026-05-01T00:00:00Z");

/** One actor run: succeeded, with these items in its dataset. */
function returns(items: unknown[]): void {
    actorCall.mockResolvedValue({ id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" });
    listItems.mockResolvedValue({ items });
}

beforeEach(() => {
    process.env["APIFY_API_TOKEN"] = "test-token";
    actorCall.mockReset();
    listItems.mockReset();
});

afterEach(() => {
    delete process.env["APIFY_RESULTS_LIMIT"];
});

describe("resolveMediaType", () => {
    it("classifies a Reel from productType, whatever its length", () => {
        expect(resolveMediaType({ type: "Video", productType: "clips", videoDuration: 240 })).toBe("REEL_SHORT_VIDEO");
    });

    it("splits non-Reel video on duration", () => {
        expect(resolveMediaType({ type: "Video", videoDuration: 45 })).toBe("REEL_SHORT_VIDEO");
        expect(resolveMediaType({ type: "Video", videoDuration: 600 })).toBe("LONG_FORM_VIDEO");
    });

    it("maps the two still formats", () => {
        expect(resolveMediaType({ type: "Image" })).toBe("SINGLE_IMAGE");
        expect(resolveMediaType({ type: "Sidecar" })).toBe("CAROUSEL");
    });

    it("falls back to the item's own structure, never to TEXT_ONLY", () => {
        // TEXT_ONLY does not exist on Instagram. Emitting it would invent a format
        // bucket the platform has no posts in.
        expect(resolveMediaType({})).toBe("SINGLE_IMAGE");
        expect(resolveMediaType({ childPosts: [{}, {}] })).toBe("CAROUSEL");
    });
});

describe("fetchPosts", () => {
    const item = (over: Record<string, unknown> = {}) => ({
        id: "3300000000000000001",
        shortCode: "Cabc123",
        type: "Image",
        caption: "A caption",
        url: "https://www.instagram.com/p/Cabc123/",
        timestamp: "2026-06-14T13:00:00.000Z",
        likesCount: 1200,
        commentsCount: 48,
        ownerUsername: "shashitharoor",
        ...over,
    });

    it("maps an actor item onto RawPost", async () => {
        returns([item()]);

        const posts = await createApifyAdapter().fetchPosts("shashitharoor", SINCE);

        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            platform: "INSTAGRAM",
            accountHandle: "shashitharoor",
            postId: "3300000000000000001",
            postedAt: "2026-06-14T13:00:00.000Z",
            mediaType: "SINGLE_IMAGE",
            permalink: "https://www.instagram.com/p/Cabc123/",
            isSynthetic: false,
        });
        expect(posts[0]!.metrics).toEqual({
            likes: 1200,
            comments: 48,
            shares: null, // not exposed publicly
            views: null, // a still image has none
            saves: null, // not exposed publicly
        });
    });

    it("reports a hidden like count as absent, not as -1 and not as 0", async () => {
        returns([item({ likesCount: -1, commentsCount: 0 })]);

        const posts = await createApifyAdapter().fetchPosts("shashitharoor", SINCE);

        expect(posts[0]!.metrics.likes).toBeNull();
        // A real zero survives — "nobody commented" is a finding, "not published" is not.
        expect(posts[0]!.metrics.comments).toBe(0);
    });

    it("prefers plays over views on a Reel", async () => {
        returns([item({ productType: "clips", videoPlayCount: 91_000, videoViewCount: 74_000 })]);

        const posts = await createApifyAdapter().fetchPosts("shashitharoor", SINCE);

        expect(posts[0]!.mediaType).toBe("REEL_SHORT_VIDEO");
        expect(posts[0]!.metrics.views).toBe(91_000);
    });

    it("enforces the window itself rather than trusting the actor's filter", async () => {
        returns([item(), item({ id: "old", timestamp: "2026-01-02T09:00:00.000Z" })]);

        const posts = await createApifyAdapter().fetchPosts("shashitharoor", SINCE);

        expect(posts.map((p) => p.postId)).toEqual(["3300000000000000001"]);
    });

    it("passes the window and the result cap to the actor", async () => {
        process.env["APIFY_RESULTS_LIMIT"] = "50";
        returns([]);

        await createApifyAdapter().fetchPosts("@shashitharoor", SINCE);

        expect(actorCall).toHaveBeenCalledWith("apify/instagram-post-scraper", {
            username: ["shashitharoor"], // the @ is stripped
            resultsLimit: 50,
            onlyPostsNewerThan: "2026-05-01",
        });
    });

    it("throws on an unreadable profile instead of reporting zero posts", async () => {
        // The actors report a private or non-existent account as a data row, not as
        // a failed run. Left unchecked it reads as "this account posted nothing".
        returns([{ error: "not_found", errorDescription: "The profile does not exist" }]);

        await expect(createApifyAdapter().fetchPosts("nosuchhandle", SINCE)).rejects.toThrow(/nosuchhandle/);
    });

    it("throws when the run did not succeed, rather than ingesting partial results", async () => {
        actorCall.mockResolvedValue({ id: "run2", status: "TIMED-OUT", defaultDatasetId: "ds2" });

        await expect(createApifyAdapter().fetchPosts("shashitharoor", SINCE)).rejects.toThrow(/TIMED-OUT/);
    });
});

describe("fetchAccountMeta", () => {
    it("returns the follower count the engagement denominator needs", async () => {
        returns([{ username: "priyankac19", fullName: "Priyanka Chaturvedi", followersCount: 412_000 }]);

        const meta = await createApifyAdapter().fetchAccountMeta("priyankac19");

        expect(meta).toEqual({
            platform: "INSTAGRAM",
            accountHandle: "priyankac19",
            displayName: "Priyanka Chaturvedi",
            followerCount: 412_000,
            isSynthetic: false,
        });
        expect(actorCall).toHaveBeenCalledWith("apify/instagram-profile-scraper", { usernames: ["priyankac19"] });
    });

    it("throws when the handle does not resolve", async () => {
        returns([]);

        await expect(createApifyAdapter().fetchAccountMeta("nosuchhandle")).rejects.toThrow(/did not resolve/);
    });
});

describe("configuration", () => {
    it("names the missing token rather than failing inside a run", async () => {
        delete process.env["APIFY_API_TOKEN"];

        expect(() => createApifyAdapter()).toThrow(/APIFY_API_TOKEN/);
    });
});
