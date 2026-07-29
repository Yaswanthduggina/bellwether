// The CSV path is the fallback that has to work when everything else does not,
// which makes it the worst place for a silent parsing bug. These tests cover the
// cases split(",") gets wrong and the vendor sloppiness real exports contain.

import { describe, expect, it } from "vitest";
import { parseCsv, parseImportFile } from "../adapters/fileAdapter";

describe("parseCsv — RFC 4180", () => {
    it("keeps commas inside quoted fields", () => {
        const rows = parseCsv('a,b\n"one, two",three\n');
        expect(rows[1]).toEqual(["one, two", "three"]);
    });

    it('unescapes "" to a single quote', () => {
        const rows = parseCsv('a\n"she said ""hi"""\n');
        expect(rows[1]![0]).toBe('she said "hi"');
    });

    it("keeps newlines inside quoted fields", () => {
        const rows = parseCsv('a,b\n"line one\nline two",x\n');
        expect(rows[1]![0]).toBe("line one\nline two");
        expect(rows).toHaveLength(2);
    });

    it("handles CRLF line endings", () => {
        expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    it("strips the UTF-8 BOM Excel writes", () => {
        expect(parseCsv("﻿header\nvalue\n")[0]![0]).toBe("header");
    });

    it("does not invent a trailing row from a final newline", () => {
        expect(parseCsv("a\n1\n")).toHaveLength(2);
    });

    it("preserves an empty leading cell rather than dropping the row", () => {
        expect(parseCsv("a,b\n,2\n")[1]).toEqual(["", "2"]);
    });
});

describe("parseImportFile — CSV", () => {
    const csv = [
        "Post ID,Network,Account Handle,Published At,Type,Message,URL,Favorites,Retweets,Impressions,Followers,Synthetic",
        'p1,twitter,someone,2026-06-14T18:00:00Z,Reel,"Hello, world",https://x.com/p1,"12,400",2140,1.2M,1800000,true',
        "p2,twitter,someone,2026-06-15T09:00:00Z,Photo,Plain,,8210,930,,,false",
    ].join("\n");

    it("resolves loose header names to fields", () => {
        // "Post ID" -> postId, "Network" -> platform, "Favorites" -> likes,
        // "Retweets" -> shares, "Impressions" -> views.
        const { posts } = parseImportFile(csv, ".csv");
        expect(posts).toHaveLength(2);
        expect(posts[0]!.postId).toBe("p1");
        expect(posts[0]!.metrics.shares).toBe(2140);
    });

    it("maps vendor platform and media-type labels onto the schema", () => {
        const { posts } = parseImportFile(csv, ".csv");
        expect(posts[0]!.platform).toBe("X"); // "twitter"
        expect(posts[0]!.mediaType).toBe("REEL_SHORT_VIDEO"); // "Reel"
        expect(posts[1]!.mediaType).toBe("SINGLE_IMAGE"); // "Photo"
    });

    it("parses thousands separators and K/M abbreviations", () => {
        const { posts } = parseImportFile(csv, ".csv");
        expect(posts[0]!.metrics.likes).toBe(12_400); // "12,400"
        expect(posts[0]!.metrics.views).toBe(1_200_000); // "1.2M"
    });

    it("reads an empty cell as absent, never as zero", () => {
        const { posts } = parseImportFile(csv, ".csv");
        expect(posts[1]!.metrics.views).toBeNull();
        expect(posts[1]!.permalink).toBeNull();
    });

    it("defaults isSynthetic to false — an import is presumed real", () => {
        const { posts } = parseImportFile(csv, ".csv");
        expect(posts[0]!.isSynthetic).toBe(true); // explicit "true"
        expect(posts[1]!.isSynthetic).toBe(false);
    });

    it("picks up a follower count when the file carries one", () => {
        const { followers } = parseImportFile(csv, ".csv");
        expect(followers.get("someone")).toBe(1_800_000);
    });

    it("falls back to TEXT_ONLY on an unfamiliar media type rather than dropping the post", () => {
        // Losing a real post over an unrecognised label costs more than one
        // imprecise field, and the value stays visible for correction.
        const odd = "platform,handle,post_id,posted_at,media_type\nx,me,p9,2026-06-01T00:00:00Z,Fleet\n";
        const { posts } = parseImportFile(odd, ".csv");
        expect(posts[0]!.mediaType).toBe("TEXT_ONLY");
    });

    it("skips a row with no recognisable platform instead of guessing", () => {
        const bad = "platform,handle,post_id\nmyspace,me,p1\n";
        expect(parseImportFile(bad, ".csv").posts).toHaveLength(0);
    });
});

describe("parseImportFile — JSON", () => {
    it("accepts the same vocabulary as CSV via the shared alias table", () => {
        const json = JSON.stringify([
            {
                platform: "yt",
                channelId: "chan",
                videoId: "v1",
                publishedAt: "2026-07-01T10:00:00Z",
                type: "shorts",
                title: "A title",
                viewCount: 5000,
                likeCount: 120,
            },
        ]);

        const { posts } = parseImportFile(json, ".json");
        expect(posts[0]!.platform).toBe("YOUTUBE");
        expect(posts[0]!.mediaType).toBe("REEL_SHORT_VIDEO");
        expect(posts[0]!.accountHandle).toBe("chan");
        expect(posts[0]!.metrics.views).toBe(5000);
        expect(posts[0]!.metrics.shares).toBeNull();
    });

    it("accepts a { posts: [...] } envelope as well as a bare array", () => {
        const wrapped = JSON.stringify({
            posts: [{ platform: "x", handle: "h", post_id: "p", posted_at: "2026-07-01T00:00:00Z", type: "text" }],
        });
        expect(parseImportFile(wrapped, ".json").posts).toHaveLength(1);
    });
});
