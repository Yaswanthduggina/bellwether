// X (Twitter) via the Apify platform — the third live adapter.
//
// WHY THIS EXISTS AT ALL, GIVEN THE BLOCKER THAT WAS RECORDED AGAINST IT
//
// X was declared PLANNED for most of this project's life, with a blocker that
// was accurate and is still accurate: X's own free read tier caps out far below
// a 90-day backfill across four accounts, and a truncated sample would look live
// while hiding its own sampling bias. That argument was against X's FIRST-PARTY
// API. It was never an argument against reading the same public timeline the way
// the Instagram adapter already reads Instagram — through Apify, off the public
// web surface. Closing the gap needed a route, not a budget.
//
// ── CHOOSING THE ACTOR: THREE WAYS TO GET THIS WRONG ─────────────────────
//
// The store has a dozen X scrapers and they are not interchangeable. Three were
// tried against a real Apify free-plan account before this file settled:
//
//   apidojo/tweet-scraper       The obvious pick — most-run X scraper on the
//                               platform by two orders of magnitude, and the one
//                               every tutorial shows. IT REFUSES API ACCESS ON
//                               THE FREE PLAN. Critically, it does not refuse by
//                               failing: the run returns HTTP 201, status
//                               SUCCEEDED, and a dataset of ten rows, each of
//                               them {"noResults": true}. Trust the run status
//                               and count the rows and you have just learned
//                               that a head of government posts nothing.
//
//   xtdata/twitter-x-scraper    Runs on the free plan and returns real data, so
//                               this file was originally written against it. Two
//                               problems, both found only by trying to do a full
//                               ingest. It costs $0.005/tweet — twenty times the
//                               going rate — and it declares a MINIMUM
//                               PRE-AUTHORISED CHARGE of $3, which Apify checks
//                               against remaining credit before launching. Below
//                               $3 of credit no run starts at all, whatever
//                               maxItems or maxTotalChargeUsd say. It also
//                               returns no view count.
//
//   kaitoeasyapi/...cheapest    What this adapter uses. $0.00025/tweet, no
//                               minimum pre-authorisation, and — the reason it is
//                               not merely the cheap option — IT RETURNS
//                               viewCount, which decides the denominator below.
//
// The lesson worth carrying: on a pay-per-event actor, `minimalMaxTotalChargeUsd`
// and free-plan API permission are properties you must read BEFORE building
// against one. Neither is visible in the output shape, and both are fatal.
// Swap actors via X_ACTOR if this one goes the way of apidojo.
//
// ── THE DENOMINATOR, AND WHY IT DEPENDS ON THE ACTOR ─────────────────────
//
// `analytics/engagement.ts` lists X in VIEW_NATIVE_PLATFORMS, which it did
// before any X adapter existed, on the strength of the impression count X shows
// on its own web UI. That turns out to be a claim about the SOURCE rather than
// about the platform: xtdata returns no impression field at all, and an X corpus
// scraped through it would have silently fallen through to the followers basis.
// This actor does return `viewCount` on every tweet, so the entry is correct as
// written and X rates are views-normalised like YouTube's — "of the people who
// actually saw this, how many acted", which is the question format and timing
// analysis is really asking.
//
// If a future actor swap loses viewCount, this comment is the warning: the
// pipeline will not error, it will quietly re-base the whole platform onto
// followers and keep serving numbers.
//
// ── WHAT IS EXCLUDED FROM THE CORPUS, AND WHY ────────────────────────────
//
// RETWEETS. A retweet's like and reply counts belong to the ORIGINAL author, not
// to the account that amplified it. Ingesting them would credit the principal
// with a stranger's engagement and file that stranger's media type into the
// format mix that Question 1 reads. This actor excludes native retweets by
// default, but the filter below runs anyway — the exclusion is this pipeline's
// guarantee, not the scraper's default setting.
//
// REPLIES TO OTHER ACCOUNTS. A reply is conversation, not broadcast: it reaches
// the repliee's audience under different distribution rules, and its engagement
// is not comparable to a timeline post. Self-replies are KEPT — a thread is one
// piece of broadcast content that happens to be chunked, and dropping its tail
// would understate the account's output.
//
// ── COST ─────────────────────────────────────────────────────────────────
//
// Billed per tweet returned, not per run, so the per-account cap below is the
// knob that decides what a refresh costs. An active political account clears 20
// posts a day, so an uncapped 90-day pull on four accounts is thousands of billed
// rows. The actor returns NEWEST FIRST, so hitting the cap drops the OLDEST posts
// in the window rather than sampling at random — the same property the Instagram
// adapter relies on.

import { ApifyClient } from "apify-client";
import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

/** Overridable so a future free-plan lockout is a .env change, not a deploy. */
const DEFAULT_ACTOR = "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest";

