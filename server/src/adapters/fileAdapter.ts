// CSV / JSON import — the fallback path (FR3), behind the same interface as
// everything else.
//
// This is a MUST, not a nicety. Every social API is one policy change or one rate
// limit away from being unavailable, and when that happens a comms team still has
// an export from somewhere. Routing that export through the *same* SocialAdapter
// contract as the live and seed sources is the whole point of the adapter pattern:
// normalise, upsert, run log and analytics cannot tell the difference.
//
// ── EXPECTED FILE FORMAT ─────────────────────────────────────────────────
//
// CSV with a header row, or JSON as an array of objects (or { "posts": [...] }).
//
//   Required:  platform, account_handle, post_id, posted_at, media_type
//   Optional:  caption, permalink, likes, comments, shares, views, saves,
//              follower_count, is_synthetic
//
// Header names are matched loosely — case and separators are ignored, and common
// vendor aliases are accepted (`retweets` for shares, `impressions` for views,
// `url` for permalink). Real exports do not agree on column names, and rejecting
// a file over `Post ID` vs `post_id` would make the fallback path useless exactly
// when it is needed.
//
// An empty cell means ABSENT, not zero. That distinction is load-bearing: a blank
// share column is "this platform does not report shares", and coercing it to 0
// would silently understate every rate computed from it.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

type Platform = RawPost["platform"];
type MediaType = RawPost["mediaType"];

// ── CSV parsing ──────────────────────────────────────────────────────────

/**
 * RFC 4180 parser. Hand-written rather than a dependency because captions contain
 * commas, quotes and newlines — `split(",")` corrupts them silently, which is the
 * worst kind of data bug — and because a parser this small is one I can account
 * for line by line.
 *
 * Handles: quoted fields, "" as an escaped quote, embedded commas and newlines,
 * CRLF endings, and a UTF-8 BOM (Excel writes one).
 */
export function parseCsv(input: string): string[][] {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;

        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"'; // escaped quote
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += char; // newlines inside quotes belong to the field
            }
            continue;
        }

        if (char === '"') quoted = true;
        else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char !== "\r") field += char;
    }

    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    // Drop blank trailing lines without dropping rows whose first cell is empty.
    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// ── Loose header and value matching ──────────────────────────────────────

/** "Post ID", "post_id" and "postId" are the same column. */
function canonical(header: string): string {
    return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLUMN_ALIASES: Record<string, string[]> = {
    platform: ["platform", "network", "channel", "source"],
    handle: ["accounthandle", "handle", "account", "username", "screenname", "channelid"],
    postId: ["postid", "id", "postidentifier", "tweetid", "videoid", "mediaid"],
    postedAt: ["postedat", "posteddate", "date", "datetime", "timestamp", "publishedat", "createdat", "created"],
    mediaType: ["mediatype", "type", "format", "posttype", "contenttype"],
    caption: ["caption", "text", "message", "title", "content", "description"],
    permalink: ["permalink", "url", "link", "posturl", "postlink"],
    likes: ["likes", "likecount", "favorites", "favourites", "reactions", "favoritecount"],
    comments: ["comments", "commentcount", "replies", "replycount"],
    shares: ["shares", "sharecount", "retweets", "retweetcount", "reposts"],
    views: ["views", "viewcount", "impressions", "plays", "videoviews", "reach"],
    saves: ["saves", "savecount", "bookmarks", "bookmarkcount"],
    followerCount: ["followercount", "followers", "subscribers", "subscribercount"],
    isSynthetic: ["issynthetic", "synthetic", "seeded"],
};

/** Vendor exports say "Photo" and "Reel"; the schema says SINGLE_IMAGE and REEL_SHORT_VIDEO. */
const MEDIA_TYPE_ALIASES: Record<string, MediaType> = {
    reel: "REEL_SHORT_VIDEO",
    reels: "REEL_SHORT_VIDEO",
    short: "REEL_SHORT_VIDEO",
    shorts: "REEL_SHORT_VIDEO",
    shortvideo: "REEL_SHORT_VIDEO",
    reelshortvideo: "REEL_SHORT_VIDEO",
    video: "LONG_FORM_VIDEO",
    longform: "LONG_FORM_VIDEO",
    longformvideo: "LONG_FORM_VIDEO",
    carousel: "CAROUSEL",
    album: "CAROUSEL",
    gallery: "CAROUSEL",
    multiphoto: "CAROUSEL",
    photo: "SINGLE_IMAGE",
    image: "SINGLE_IMAGE",
    picture: "SINGLE_IMAGE",
    singleimage: "SINGLE_IMAGE",
    text: "TEXT_ONLY",
    status: "TEXT_ONLY",
    tweet: "TEXT_ONLY",
    textonly: "TEXT_ONLY",
    link: "LINK",
    url: "LINK",
    live: "LIVE",
    broadcast: "LIVE",
    livestream: "LIVE",
};

const PLATFORM_ALIASES: Record<string, Platform> = {
    instagram: "INSTAGRAM",
    ig: "INSTAGRAM",
    facebook: "FACEBOOK",
    fb: "FACEBOOK",
    meta: "FACEBOOK",
    x: "X",
    twitter: "X",
    youtube: "YOUTUBE",
    yt: "YOUTUBE",
};

/** Maps a header row to { field -> column index }. Unknown columns are ignored. */
function mapHeaders(headers: string[]): Record<string, number> {
    const found: Record<string, number> = {};

    headers.forEach((header, index) => {
        const key = canonical(header);
        for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
            if (aliases.includes(key) && found[field] === undefined) found[field] = index;
        }
    });

    return found;
}

