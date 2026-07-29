// RawPost -> the shape the database stores.
//
// This module deliberately imports NOTHING from Prisma. Normalisation is pure
// data transformation, so keeping the ORM out means it can be unit-tested without
// a database and the rules below are readable on their own terms.
//
// It also validates. Ingestion pulls from sources that lie, omit and occasionally
// return nonsense, and a bad row should be *counted and skipped*, never written
// and never allowed to abort the rest of the batch — which is what makes
// IngestionRun.rowsFailed a number worth looking at.

import { RawPost } from "../adapters/types";

export interface NormalizedPost {
    platform: RawPost["platform"];
    postId: string;
    postedAt: Date; // UTC instant
    mediaType: RawPost["mediaType"];
    caption: string | null;
    permalink: string | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
    saves: number | null;
    isSynthetic: boolean;
}

/** Thrown for a row that cannot be trusted. The pipeline counts these, not crashes on them. */
export class NormalizeError extends Error {
    constructor(
        readonly postId: string,
        message: string,
    ) {
        super(message);
        this.name = "NormalizeError";
    }
}

/** Clock skew between us and a platform's servers. Beyond this, a future date is an error. */
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

/** Nothing social predates this. A date below it means we parsed garbage. */
const EARLIEST_PLAUSIBLE = new Date("2005-01-01T00:00:00Z");

const MEDIA_TYPES: ReadonlySet<string> = new Set([
    "REEL_SHORT_VIDEO",
    "LONG_FORM_VIDEO",
    "CAROUSEL",
    "SINGLE_IMAGE",
    "TEXT_ONLY",
    "LINK",
    "LIVE",
]);

const PLATFORMS: ReadonlySet<string> = new Set(["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"]);

/**
 * Metrics are nullable by design — platforms genuinely disagree about what they
 * expose, and "absent" must stay distinguishable from "zero". A post with no
 * share count is not a post with no shares, and averaging the second into the
 * first would quietly understate every rate it touches.
 */
function metric(value: number | null | undefined, field: string, postId: string): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new NormalizeError(postId, `${field} is not a finite number: ${String(value)}`);
    }
    if (value < 0) {
        throw new NormalizeError(postId, `${field} is negative: ${value}`);
    }
    // Some APIs return rounded floats ("1.2K" expanded to 1200.0). Integers downstream.
    return Math.round(value);
}

function text(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

export function normalizePost(raw: RawPost): NormalizedPost {
    const postId = text(raw.postId);
    if (!postId) {
        throw new NormalizeError("<missing>", "postId is empty — cannot key the row for idempotent upsert");
    }

    if (!PLATFORMS.has(raw.platform)) {
        throw new NormalizeError(postId, `unknown platform: ${raw.platform}`);
    }
    if (!MEDIA_TYPES.has(raw.mediaType)) {
        throw new NormalizeError(postId, `unknown mediaType: ${raw.mediaType}`);
    }

    const postedAt = new Date(raw.postedAt);
    if (Number.isNaN(postedAt.getTime())) {
        throw new NormalizeError(postId, `unparseable postedAt: ${raw.postedAt}`);
    }
    if (postedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
        throw new NormalizeError(postId, `postedAt is in the future: ${postedAt.toISOString()}`);
    }
    if (postedAt < EARLIEST_PLAUSIBLE) {
        throw new NormalizeError(postId, `postedAt is implausibly old: ${postedAt.toISOString()}`);
    }

    // Stored as an instant. Local-time analysis (FR7) converts using Account.timezone
    // at query time — the zone is a property of the account, not of the post.
    const permalink = text(raw.permalink);
    if (permalink && !/^https?:\/\//i.test(permalink)) {
        throw new NormalizeError(postId, `permalink is not an http(s) URL: ${permalink}`);
    }

    const m = raw.metrics ?? {};

    return {
        platform: raw.platform,
        postId,
        postedAt,
        mediaType: raw.mediaType,
        caption: text(raw.caption),
        permalink,
        likes: metric(m.likes, "likes", postId),
        comments: metric(m.comments, "comments", postId),
        shares: metric(m.shares, "shares", postId),
        views: metric(m.views, "views", postId),
        saves: metric(m.saves, "saves", postId),
        isSynthetic: raw.isSynthetic === true,
    };
}

export interface NormalizeBatchResult {
    posts: NormalizedPost[];
    failures: { postId: string; reason: string }[];
}

/** Normalise a batch, collecting failures rather than throwing on the first bad row. */
export function normalizePosts(raws: RawPost[]): NormalizeBatchResult {
    const posts: NormalizedPost[] = [];
    const failures: { postId: string; reason: string }[] = [];

    for (const raw of raws) {
        try {
            posts.push(normalizePost(raw));
        } catch (error) {
            const e = error as NormalizeError;
            failures.push({ postId: e.postId ?? "<unknown>", reason: e.message });
        }
    }

    return { posts, failures };
}