/** Tweets per account per run. Override with X_RESULTS_LIMIT — see the cost note above. */
const DEFAULT_RESULTS_LIMIT = 150;

/** Kill a run rather than let ingestion hang on an actor that has stalled. */
const RUN_TIMEOUT_SECS = 300;

/**
 * Hard ceiling on what one account's run may cost, in USD.
 *
 * A source billed per row should carry a stated ceiling rather than an implicit
 * trust that the row count stays sane. Note the limit of this knob, learned the
 * hard way against xtdata: it lowers the charge Apify pre-authorises, but it
 * cannot go below an actor's own `minimalMaxTotalChargeUsd`, and when that
 * minimum exceeds remaining credit no run launches at any setting.
 */
const DEFAULT_MAX_CHARGE_USD = 0.5;

/**
 * Above this, a video is long-form rather than a short. X's own cap is far
 * higher, but the boundary has to match the one the other adapters use or the
 * FORMAT dimension stops being comparable across platforms — which is the whole
 * point of a fixed media-type taxonomy. Same 180s the Instagram adapter uses.
 */
const SHORT_MAX_SECONDS = 180;

/** One media attachment as the actor emits it. */
interface XMedia {
    type?: string; // "photo" | "video" | "animated_gif"
    video_info?: { duration_millis?: number };
}

/** One item as the actor emits it. Every field optional — scrapers omit. */
export interface XTweet {
    type?: string; // "tweet"
    id?: string;
    url?: string;
    twitterUrl?: string;
    text?: string;
    createdAt?: string; // "Sat Aug 01 14:15:18 +0000 2026" — X's legacy format
    likeCount?: number;
    retweetCount?: number;
    replyCount?: number;
    quoteCount?: number;
    bookmarkCount?: number;
    viewCount?: number;
    isReply?: boolean;
    inReplyToUserId?: string | null;
    retweeted_tweet?: unknown;
    entities?: { urls?: { expanded_url?: string }[]; media?: XMedia[] };
    extendedEntities?: { media?: XMedia[] };
    author?: {
        userName?: string;
        name?: string;
        followers?: number;
        id?: string;
    };
    // Refusals and target failures arrive as data rows, not as a failed run.
    noResults?: boolean;
    error?: string;
    errorDescription?: string;
}

function apiToken(): string {
    const token = process.env["APIFY_API_TOKEN"];
    if (!token) {
        throw new Error(
            "APIFY_API_TOKEN is not set. X ingestion runs through Apify — add the token " +
            "to .env (Apify Console -> Settings -> API & Integrations) before ingesting X accounts.",
        );
    }
    return token;
}

function actorId(): string {
    return process.env["X_ACTOR"] || DEFAULT_ACTOR;
}

function resultsLimit(): number {
    const raw = process.env["X_RESULTS_LIMIT"];
    if (!raw) return DEFAULT_RESULTS_LIMIT;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`X_RESULTS_LIMIT must be a positive number, got "${raw}"`);
    }
    return Math.floor(parsed);
}

export function maxChargeUsd(): number {
    const raw = process.env["X_MAX_CHARGE_USD"];
    if (!raw) return DEFAULT_MAX_CHARGE_USD;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`X_MAX_CHARGE_USD must be a positive number, got "${raw}"`);
    }
    return parsed;
}

/** Handles arrive as "@name" or "name"; the actor wants the bare handle. */
function cleanHandle(handle: string): string {
    return handle.trim().replace(/^@/, "");
}

/**
 * Absent means absent, and a negative count is absent rather than a value.
 * Same rule as the Instagram adapter, for the same reason: a metric written as 0
 * when it is really unknown drags every rate computed from it toward zero and
 * makes a data-availability problem look like a content problem.
 */
function count(value: number | undefined | null): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return value;
}

/**
 * Retweet and quote count are two ways of doing the same thing — putting the
 * post in front of an audience that does not follow the principal — so they are
 * summed into the single `shares` field the engagement weighting understands.
 *
 * Summed only over the ones actually present. If both are absent the result is
 * null, not 0, so `weightedInteractions` can tell "nobody shared this" from
 * "the scraper did not report sharing".
 */
function shareCount(tweet: XTweet): number | null {
    const retweets = count(tweet.retweetCount);
    const quotes = count(tweet.quoteCount);
    if (retweets === null && quotes === null) return null;
    return (retweets ?? 0) + (quotes ?? 0);
}

/**
 * X's legacy timestamp format, as a Date.
 *
 * `new Date("Sat Aug 01 14:15:18 +0000 2026")` parses correctly in V8, but the
 * result is checked rather than assumed: an unparseable date silently becomes
 * `Invalid Date`, whose `.toISOString()` throws deep inside normalisation with
 * no indication of which row caused it.
 */
