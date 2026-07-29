// Normalisation is the gate between "what a source claimed" and "what we store".
// Everything downstream — every rate, every heatmap cell, every recommendation —
// assumes these rules held, so they are tested directly rather than inferred from
// an end-to-end run.

import { describe, expect, it } from "vitest";
import { RawPost } from "../adapters/types";
import { NormalizeError, normalizePost, normalizePosts } from "../ingestion/normalize";

function raw(overrides: Partial<RawPost> = {}): RawPost {
    return {
        platform: "INSTAGRAM",
        accountHandle: "someone",
        postId: "p1",
        postedAt: "2026-06-14T13:00:00.000Z",
        mediaType: "REEL_SHORT_VIDEO",
        caption: "a caption",
        permalink: "https://example.com/p1",
        metrics: { likes: 100, comments: 10, shares: 5, views: 1000, saves: 3 },
        isSynthetic: false,
        ...overrides,
    };
}

describe("normalizePost — happy path", () => {
    it("carries every field through and parses the timestamp to a UTC instant", () => {
        const post = normalizePost(raw());

        expect(post.postId).toBe("p1");
        expect(post.platform).toBe("INSTAGRAM");
        expect(post.mediaType).toBe("REEL_SHORT_VIDEO");
        expect(post.postedAt.toISOString()).toBe("2026-06-14T13:00:00.000Z");
        expect(post.likes).toBe(100);
        expect(post.views).toBe(1000);
    });
});

describe("normalizePost — absent vs zero", () => {
    // The single most consequential rule in this file. A platform that does not
    // report shares is not a platform where nothing was shared, and folding the
    // second into the first silently deflates every rate computed from it.
    it("keeps a null metric as null and never coerces it to 0", () => {
        const post = normalizePost(raw({ metrics: { likes: 10, comments: null, shares: null, views: null, saves: null } }));

        expect(post.comments).toBeNull();
        expect(post.shares).toBeNull();
        expect(post.views).toBeNull();
        expect(post.saves).toBeNull();
        expect(post.likes).toBe(10);
    });

    it("treats an undefined metric the same as an explicit null", () => {
        const post = normalizePost(raw({ metrics: { likes: 10 } as never }));
        expect(post.shares).toBeNull();
    });

    it("keeps a genuine zero as zero", () => {
        const post = normalizePost(raw({ metrics: { likes: 0, comments: 0, shares: 0, views: 0, saves: 0 } }));
        expect(post.likes).toBe(0);
        expect(post.likes).not.toBeNull();
    });
});

describe("normalizePost — rejections", () => {
    it("rejects an empty postId, since it is the idempotency key", () => {
        expect(() => normalizePost(raw({ postId: "  " }))).toThrow(NormalizeError);
    });

    it("rejects an unparseable timestamp", () => {
        expect(() => normalizePost(raw({ postedAt: "last Tuesday" }))).toThrow(/unparseable/);
    });

    it("rejects a timestamp beyond clock-skew tolerance in the future", () => {
        const future = new Date(Date.now() + 48 * 3600_000).toISOString();
        expect(() => normalizePost(raw({ postedAt: future }))).toThrow(/future/);
    });

    it("accepts a timestamp a few minutes ahead — clocks disagree", () => {
        const slightlyAhead = new Date(Date.now() + 5 * 60_000).toISOString();
        expect(() => normalizePost(raw({ postedAt: slightlyAhead }))).not.toThrow();
    });

    it("rejects an implausibly old timestamp, which usually means a parse went wrong", () => {
        expect(() => normalizePost(raw({ postedAt: "1970-01-01T00:00:00Z" }))).toThrow(/implausibly old/);
    });

    it("rejects a negative metric", () => {
        expect(() => normalizePost(raw({ metrics: { likes: -5 } as never }))).toThrow(/negative/);
    });

    it("rejects a non-finite metric", () => {
        expect(() => normalizePost(raw({ metrics: { likes: Number.NaN } as never }))).toThrow(/finite/);
    });

    it("rejects an unknown platform or media type", () => {
        expect(() => normalizePost(raw({ platform: "TIKTOK" as never }))).toThrow(/unknown platform/);
        expect(() => normalizePost(raw({ mediaType: "STORY" as never }))).toThrow(/unknown mediaType/);
    });

    it("rejects a permalink that is not an http(s) URL", () => {
        expect(() => normalizePost(raw({ permalink: "javascript:alert(1)" }))).toThrow(/http/);
    });
});

describe("normalizePost — cleaning", () => {
    it("trims a caption and nulls a blank one", () => {
        expect(normalizePost(raw({ caption: "  hello  " })).caption).toBe("hello");
        expect(normalizePost(raw({ caption: "   " })).caption).toBeNull();
    });

    it("nulls a blank permalink rather than storing an empty string", () => {
        expect(normalizePost(raw({ permalink: "" })).permalink).toBeNull();
    });

    it("rounds a fractional metric — some APIs return expanded floats", () => {
        expect(normalizePost(raw({ metrics: { likes: 1200.4 } as never })).likes).toBe(1200);
    });

    it("coerces a missing isSynthetic to false rather than undefined", () => {
        expect(normalizePost(raw({ isSynthetic: undefined as never })).isSynthetic).toBe(false);
    });
});

describe("normalizePosts — batch behaviour", () => {
    // A source returning one bad row must not cost us the other 99. This is what
    // makes IngestionRun.rowsFailed a number worth reading.
    it("collects failures and keeps the good rows", () => {
        const result = normalizePosts([
            raw({ postId: "good-1" }),
            raw({ postId: "", caption: "no id" }),
            raw({ postId: "good-2" }),
            raw({ postId: "bad-date", postedAt: "nonsense" }),
        ]);

        expect(result.posts.map((p) => p.postId)).toEqual(["good-1", "good-2"]);
        expect(result.failures).toHaveLength(2);
        expect(result.failures[1]!.postId).toBe("bad-date");
        expect(result.failures[1]!.reason).toMatch(/unparseable/);
    });

    it("returns empty structures for an empty batch rather than throwing", () => {
        expect(normalizePosts([])).toEqual({ posts: [], failures: [] });
    });
});