/** Empty means absent. Never coerced to 0 — see the note at the top of the file. */
function numberOrNull(value: string | undefined): number | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed === "-") return null;

    // Exports commonly carry thousands separators and abbreviations.
    const cleaned = trimmed.replace(/,/g, "");
    const abbreviated = /^([\d.]+)\s*([km])$/i.exec(cleaned);
    if (abbreviated) {
        const scale = abbreviated[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000;
        return Number(abbreviated[1]) * scale;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

// ── Row -> RawPost ───────────────────────────────────────────────────────

/**
 * A record with the loose field names already resolved. Deliberately permissive:
 * validation is normalize.ts's job, and duplicating it here would mean two places
 * to keep in step. This layer only decides "what did the file mean by this cell".
 */
interface LooseRecord {
    get(field: string): string | undefined;
}

function toRawPost(record: LooseRecord): RawPost | null {
    const platformRaw = record.get("platform");
    const platform = platformRaw ? PLATFORM_ALIASES[canonical(platformRaw)] : undefined;
    if (!platform) return null;

    const mediaRaw = record.get("mediaType");
    // Unrecognised formats become TEXT_ONLY rather than dropping the row: losing a
    // real post over an unfamiliar label costs more than one imprecise media type,
    // and the value is visible in the UI for anyone who wants to correct it.
    const mediaType = (mediaRaw ? MEDIA_TYPE_ALIASES[canonical(mediaRaw)] : undefined) ?? "TEXT_ONLY";

    const synthetic = record.get("isSynthetic")?.trim().toLowerCase();

    return {
        platform,
        accountHandle: stringOrNull(record.get("handle")) ?? "",
        postId: stringOrNull(record.get("postId")) ?? "",
        postedAt: stringOrNull(record.get("postedAt")) ?? "",
        mediaType,
        caption: stringOrNull(record.get("caption")),
        permalink: stringOrNull(record.get("permalink")),
        metrics: {
            likes: numberOrNull(record.get("likes")),
            comments: numberOrNull(record.get("comments")),
            shares: numberOrNull(record.get("shares")),
            views: numberOrNull(record.get("views")),
            saves: numberOrNull(record.get("saves")),
        },
        // Imported data is presumed REAL unless the file says otherwise. An import
        // is normally someone's genuine export, and defaulting to synthetic would
        // mislabel it in the opposite direction from the one that matters.
        isSynthetic: synthetic === "true" || synthetic === "1" || synthetic === "yes",
    };
}

export interface ParsedFile {
    posts: RawPost[];
    /** Follower counts found in the file, keyed by handle. Usually absent. */
    followers: Map<string, number>;
}

export function parseImportFile(contents: string, extension: string): ParsedFile {
    const posts: RawPost[] = [];
    const followers = new Map<string, number>();

    const collect = (record: LooseRecord) => {
        const post = toRawPost(record);
        if (!post) return;
        posts.push(post);

        const count = numberOrNull(record.get("followerCount"));
        if (count !== null && post.accountHandle) followers.set(post.accountHandle.toLowerCase(), count);
    };

    if (extension === ".json") {
        const parsed = JSON.parse(contents);
        const rows: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : (parsed.posts ?? []);

        for (const row of rows) {
            // Resolve JSON keys through the same alias table as CSV headers, so both
            // formats accept exactly the same vocabulary.
            const byCanonical = new Map(Object.entries(row).map(([k, v]) => [canonical(k), v]));
            collect({
                get(field) {
                    for (const alias of COLUMN_ALIASES[field] ?? []) {
                        const value = byCanonical.get(alias);
                        if (value !== undefined && value !== null) return String(value);
                    }
                    return undefined;
                },
            });
        }
    } else {
        const rows = parseCsv(contents);
        if (rows.length < 2) return { posts, followers };

        const columns = mapHeaders(rows[0]!);
        for (const row of rows.slice(1)) {
            collect({
                get(field) {
                    const index = columns[field];
                    return index === undefined ? undefined : row[index];
                },
            });
        }
    }

    return { posts, followers };
}

// ── The adapter ──────────────────────────────────────────────────────────

/**
 * One file can hold many accounts and many platforms — that is how exports
 * actually arrive. The adapter is constructed per platform and filters the file
 * down to the rows it owns, so the pipeline stays a per-account operation.
 */
export function createFileAdapter(platform: Platform, filePath: string): SocialAdapter {
    const extension = extname(filePath).toLowerCase();
    if (extension !== ".csv" && extension !== ".json") {
        throw new Error(`Unsupported import file type "${extension}" — expected .csv or .json`);
    }

    // Read once, not once per account: a 16-account import would otherwise re-parse
    // the same file 16 times.
    let cache: ParsedFile | undefined;
    const load = (): ParsedFile => (cache ??= parseImportFile(readFileSync(filePath, "utf8"), extension));

    const rowsFor = (handle: string) =>
        load().posts.filter(
            (post) => post.platform === platform && post.accountHandle.toLowerCase() === handle.toLowerCase(),
        );

    return {
        platform,
        source: extension === ".json" ? "json_import" : "csv_import",

        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const followerCount = load().followers.get(accountHandle.toLowerCase()) ?? null;
            return {
                platform,
                accountHandle,
                displayName: accountHandle,
                // Usually null. Ingestion leaves the stored value alone rather than
                // overwriting a known follower count with an absent one.
                followerCount,
                isSynthetic: rowsFor(accountHandle).every((post) => post.isSynthetic),
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            return rowsFor(accountHandle).filter((post) => {
                const at = new Date(post.postedAt);
                // Unparseable dates are kept so normalize.ts rejects them ONCE, with a
                // readable reason in the audit trail. Silently dropping them here would
                // make rows vanish with no record of why.
                return Number.isNaN(at.getTime()) || at >= sinceDate;
            });
        },
    };
}

/** Which (platform, handle) pairs a file contains — used to resolve accounts before importing. */
export function describeImportFile(filePath: string): { platform: Platform; handle: string; rows: number }[] {
    const extension = extname(filePath).toLowerCase();
    const { posts } = parseImportFile(readFileSync(filePath, "utf8"), extension);

    const counts = new Map<string, { platform: Platform; handle: string; rows: number }>();
    for (const post of posts) {
        const key = `${post.platform}:${post.accountHandle.toLowerCase()}`;
        const existing = counts.get(key);
        if (existing) existing.rows += 1;
        else counts.set(key, { platform: post.platform, handle: post.accountHandle, rows: 1 });
    }

    return [...counts.values()];
}
