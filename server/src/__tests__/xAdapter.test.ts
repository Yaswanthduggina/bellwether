// No network. The Apify client is stubbed and the actor's real output shape is
// replayed through it — the payloads below are trimmed from live runs against
// @narendramodi, not invented.
//
// Several of these tests exist because of a specific way this adapter can be
// wrong while looking right:
//
//   - the free-plan refusal, which arrives as a SUCCEEDED run full of
//     {"noResults": true} and would otherwise ingest as "posted nothing";
//   - retweets, which carry another author's metrics under this account's name;
//   - extendedEntities vs entities.media, where reading the wrong one files a
//     four-photo post as a single image and quietly skews the format mix;
//   - viewCount, which is what puts X on the views basis rather than the
//     followers one — a silent re-basing of the whole platform if it goes absent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actorCall = vi.fn();
const listItems = vi.fn();

vi.mock("apify-client", () => ({
    ApifyClient: class {
        actor(id: string) {
            return { call: (input: unknown, options: unknown) => actorCall(id, input, options) };
        }
        dataset(id: string) {
            return { listItems: () => listItems(id) };
        }
    },
}));

const { createXAdapter, isExcluded, parseTweetDate, resolveMediaType } = await import("../adapters/xAdapter");

const SINCE = new Date("2026-05-01T00:00:00Z");

