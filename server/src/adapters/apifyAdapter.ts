// Instagram via the Apify platform — the second live adapter.
//
// WHY APIFY RATHER THAN THE GRAPH API
//
// Instagram's own API (Instagram Graph) only reads accounts you administer: it
// needs a Business/Creator account linked to a Facebook Page you control, an app
// review, and a user access token from that account's owner. None of that is
// obtainable for a third party's public profile, which is exactly what competitor
// benchmarking is. Apify's Instagram actors read the public web surface instead,
// which is the same data any visitor sees — so the corpus is real, attributable
// and refreshable, with no seeded rows standing in for it.
//
// ── THE TWO ACTORS ───────────────────────────────────────────────────────
//
//   apify/instagram-post-scraper      posts for a username, newest first
//   apify/instagram-profile-scraper   profile facts, including follower count
//
// Two actors rather than one because the post scraper does not report follower
// count, and follower count is not optional here: Instagram photos and carousels
// carry no view count, so the engagement-rate denominator falls back to followers
// (see chooseDenominator in analytics/engagement.ts). Without it every non-video
// Instagram post would land in the NO_DENOMINATOR bucket and drop out of the
// comparison entirely.
//
// ── COST, AND WHY THE LIMIT IS LOW ───────────────────────────────────────
//
// Apify bills per result, not per run. A 90-day window on an active political
// account is roughly 100-300 posts, so the per-account cap below is the one knob
// that decides what a full refresh costs. It is deliberately conservative and
// overridable; note that the actor returns NEWEST FIRST, so hitting the cap drops
// the OLDEST posts in the window rather than truncating at random.
//
// ── WHAT INSTAGRAM DOES NOT EXPOSE ───────────────────────────────────────
//
// No share count and no save count on public data — both are reported as null,
// never 0, for the reason set out in normalize.ts. Like counts can be hidden by
// the poster, in which case the scraper reports -1; that is also translated to
// null rather than being written as a negative number.

import { ApifyClient } from "apify-client";
import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

const POSTS_ACTOR = "apify/instagram-post-scraper";
const PROFILE_ACTOR = "apify/instagram-profile-scraper";

/** Posts per account per run. Override with APIFY_RESULTS_LIMIT — see the cost note above. */
const DEFAULT_RESULTS_LIMIT = 200;

/** Kill a run rather than let ingestion hang on an actor that has stalled. */
const RUN_TIMEOUT_SECS = 300;

/**
 * Instagram caps Reels at 3 minutes for most accounts, and the scraper does not
 * flag a Reel directly on older posts. productType === "clips" is the reliable
 * signal; duration is the fallback for anything that predates it. Same limitation
 * as the YouTube adapter's Shorts detection, and stated for the same reason.
 */
const REEL_MAX_SECONDS = 180;

/** One item as the Instagram actors emit it. Every field optional — scrapers omit. */
interface ApifyInstagramPost {
    id?: string;
    shortCode?: string;
    type?: string; // "Image" | "Video" | "Sidecar"
    productType?: string; // "clips" on Reels, "feed"/"igtv" otherwise
    caption?: string;
    url?: string;
    timestamp?: string;
    likesCount?: number;
    commentsCount?: number;
    videoViewCount?: number;
    videoPlayCount?: number;
    videoDuration?: number;
    childPosts?: unknown[];
    ownerUsername?: string;
    // Actors report a failed target as a data row, not as a run failure.
    error?: string;
    errorDescription?: string;
}

interface ApifyInstagramProfile {
    username?: string;
    fullName?: string;
    followersCount?: number;
    private?: boolean;
    error?: string;
    errorDescription?: string;
}

function apiToken(): string {
    const token = process.env["APIFY_API_TOKEN"];
    if (!token) {
        throw new Error(
            "APIFY_API_TOKEN is not set. Instagram ingestion runs through Apify — add the token " +
            "to .env (Apify Console -> Settings -> API & Integrations) before ingesting Instagram accounts.",
        );
    }
    return token;
}

function resultsLimit(): number {
    const raw = process.env["APIFY_RESULTS_LIMIT"];
    if (!raw) return DEFAULT_RESULTS_LIMIT;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`APIFY_RESULTS_LIMIT must be a positive number, got "${raw}"`);
    }
    return Math.floor(parsed);
}

/** Handles arrive as "@name" or "name"; Apify wants the bare username. */
function cleanHandle(handle: string): string {
    return handle.trim().replace(/^@/, "");
}

/**
 * Absent means absent. Instagram reports -1 for a like count the poster has
 * hidden, and writing that through would be a negative metric — rejected by
 * normalize.ts as a failed row, when the honest answer is simply "not published".
 */
function count(value: number | undefined | null): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return value;
}

export function resolveMediaType(post: ApifyInstagramPost): RawPost["mediaType"] {
    if (post.productType === "clips") return "REEL_SHORT_VIDEO";

    const type = post.type?.toLowerCase();

    if (type === "video" || typeof post.videoDuration === "number") {
        const seconds = post.videoDuration;
        if (typeof seconds === "number" && seconds > REEL_MAX_SECONDS) return "LONG_FORM_VIDEO";
        return "REEL_SHORT_VIDEO";
    }

    if (type === "sidecar") return "CAROUSEL";
    if (type === "image") return "SINGLE_IMAGE";

    // Unknown label: fall back to the structure of the item itself rather than to
    // TEXT_ONLY, which does not exist on Instagram and would quietly distort the
    // format mix that gap analysis reads.
    return (post.childPosts?.length ?? 0) > 1 ? "CAROUSEL" : "SINGLE_IMAGE";
}

