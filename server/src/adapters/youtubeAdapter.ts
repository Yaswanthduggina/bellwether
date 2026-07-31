// YouTube Data API v3 — the live adapter.
//
// YouTube is the one platform in the brief with genuinely obtainable public data:
// an official API, a workable free quota, and no business-account or app-review
// requirement. So it is the platform that gets a real implementation while the
// others are seeded and labelled as such.
//
// ── QUOTA ────────────────────────────────────────────────────────────────
// The free tier is 10,000 units/day. This adapter uses only the cheap endpoints:
//
//   channels.list       1 unit    resolve the handle, read subscriber count
//   playlistItems.list  1 unit    per page of 50 video ids
//   videos.list         1 unit    per batch of 50 videos (stats + duration)
//
// A full 90-day pull for one active channel costs roughly 5-10 units. search.list
// is deliberately NOT used: it costs 100 units per call, would exhaust the daily
// quota in a hundred requests, and the uploads playlist gives the same videos for
// a hundredth of the price.
//
// ── WHAT YOUTUBE DOES NOT EXPOSE ─────────────────────────────────────────
// No share count and no save count on public data. Both are reported as null
// rather than 0 — see the note in normalize.ts about why that distinction matters.
// Likes and comments can also be individually hidden by the channel owner, in
// which case they are absent too, not zero.

import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

const API_ROOT = "https://www.googleapis.com/youtube/v3";

/**
 * YouTube counts a video as a Short at 3 minutes or less. The API does not flag
 * Shorts directly, so duration is the only available signal — which means a short
 * regular upload is indistinguishable from a Short here. Stated plainly rather
 * than presented as exact.
 */
const SHORTS_MAX_SECONDS = 180;

/** Guard against a pathological channel paging forever. 10 pages = 500 videos. */
const MAX_PAGES = 10;

interface YouTubeChannel {
    id: string;
    snippet?: { title?: string };
    statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface YouTubeVideo {
    id: string;
    snippet?: { publishedAt?: string; title?: string; description?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    contentDetails?: { duration?: string };
    liveStreamingDetails?: unknown;
}

function apiKey(): string {
    const key = process.env["YOUTUBE_API_KEY"];
    if (!key) {
        throw new Error(
            "YOUTUBE_API_KEY is not set. Add it to .env, or import the account's data " +
                "as CSV/JSON with `npm run import -- --file=<export>`. There is no " +
                "generated fallback: an empty corpus is a visible problem, seeded rows are not.",
        );
    }
    return key;
}

async function call<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_ROOT}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("key", apiKey());

    const response = await fetch(url);

    if (!response.ok) {
        // Translate Google's error envelope into something actionable. A bare
        // "403 Forbidden" in the audit trail tells whoever reads it nothing.
        const body = (await response.json().catch(() => null)) as
            | { error?: { message?: string; errors?: { reason?: string }[] } }
            | null;
        const reason = body?.error?.errors?.[0]?.reason ?? "";
        const message = body?.error?.message ?? response.statusText;

        if (reason === "quotaExceeded")
            throw new Error("YouTube API daily quota exhausted — retry after midnight Pacific, or seed this account");
        if (reason === "keyInvalid" || reason === "badRequest")
            throw new Error(`YouTube API rejected the key: ${message}`);
        if (response.status === 403)
            throw new Error(`YouTube API forbidden (${reason || "no reason given"}): ${message}`);

        throw new Error(`YouTube API ${response.status}: ${message}`);
    }

    return (await response.json()) as T;
}

/**
 * Handles arrive in several shapes — "@Name", "Name", or a raw UC... channel id.
 * A channel id is unambiguous, so it is used directly; anything else goes through
 * forHandle.
 */
async function resolveChannel(handle: string): Promise<YouTubeChannel> {
    const cleaned = handle.trim().replace(/^@/, "");
    const isChannelId = /^UC[\w-]{22}$/.test(cleaned);

    const response = await call<{ items?: YouTubeChannel[] }>("channels", {
        part: "snippet,statistics,contentDetails",
        ...(isChannelId ? { id: cleaned } : { forHandle: cleaned }),
    });

    const channel = response.items?.[0];
    if (!channel) {
        // Fail loudly. An unresolved handle returning an empty list would read as
        // "this account posted nothing in 90 days", which is a far more damaging
        // lie than an error — it would show up on the dashboard as a real finding.
        throw new Error(
            `YouTube channel "${handle}" did not resolve. Check the handle (youtube.com/@<handle>) ` +
                `or use the raw UC... channel id.`,
        );
    }
    return channel;
}

