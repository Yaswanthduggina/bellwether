// FR16, parsed once.
//
// Every analytics route accepts the same filter block. Implemented here rather
// than in each route for a reason that is not tidiness: six routes each writing
// their own query parsing is six chances for the timing panel and the format
// panel to be filtering different corpora while showing the same header, and
// nothing in the UI would reveal it.
//
// Unknown query parameters are REJECTED rather than ignored. A dashboard that
// silently drops `?platfrom=X` renders the unfiltered corpus under a filtered
// heading — a wrong number with no error attached, which is the worst failure
// mode this product has.

import type { Request } from "express";
import type { CorpusFilter } from "../analytics/corpus";
import type { MediaType, Platform } from "../analytics/engagement";
import type { ContentPillar } from "../analytics/gaps";
import { ApiError } from "./http";

const PLATFORMS: readonly Platform[] = ["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"];

const MEDIA_TYPES: readonly MediaType[] = [
    "REEL_SHORT_VIDEO",
    "LONG_FORM_VIDEO",
    "CAROUSEL",
    "SINGLE_IMAGE",
    "TEXT_ONLY",
    "LINK",
    "LIVE",
];

const THEMES: readonly ContentPillar[] = [
    "POLICY_ANNOUNCEMENT",
    "CONSTITUENCY_VISIT",
    "PERSONAL_FAMILY",
    "ATTACK_REBUTTAL",
    "FESTIVAL_GREETING",
    "ACHIEVEMENT_CLAIM",
    "MEDIA_APPEARANCE",
    "OTHER",
];

const KNOWN_KEYS = new Set([
    "accountId",
    "personName",
    "platform",
    "mediaType",
    "theme",
    "from",
    "to",
    "liveOnly",
    // Not a filter — it does not change WHICH posts a route considers, only how
    // many of them come back, and `parseFilter` ignores it entirely. It is
    // listed here because the guard above rejects anything it does not
    // recognise, and two routes (`/top-posts`, `/recent-posts`) legitimately
    // read it off the same query string. Without this entry `?count=3` is a
    // 400 UNKNOWN_FILTER, which is what `/top-posts` quietly did for as long as
    // nothing exercised its documented parameter.
    "count",
]);

function readOne(req: Request, key: string): string | undefined {
    const value = req.query[key];
    if (value === undefined) return undefined;
    // Express parses `?platform=X&platform=Y` into an array. Two conflicting
    // values for one filter is a caller bug, and picking one would produce a
    // result the caller cannot explain.
    if (Array.isArray(value)) {
        throw ApiError.badRequest("DUPLICATE_FILTER", `Filter "${key}" was given more than once.`);
    }
    const text = String(value).trim();
    return text === "" ? undefined : text;
}

function readEnum<T extends string>(req: Request, key: string, allowed: readonly T[]): T | undefined {
    const value = readOne(req, key);
    if (value === undefined) return undefined;

    const upper = value.toUpperCase() as T;
    if (!allowed.includes(upper)) {
        throw ApiError.badRequest("INVALID_FILTER", `"${value}" is not a valid ${key}.`, { allowed });
    }
    return upper;
}

function readDate(req: Request, key: string): Date | undefined {
    const value = readOne(req, key);
    if (value === undefined) return undefined;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw ApiError.badRequest("INVALID_FILTER", `"${value}" is not a valid date for ${key}.`, {
            expected: "an ISO 8601 date, e.g. 2026-05-01 or 2026-05-01T00:00:00Z",
        });
    }
    return date;
}

/**
 * Parse and validate the filter block from a request's query string.
 *
 * Throws rather than coercing. Every rejection names the offending value and
 * what was expected, because these errors surface in a UI where the user
 * typed the filter and can fix it if told what is wrong.
 */
export function parseFilter(req: Request): CorpusFilter {
    for (const key of Object.keys(req.query)) {
        if (!KNOWN_KEYS.has(key)) {
            throw ApiError.badRequest("UNKNOWN_FILTER", `Unknown filter "${key}".`, {
                known: [...KNOWN_KEYS].sort(),
            });
        }
    }

    const filter: CorpusFilter = {};

    const accountId = readOne(req, "accountId");
    if (accountId !== undefined) filter.accountId = accountId;

    const personName = readOne(req, "personName");
    if (personName !== undefined) filter.personName = personName;

    const platform = readEnum(req, "platform", PLATFORMS);
    if (platform !== undefined) filter.platform = platform;

    const mediaType = readEnum(req, "mediaType", MEDIA_TYPES);
    if (mediaType !== undefined) filter.mediaType = mediaType;

    const theme = readEnum(req, "theme", THEMES);
    if (theme !== undefined) filter.theme = theme;

    const from = readDate(req, "from");
    if (from !== undefined) filter.from = from;

    const to = readDate(req, "to");
    if (to !== undefined) filter.to = to;

    if (filter.from && filter.to && filter.from > filter.to) {
        throw ApiError.badRequest("INVALID_RANGE", `"from" (${readOne(req, "from")}) is after "to" (${readOne(req, "to")}).`);
    }

    const liveOnly = readOne(req, "liveOnly");
    if (liveOnly !== undefined) {
        if (liveOnly !== "true" && liveOnly !== "false") {
            throw ApiError.badRequest("INVALID_FILTER", `liveOnly must be "true" or "false", got "${liveOnly}".`);
        }
        if (liveOnly === "true") filter.liveOnly = true;
    }

    return filter;
}

export { PLATFORMS, MEDIA_TYPES, THEMES };