export function parseTweetDate(raw: string | undefined): Date | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Which of the fixed media types this tweet is.
 *
 * The LINK case is the one that carries analytical weight. A bare text post and a
 * post pushing traffic to an external site are different communications acts with
 * different engagement profiles, and X is the only platform in this product where
 * both exist — so collapsing them into TEXT_ONLY would erase the one FORMAT
 * finding X is uniquely able to contribute.
 */
export function resolveMediaType(tweet: XTweet): RawPost["mediaType"] {
    // extendedEntities is the complete list; entities.media truncates to the
    // first attachment, so a four-photo post reads as a single image from it.
    const media = tweet.extendedEntities?.media ?? tweet.entities?.media ?? [];

    const video = media.find((m) => m.type === "video" || m.type === "animated_gif");
    if (video) {
        const millis = video.video_info?.duration_millis;
        if (typeof millis === "number" && millis > SHORT_MAX_SECONDS * 1000) return "LONG_FORM_VIDEO";
        return "REEL_SHORT_VIDEO";
    }

    const photos = media.filter((m) => m.type === "photo");
    if (photos.length > 1) return "CAROUSEL";
    if (photos.length === 1) return "SINGLE_IMAGE";

    // No media. A t.co wrapper around a quote-tweet or the post's own permalink
    // is not an outbound link, so only genuinely external URLs count.
    const urls = tweet.entities?.urls ?? [];
    const outbound = urls.some((u) => u.expanded_url && !/^https?:\/\/(x|twitter)\.com\//i.test(u.expanded_url));

    return outbound ? "LINK" : "TEXT_ONLY";
}

/**
 * True for posts that are not this account's own broadcast output.
 *
 * See the header for the argument. Kept as one predicate so the exclusion rule
 * is testable on its own and cannot drift between the meta and post paths.
 */
export function isExcluded(tweet: XTweet): boolean {
    // A retweet carries the original author's metrics under this account's name.
    if (tweet.retweeted_tweet) return true;
    if (/^RT @/.test(tweet.text ?? "")) return true;

    // A reply to someone else is conversation, not broadcast. A reply to oneself
    // is a thread, which is broadcast, so it stays.
    const repliedTo = tweet.inReplyToUserId;
    if (repliedTo && repliedTo !== tweet.author?.id) return true;

    return false;
}

/**
 * Reject a run whose rows are refusals rather than data.
 *
 * The free-plan lockout described in the header is the motivating case, and it
 * is a genuinely dangerous one because every signal short of the row content says
 * the run succeeded. A target that is protected, renamed or non-existent arrives
 * the same way — as a row carrying `error` — and normalises to zero posts, which
 * reads as a real finding about posting volume.
 */
function assertUsableRun(items: XTweet[], handle: string): void {
    const failure = items.find((item) => item.error);
    if (failure) {
        throw new Error(
            `Apify could not read X @${handle}: ${failure.error}` +
            (failure.errorDescription ? ` — ${failure.errorDescription}` : "") +
            `. Check the handle at x.com/${handle} — a protected or renamed account cannot be ingested.`,
        );
    }

    // Every row a no-result placeholder. Not the same as an empty dataset: this
    // is the actor telling us it declined, in a shape that counts as data.
    if (items.length > 0 && items.every((item) => item.noResults === true)) {
        throw new Error(
            `Apify actor ${actorId()} returned only no-result placeholders for X @${handle}. ` +
            `The usual cause is an actor that refuses API access on the Apify free plan — it reports ` +
            `SUCCEEDED and returns rows of {"noResults": true}, which would otherwise be ingested as ` +
            `"this account posted nothing". Check the run log in the Apify console, or point X_ACTOR ` +
            `at a different scraper.`,
        );
    }
}

/** Run an actor to completion and return its dataset. Mirrors apifyAdapter. */
async function runActor(client: ApifyClient, input: unknown): Promise<XTweet[]> {
    const actor = actorId();

    let run;
    try {
        run = await client.actor(actor).call(input, {
            timeout: RUN_TIMEOUT_SECS,
            maxTotalChargeUsd: maxChargeUsd(),
        });
    } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);

        if (status === 401 || status === 403) {
            throw new Error(`Apify rejected the token (${status}) running ${actor}: ${message}`);
        }
        if (status === 404) {
            throw new Error(`Apify actor ${actor} not found — check X_ACTOR or your account's access`);
        }
        // Reads as a generic run failure otherwise, and the fix is a different
        // knob from the one the message implies — see DEFAULT_MAX_CHARGE_USD.
        if (/exceed your remaining usage/i.test(message)) {
            throw new Error(
                `Apify refused to launch ${actor}: the run's pre-authorised maximum charge exceeds the ` +
                `account's remaining credit. ${message} Lower X_MAX_CHARGE_USD (currently ` +
                `$${maxChargeUsd()}), but note it cannot go below the actor's own minimum — and that ` +
                `lowering X_RESULTS_LIMIT alone does NOT help, because it is the declared maximum ` +
                `charge that is pre-authorised, not the item count.`,
            );
        }
        throw new Error(`Apify run of ${actor} failed: ${message}`);
    }

    if (run.status !== "SUCCEEDED") {
        throw new Error(
            `Apify run ${run.id} of ${actor} ended ${run.status} — partial results are not ingested. ` +
            `See https://console.apify.com/actors/runs/${run.id}`,
        );
    }

    const { items } = await client.dataset<Record<string, unknown>>(run.defaultDatasetId).listItems();
    return items as XTweet[];
}