/** One actor run: succeeded, with these items in its dataset. */
function returns(items: unknown[]): void {
    actorCall.mockResolvedValue({ id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" });
    listItems.mockResolvedValue({ items });
}

/** A minimal well-formed tweet, overridable per test. */
function tweet(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "tweet",
        id: "2083552889046524208",
        url: "https://x.com/narendramodi/status/2083552889046524208",
        text: "At the Viveka Smaraka complex in Mysuru.",
        createdAt: "Sat Aug 01 13:58:13 +0000 2026",
        likeCount: 992,
        retweetCount: 197,
        replyCount: 114,
        quoteCount: 5,
        bookmarkCount: 6,
        viewCount: 154789,
        isReply: false,
        author: { userName: "narendramodi", name: "Narendra Modi", followers: 107098427, id: "18839785" },
        ...over,
    };
}

beforeEach(() => {
    process.env["APIFY_API_TOKEN"] = "test-token";
    actorCall.mockReset();
    listItems.mockReset();
});

afterEach(() => {
    delete process.env["X_RESULTS_LIMIT"];
    delete process.env["X_MAX_CHARGE_USD"];
    delete process.env["X_ACTOR"];
});

describe("parseTweetDate", () => {
    it("reads X's legacy timestamp format", () => {
        expect(parseTweetDate("Sat Aug 01 13:58:13 +0000 2026")?.toISOString()).toBe("2026-08-01T13:58:13.000Z");
    });

    it("returns null rather than an Invalid Date", () => {
        // Invalid Date propagates silently until .toISOString() throws somewhere
        // unrelated, so the failure is caught at the boundary instead.
        expect(parseTweetDate("not a date")).toBeNull();
        expect(parseTweetDate(undefined)).toBeNull();
    });
});

describe("resolveMediaType", () => {
    it("reads the full attachment list, not the truncated one", () => {
        // entities.media reports only the first attachment. A four-photo post read
        // from it is a SINGLE_IMAGE, which is wrong in the direction that matters:
        // it moves output out of the CAROUSEL bucket the format analysis compares.
        const fourPhotos = {
            entities: { media: [{ type: "photo" }] },
            extendedEntities: { media: [{ type: "photo" }, { type: "photo" }, { type: "photo" }, { type: "photo" }] },
        };
        expect(resolveMediaType(fourPhotos)).toBe("CAROUSEL");
    });

    it("splits video on the same 180s boundary the other adapters use", () => {
        const short = { extendedEntities: { media: [{ type: "video", video_info: { duration_millis: 26_000 } }] } };
        const long = { extendedEntities: { media: [{ type: "video", video_info: { duration_millis: 378_000 } }] } };
        expect(resolveMediaType(short)).toBe("REEL_SHORT_VIDEO");
        expect(resolveMediaType(long)).toBe("LONG_FORM_VIDEO");
    });

    it("treats an animated gif as a short video and a lone photo as a single image", () => {
        expect(resolveMediaType({ extendedEntities: { media: [{ type: "animated_gif" }] } })).toBe("REEL_SHORT_VIDEO");
        expect(resolveMediaType({ extendedEntities: { media: [{ type: "photo" }] } })).toBe("SINGLE_IMAGE");
    });

    it("separates a bare text post from one pushing an outbound link", () => {
        // The one FORMAT distinction only X can contribute — collapsing both into
        // TEXT_ONLY would erase it.
        expect(resolveMediaType({ text: "Congratulations to the team." })).toBe("TEXT_ONLY");
        expect(resolveMediaType({ entities: { urls: [{ expanded_url: "https://pmindia.gov.in/en/" }] } })).toBe("LINK");
    });

    it("does not count an on-platform URL as an outbound link", () => {
        // A quote-tweet's own permalink is not the post linking out.
        const quote = { entities: { urls: [{ expanded_url: "https://x.com/someone/status/123" }] } };
        expect(resolveMediaType(quote)).toBe("TEXT_ONLY");
    });
});

describe("isExcluded", () => {
    it("drops retweets, whose metrics belong to the original author", () => {
        expect(isExcluded({ retweeted_tweet: {} })).toBe(true);
        expect(isExcluded({ text: "RT @someone: a thing they said" })).toBe(true);
    });

    it("drops replies to other accounts but keeps self-threads", () => {
        // A reply reaches the repliee's audience under different distribution
        // rules; a thread is one broadcast post that happens to be chunked.
        expect(isExcluded({ author: { id: "1" }, inReplyToUserId: "999" })).toBe(true);
        expect(isExcluded({ author: { id: "1" }, inReplyToUserId: "1" })).toBe(false);
    });

    it("keeps an ordinary timeline post", () => {
        expect(isExcluded({ author: { id: "1" }, text: "An ordinary post." })).toBe(false);
    });
});

describe("fetchPosts", () => {
    it("maps a live tweet onto the RawPost contract", async () => {
        returns([tweet()]);

        const posts = await createXAdapter().fetchPosts("narendramodi", SINCE);

        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            platform: "X",
            accountHandle: "narendramodi",
            postId: "2083552889046524208",
            postedAt: "2026-08-01T13:58:13.000Z",
            mediaType: "TEXT_ONLY",
            isSynthetic: false,
        });
        expect(posts[0]!.metrics).toEqual({
            likes: 992,
            comments: 114,
            // Retweets and quotes are two routes to the same outcome — reaching
            // non-followers — so they are one `shares` figure.
            shares: 202,
            // The field that keeps X on the views basis alongside YouTube.
            views: 154789,
            saves: 6,
        });
    });

    it("carries the impression count through, since it is the denominator", async () => {
        // If this ever comes back null, `chooseDenominator` silently re-bases the
        // whole platform onto followers without erroring. Pinned deliberately.
        returns([tweet({ viewCount: 762412 })]);

        const posts = await createXAdapter().fetchPosts("narendramodi", SINCE);

        expect(posts[0]!.metrics.views).toBe(762412);
    });

    it("reports absent sharing as null rather than zero", async () => {
        returns([tweet({ retweetCount: undefined, quoteCount: undefined })]);

        const posts = await createXAdapter().fetchPosts("narendramodi", SINCE);

        // 0 would say "nobody shared this"; null says "we were not told".
        expect(posts[0]!.metrics.shares).toBeNull();
    });

    it("enforces the window itself rather than trusting the actor", async () => {
        // The server-side date filter is approximate — a live probe against a
        // different actor returned rows two days outside the requested bound — so
        // the window is the pipeline's guarantee and not the scraper's.
        returns([
            tweet({ id: "in", createdAt: "Sat Aug 01 13:58:13 +0000 2026" }),
            tweet({ id: "out", createdAt: "Tue Apr 21 09:00:00 +0000 2026" }),
        ]);

        const posts = await createXAdapter().fetchPosts("narendramodi", SINCE);

        expect(posts.map((p) => p.postId)).toEqual(["in"]);
    });

    it("excludes retweets from the corpus", async () => {
        returns([tweet({ id: "own" }), tweet({ id: "rt", text: "RT @other: not his post" })]);

        const posts = await createXAdapter().fetchPosts("narendramodi", SINCE);

        expect(posts.map((p) => p.postId)).toEqual(["own"]);
    });

    it("refuses a run that is only no-result placeholders", async () => {
        // The free-plan refusal: HTTP 201, status SUCCEEDED, ten rows of nothing.
        // Ingested as-is it reads as "this account posted nothing" — a finding,
        // and a false one.
        returns([{ noResults: true }, { noResults: true }]);

        await expect(createXAdapter().fetchPosts("narendramodi", SINCE)).rejects.toThrow(/no-result placeholders/);
    });

    it("surfaces a target error rather than normalising it to zero posts", async () => {
        returns([{ error: "not_found", errorDescription: "user does not exist" }]);

        await expect(createXAdapter().fetchPosts("nosuchhandle", SINCE)).rejects.toThrow(
            /could not read X @nosuchhandle/,
        );
    });

    it("passes the window, the cap and the charge ceiling to the actor", async () => {
        process.env["X_RESULTS_LIMIT"] = "40";
        process.env["X_MAX_CHARGE_USD"] = "0.1";
        returns([tweet()]);

        await createXAdapter().fetchPosts("@narendramodi", SINCE);

        expect(actorCall).toHaveBeenCalledWith(
            "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
            expect.objectContaining({
                // The leading @ is stripped — the actor wants a bare handle.
                from: "narendramodi",
                maxItems: 40,
                // Unix seconds, per the actor's schema.
                since_time: String(SINCE.getTime() / 1000),
            }),
            // Without this the run is pre-authorised at the actor's default and
            // can be refused outright on a nearly-spent account.
            expect.objectContaining({ maxTotalChargeUsd: 0.1 }),
        );
    });

    it("rejects a non-numeric cap instead of silently falling back", async () => {
        process.env["X_RESULTS_LIMIT"] = "lots";
        returns([tweet()]);

        await expect(createXAdapter().fetchPosts("narendramodi", SINCE)).rejects.toThrow(/must be a positive number/);
    });

    it("explains the remaining-credit refusal, which names the wrong knob by default", async () => {
        actorCall.mockRejectedValue(new Error("By launching this job you will exceed your remaining usage of $2.53"));

        await expect(createXAdapter().fetchPosts("narendramodi", SINCE)).rejects.toThrow(
            /X_RESULTS_LIMIT alone does NOT help/,
        );
    });
});

describe("fetchAccountMeta", () => {
    it("takes the follower count off the tweet's author block", async () => {
        // Rather than paying for a second profile actor run for a number every
        // row already carries.
        returns([tweet()]);

        const meta = await createXAdapter().fetchAccountMeta("narendramodi");

        expect(meta).toEqual({
            platform: "X",
            accountHandle: "narendramodi",
            displayName: "Narendra Modi",
            followerCount: 107098427,
            isSynthetic: false,
        });
    });

    it("refuses a handle that resolves to a different account", async () => {
        // The failure that put a 322-follower namesake in the Instagram roster.
        // Cheap to catch, and catastrophic to miss: it attributes one person's
        // posts to another and every downstream gate accepts the result.
        returns([tweet({ author: { userName: "amitshah", name: "Amit S", followers: 322, id: "9" } })]);

        await expect(createXAdapter().fetchAccountMeta("amitshahofficial")).rejects.toThrow(/resolved to @amitshah/);
    });

    it("fails loudly when no author record comes back", async () => {
        returns([{ id: "1", createdAt: "Sat Aug 01 13:58:13 +0000 2026" }]);

        await expect(createXAdapter().fetchAccountMeta("ghost")).rejects.toThrow(/did not resolve/);
    });
});