/** ISO 8601 duration ("PT4M13S") -> seconds. */
export function parseDuration(iso: string | undefined): number | null {
    if (!iso) return null;
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!match) return null;

    const [, days, hours, minutes, seconds] = match;
    return (
        Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
    );
}

export function classifyVideo(video: YouTubeVideo): RawPost["mediaType"] {
    if (video.liveStreamingDetails) return "LIVE";
    const seconds = parseDuration(video.contentDetails?.duration);
    if (seconds !== null && seconds <= SHORTS_MAX_SECONDS) return "REEL_SHORT_VIDEO";
    return "LONG_FORM_VIDEO";
}

/** Absent statistics mean hidden or disabled, which is not the same as zero. */
function count(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function createYouTubeAdapter(): SocialAdapter {
    // Channel lookups are cached per adapter instance: fetchAccountMeta and
    // fetchPosts both need the channel, and the pipeline calls them back to back.
    const channels = new Map<string, Promise<YouTubeChannel>>();
    const channelFor = (handle: string) => {
        const key = handle.toLowerCase();
        if (!channels.has(key)) channels.set(key, resolveChannel(handle));
        return channels.get(key)!;
    };

    return {
        platform: "YOUTUBE",
        source: "youtube_api",

        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const channel = await channelFor(accountHandle);

            // YouTube rounds public subscriber counts to three significant figures
            // (1.23M, not 1,234,567), and a channel can hide the count entirely.
            // Treated as approximate; it is a denominator, not a headline number.
            const hidden = channel.statistics?.hiddenSubscriberCount === true;

            return {
                platform: "YOUTUBE",
                accountHandle,
                displayName: channel.snippet?.title ?? accountHandle,
                followerCount: hidden ? null : count(channel.statistics?.subscriberCount),
                isSynthetic: false,
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            const channel = await channelFor(accountHandle);
            const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
            if (!uploads) throw new Error(`Channel ${accountHandle} exposes no uploads playlist`);

            // Page the uploads playlist, newest first, stopping as soon as we cross
            // the window boundary — no point spending quota on 2019.
            const videoIds: string[] = [];
            let pageToken: string | undefined;
            let reachedWindowEdge = false;

            for (let page = 0; page < MAX_PAGES && !reachedWindowEdge; page++) {
                const response = await call<{
                    items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[];
                    nextPageToken?: string;
                }>("playlistItems", {
                    part: "contentDetails",
                    playlistId: uploads,
                    maxResults: "50",
                    ...(pageToken ? { pageToken } : {}),
                });

                for (const item of response.items ?? []) {
                    const publishedAt = item.contentDetails?.videoPublishedAt;
                    const videoId = item.contentDetails?.videoId;
                    if (!videoId || !publishedAt) continue;

                    if (new Date(publishedAt) < sinceDate) {
                        reachedWindowEdge = true;
                        break;
                    }
                    videoIds.push(videoId);
                }

                pageToken = response.nextPageToken;
                if (!pageToken) break;
            }

            if (videoIds.length === 0) return [];

            // videos.list takes up to 50 ids per call and costs the same as one.
            const posts: RawPost[] = [];

            for (let i = 0; i < videoIds.length; i += 50) {
                const response = await call<{ items?: YouTubeVideo[] }>("videos", {
                    part: "snippet,statistics,contentDetails,liveStreamingDetails",
                    id: videoIds.slice(i, i + 50).join(","),
                });

                for (const video of response.items ?? []) {
                    const publishedAt = video.snippet?.publishedAt;
                    if (!publishedAt) continue;

                    posts.push({
                        platform: "YOUTUBE",
                        accountHandle,
                        postId: video.id,
                        postedAt: publishedAt,
                        mediaType: classifyVideo(video),
                        // Title carries the editorial intent a caption would elsewhere;
                        // the description is appended so theme classification (Module D)
                        // has something to work with on title-only uploads.
                        caption: [video.snippet?.title, video.snippet?.description?.slice(0, 500)]
                            .filter(Boolean)
                            .join("\n\n"),
                        permalink: `https://www.youtube.com/watch?v=${video.id}`,
                        metrics: {
                            likes: count(video.statistics?.likeCount),
                            comments: count(video.statistics?.commentCount),
                            shares: null, // not exposed publicly
                            views: count(video.statistics?.viewCount),
                            saves: null, // not exposed publicly
                        },
                        isSynthetic: false,
                    });
                }
            }

            return posts;
        },
    };
}