/** The actor's search input for one account's timeline over one window. */
function timelineInput(handle: string, maxItems: number, sinceDate?: Date): Record<string, unknown> {
    return {
        from: handle,
        maxItems,
        queryType: "Latest",
        // Unix seconds, per the actor's schema. Server-side filtering keeps
        // out-of-window tweets out of the billed row count; the client-side
        // filter still runs, because the window is this pipeline's guarantee
        // and not the scraper's.
        ...(sinceDate ? { since_time: String(Math.floor(sinceDate.getTime() / 1000)) } : {}),
    };
}

export function createXAdapter(): SocialAdapter {
    const client = new ApifyClient({ token: apiToken() });

    return {
        platform: "X",
        source: "apify_x",

        /**
         * Follower count comes off the `author` block of the account's own tweets
         * rather than from a second profile actor.
         *
         * The Instagram adapter needs two actors because its post scraper does not
         * report followers. This one does, on every row, so a second billed run
         * would be buying a number we already have. The trade is that an account
         * with no posts in reach of the actor has no resolvable follower count —
         * which is correct behaviour, not a gap: an account we cannot read the
         * timeline of is one we cannot analyse either, and it fails loudly here
         * instead of silently producing an empty corpus downstream.
         *
         * Followers is not the engagement denominator on X (viewCount is), but it
         * is still worth having: it is what the roster's audience-spread note is
         * measured in, and the fallback if a post's view count is missing.
         */
        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const handle = cleanHandle(accountHandle);

            const items = await runActor(client, timelineInput(handle, 1));
            assertUsableRun(items, handle);

            const withAuthor = items.find((item) => item.author?.followers !== undefined);
            const author = withAuthor?.author;

            if (!author) {
                throw new Error(
                    `X profile @${handle} did not resolve to an author record. Check the handle at ` +
                    `x.com/${handle} — an unresolved handle would otherwise read as an account that posted nothing.`,
                );
            }

            // The actor matches handles case-insensitively, so a typo can land on a
            // different account entirely. This is the same class of error that put a
            // 322-follower namesake in the Instagram roster (see config/accounts.ts),
            // and it is cheap to refuse here.
            const resolved = author.userName;
            if (resolved && resolved.toLowerCase() !== handle.toLowerCase()) {
                throw new Error(
                    `X @${handle} resolved to @${resolved}. Refusing to attribute one account's posts ` +
                    `to another — correct the handle in config/accounts.ts.`,
                );
            }

            return {
                platform: "X",
                accountHandle,
                displayName: author.name ?? accountHandle,
                followerCount: count(author.followers),
                isSynthetic: false,
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            const handle = cleanHandle(accountHandle);

            const items = await runActor(client, timelineInput(handle, resultsLimit(), sinceDate));
            assertUsableRun(items, handle);

            const posts: RawPost[] = [];

            for (const item of items) {
                if (item.noResults) continue;
                if (isExcluded(item)) continue;

                // (platform, postId) is the idempotency key for upsert, so a tweet
                // with no id cannot be written safely.
                if (!item.id) continue;

                const postedAt = parseTweetDate(item.createdAt);
                if (postedAt === null || postedAt < sinceDate) continue;

                posts.push({
                    platform: "X",
                    // The configured handle, not the scraped one: this row has to
                    // attach to the account the pipeline is ingesting.
                    accountHandle,
                    postId: item.id,
                    postedAt: postedAt.toISOString(),
                    mediaType: resolveMediaType(item),
                    caption: item.text ?? null,
                    permalink: item.url ?? item.twitterUrl ?? `https://x.com/${handle}/status/${item.id}`,
                    metrics: {
                        likes: count(item.likeCount),
                        comments: count(item.replyCount),
                        shares: shareCount(item),
                        // The impression count, and the reason X sits on the views
                        // basis alongside YouTube. See the denominator note above.
                        views: count(item.viewCount),
                        // X's bookmark is a save: private, high-intent, and the
                        // closest analogue to the Instagram metric the weighting
                        // was written for.
                        saves: count(item.bookmarkCount),
                    },
                    isSynthetic: false,
                });
            }

            return posts;
        },
    };
}