/**
 * Run an actor to completion and return its dataset.
 *
 * Anything other than SUCCEEDED throws: a partially-scraped account rendering as
 * "posted less this month" would appear on the dashboard as a finding rather than
 * as the failure it is. Same rule the YouTube adapter follows for unresolved handles.
 */
async function runActor<T>(client: ApifyClient, actorId: string, input: unknown): Promise<T[]> {
    let run;
    try {
        run = await client.actor(actorId).call(input, { timeout: RUN_TIMEOUT_SECS });
    } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);

        if (status === 401 || status === 403) {
            throw new Error(`Apify rejected the token (${status}) running ${actorId}: ${message}`);
        }
        if (status === 404) {
            throw new Error(`Apify actor ${actorId} not found — check the actor id or your account's access`);
        }
        throw new Error(`Apify run of ${actorId} failed: ${message}`);
    }

    if (run.status !== "SUCCEEDED") {
        throw new Error(
            `Apify run ${run.id} of ${actorId} ended ${run.status} — partial results are not ingested. ` +
            `See https://console.apify.com/actors/runs/${run.id}`,
        );
    }

    const { items } = await client.dataset<Record<string, unknown>>(run.defaultDatasetId).listItems();
    return items as T[];
}

/**
 * The actors report an unreachable target as a row in the dataset rather than as
 * a failed run — a private, renamed or non-existent profile comes back as one
 * item carrying an `error` field. Left unchecked it normalises to zero posts,
 * which reads as a real (and wrong) finding about posting volume.
 */
function assertNoTargetError(items: { error?: string; errorDescription?: string }[], handle: string): void {
    const failure = items.find((item) => item.error);
    if (!failure) return;

    throw new Error(
        `Apify could not read Instagram @${handle}: ${failure.error}` +
        (failure.errorDescription ? ` — ${failure.errorDescription}` : "") +
        `. Check the handle at instagram.com/${handle} — a private or renamed account cannot be ingested.`,
    );
}

export function createApifyAdapter(): SocialAdapter {
    // One client per adapter instance; the token is read on construction so a
    // missing token fails before a run is opened rather than mid-ingestion.
    const client = new ApifyClient({ token: apiToken() });

    return {
        platform: "INSTAGRAM",
        source: "apify_instagram",

        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const handle = cleanHandle(accountHandle);

            const items = await runActor<ApifyInstagramProfile>(client, PROFILE_ACTOR, {
                usernames: [handle],
            });
            assertNoTargetError(items, handle);

            const profile = items[0];
            if (!profile) {
                throw new Error(
                    `Instagram profile @${handle} did not resolve. Check the handle at ` +
                    `instagram.com/${handle} — an unresolved handle would otherwise read as an account that posted nothing.`,
                );
            }

            return {
                platform: "INSTAGRAM",
                accountHandle,
                displayName: profile.fullName ?? accountHandle,
                // Followers is the engagement-rate denominator for photos and
                // carousels, which have no view count. null (not 0) where hidden.
                followerCount: count(profile.followersCount),
                isSynthetic: false,
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            const handle = cleanHandle(accountHandle);

            const items = await runActor<ApifyInstagramPost>(client, POSTS_ACTOR, {
                username: [handle],
                resultsLimit: resultsLimit(),
                // The actor filters server-side, which keeps out-of-window posts out
                // of the billed result count. The client-side filter below still runs:
                // the window is this pipeline's guarantee, not the scraper's.
                onlyPostsNewerThan: sinceDate.toISOString().slice(0, 10),
            });
            assertNoTargetError(items, handle);

            const posts: RawPost[] = [];

            for (const item of items) {
                // (platform, postId) is the idempotency key for upsert, so a post
                // with neither id nor shortcode cannot be written safely — skipped
                // here and counted by nothing, because there is nothing to key it by.
                const postId = item.id ?? item.shortCode;
                if (!postId || !item.timestamp) continue;

                if (new Date(item.timestamp) < sinceDate) continue;

                posts.push({
                    platform: "INSTAGRAM",
                    // The configured handle, not the scraped one: this row has to
                    // attach to the account the pipeline is ingesting.
                    accountHandle,
                    postId,
                    postedAt: item.timestamp,
                    mediaType: resolveMediaType(item),
                    caption: item.caption ?? null,
                    permalink: item.url ?? (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null),
                    metrics: {
                        likes: count(item.likesCount),
                        comments: count(item.commentsCount),
                        shares: null, // not exposed publicly
                        // Plays supersede views on Reels; either may be absent on
                        // a still image, where the concept does not apply.
                        views: count(item.videoPlayCount) ?? count(item.videoViewCount),
                        saves: null, // not exposed publicly
                    },
                    isSynthetic: false,
                });
            }

            return posts;
        },
    };
}
