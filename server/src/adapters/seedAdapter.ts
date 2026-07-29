// Seed adapter — generates the synthetic corpus for platforms without live access.
//
// WHY THIS FILE IS MORE THAN A RANDOM NUMBER GENERATOR
//
// The point of seeded data here is not "make the dashboard non-empty". It is to
// contain *discoverable truth*: patterns that the analytics engine must find and
// the AI layer must cite. If likes were drawn at random, format analysis would
// correctly report "no format is better" and the recommendations would be vacuous
// — which is exactly the failure mode this project is judged on.
//
// So the model runs in the same direction reality does:
//
//     reach        = followers x reachFactor(format)          <- how many saw it
//     interactions = reach x BASE_ER x format x hour x day x theme x noise
//
// and NOT `views = likes * k`. That ordering matters: engagement RATE is
// interactions/reach, so if reach were derived from interactions the rate would
// cancel out to noise no matter how much signal the raw counts appeared to have.
// Generating reach first means the rate carries the planted multipliers.
//
// Every multiplier below is a deliberately planted fact. The analytics engine is
// correct if and only if it recovers them, which also makes them the fixtures for
// the Day 2 analytics tests.

import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

type Platform = RawPost["platform"];
type MediaType = RawPost["mediaType"];
type Theme =
    | "POLICY_ANNOUNCEMENT"
    | "CONSTITUENCY_VISIT"
    | "PERSONAL_FAMILY"
    | "ATTACK_REBUTTAL"
    | "FESTIVAL_GREETING"
    | "ACHIEVEMENT_CLAIM"
    | "MEDIA_APPEARANCE";

// ── The planted patterns ─────────────────────────────────────────────────
// Documented here so a reviewer can check the engine against them directly.

/** Baseline engagement rate before any multiplier: 3.2% of reach interacts. */
const BASE_ER = 0.032;

/** PLANT: short video earns; link-outs and static images do not. */
const FORMAT_QUALITY: Record<MediaType, number> = {
    REEL_SHORT_VIDEO: 1.9,
    CAROUSEL: 1.25,
    LIVE: 1.1,
    TEXT_ONLY: 1.0,
    LONG_FORM_VIDEO: 0.85,
    SINGLE_IMAGE: 0.75,
    LINK: 0.55, // platforms suppress off-site links; the data should show it
};

/** How far a format travels, independent of how well it engages. */
const FORMAT_REACH: Record<MediaType, number> = {
    REEL_SHORT_VIDEO: 0.55,
    LIVE: 0.12,
    CAROUSEL: 0.3,
    SINGLE_IMAGE: 0.28,
    TEXT_ONLY: 0.25,
    LONG_FORM_VIDEO: 0.18,
    LINK: 0.15,
};

/** PLANT: a sharp 7-9pm IST peak, a dead overnight window. Hour is LOCAL time. */
const HOUR_QUALITY: Record<number, number> = {
    0: 0.45, 1: 0.4, 2: 0.35, 3: 0.35, 4: 0.4, 5: 0.55,
    6: 0.8, 7: 0.95, 8: 1.05, 9: 1.0, 10: 0.9, 11: 0.85,
    12: 1.1, 13: 1.15, 14: 1.0, 15: 0.85, 16: 0.85, 17: 0.95,
    18: 1.3, 19: 1.75, 20: 1.85, 21: 1.6, 22: 1.15, 23: 0.7,
};

/** PLANT: midweek outperforms; the weekend sags. Index 0 = Sunday. */
const DAY_QUALITY: Record<number, number> = {
    0: 0.85, 1: 1.0, 2: 1.12, 3: 1.1, 4: 1.12, 5: 0.95, 6: 0.82,
};

/** PLANT: conflict and personal content travel; greetings and self-praise do not. */
const THEME_QUALITY: Record<Theme, number> = {
    ATTACK_REBUTTAL: 1.5,
    PERSONAL_FAMILY: 1.35,
    MEDIA_APPEARANCE: 1.15,
    CONSTITUENCY_VISIT: 1.0,
    POLICY_ANNOUNCEMENT: 0.9,
    ACHIEVEMENT_CLAIM: 0.8,
    FESTIVAL_GREETING: 0.7,
};

/** Roughly 1 post in 25 goes unusually wide — gives the outlier flag something real to catch. */
const VIRAL_RATE = 0.04;
const VIRAL_BOOST = 6.5;

// ── The demo cast ────────────────────────────────────────────────────────
// Per-account behaviour, keyed by handle. This is what makes competitor gap
// analysis (a Module C MUST) find something instead of comparing four accounts
// drawn from one identical distribution.
//
// THE CENTRAL PLANTED GAP: the principal posts policy and media appearances at
// safe daytime hours and rarely uses short video. Two competitors lean on
// ATTACK_REBUTTAL and PERSONAL_FAMILY — the two highest-performing themes — and
// post reels in the evening peak. That gap is the headline finding the pipeline
// is supposed to surface on its own.

interface SeedProfile {
    /**
     * Handle fragments that resolve to this profile. Needed because handles differ
     * per platform and do not reliably contain the person's name — @priyankac19 on
     * X, priyankachaturvedi on Facebook. Matching on the person, not the string.
     */
    aliases: string[];
    followerBand: [number, number];
    postsPer90Days: number;
    formatMix: Partial<Record<MediaType, number>>;
    themeMix: Partial<Record<Theme, number>>;
    /** Local hours this account actually posts at, sampled uniformly. */
    postingHours: number[];
}

const DEFAULT_PROFILE: SeedProfile = {
    aliases: [],
    followerBand: [400_000, 900_000],
    postsPer90Days: 55,
    formatMix: { SINGLE_IMAGE: 3, TEXT_ONLY: 3, CAROUSEL: 2, REEL_SHORT_VIDEO: 2, LINK: 1, LONG_FORM_VIDEO: 1 },
    themeMix: { POLICY_ANNOUNCEMENT: 3, CONSTITUENCY_VISIT: 3, MEDIA_APPEARANCE: 2, ACHIEVEMENT_CLAIM: 2, FESTIVAL_GREETING: 1 },
    postingHours: [9, 11, 13, 15, 17, 19, 20],
};

const SEED_PROFILES: Record<string, SeedProfile> = {
    // PRINCIPAL — high volume, text- and link-heavy, daytime, policy-dominated.
    // Deliberately weak where the data says the wins are: few reels, no
    // ATTACK_REBUTTAL, no PERSONAL_FAMILY, and posts mostly before the evening peak.
    tharoor: {
        aliases: ["tharoor"],
        followerBand: [1_800_000, 1_800_000],
        postsPer90Days: 96, // flooding — cadence analysis should notice the dilution
        formatMix: { TEXT_ONLY: 5, LINK: 4, SINGLE_IMAGE: 4, CAROUSEL: 2, LONG_FORM_VIDEO: 2, REEL_SHORT_VIDEO: 1 },
        themeMix: { POLICY_ANNOUNCEMENT: 5, MEDIA_APPEARANCE: 4, ACHIEVEMENT_CLAIM: 3, CONSTITUENCY_VISIT: 2, FESTIVAL_GREETING: 2 },
        postingHours: [8, 9, 10, 11, 12, 13, 14, 15, 16],
    },

    // COMPETITOR — reel-forward, evening poster, heavy on rebuttal content.
    // The "what's working for them, not for us" case.
    chaturvedi: {
        aliases: ["chaturvedi", "priyankac"],
        followerBand: [1_100_000, 1_100_000],
        postsPer90Days: 62,
        formatMix: { REEL_SHORT_VIDEO: 5, TEXT_ONLY: 3, SINGLE_IMAGE: 2, CAROUSEL: 2, LONG_FORM_VIDEO: 1 },
        themeMix: { ATTACK_REBUTTAL: 5, MEDIA_APPEARANCE: 4, POLICY_ANNOUNCEMENT: 2, PERSONAL_FAMILY: 2, CONSTITUENCY_VISIT: 1 },
        postingHours: [18, 19, 20, 20, 21, 21, 13],
    },

    // COMPETITOR — low volume, high craft. Carousels and long-form, personal content.
    // The counter-example to "post more": under-posts and still performs.
    varungandhi: {
        aliases: ["varungandhi", "varunferozegandhi"],
        followerBand: [1_400_000, 1_400_000],
        postsPer90Days: 31,
        formatMix: { CAROUSEL: 4, LONG_FORM_VIDEO: 3, TEXT_ONLY: 3, SINGLE_IMAGE: 2, REEL_SHORT_VIDEO: 2 },
        themeMix: { PERSONAL_FAMILY: 4, POLICY_ANNOUNCEMENT: 4, CONSTITUENCY_VISIT: 3, ACHIEVEMENT_CLAIM: 1 },
        postingHours: [19, 20, 21, 12],
    },

    // COMPETITOR — video-native, ground-level, evening peak.
    kanhaiyakumar: {
        aliases: ["kanhaiyakumar", "kanhaiya"],
        followerBand: [900_000, 900_000],
        postsPer90Days: 74,
        formatMix: { REEL_SHORT_VIDEO: 6, LIVE: 2, LONG_FORM_VIDEO: 2, SINGLE_IMAGE: 2, TEXT_ONLY: 1 },
        themeMix: { ATTACK_REBUTTAL: 4, CONSTITUENCY_VISIT: 4, PERSONAL_FAMILY: 2, ACHIEVEMENT_CLAIM: 2, FESTIVAL_GREETING: 1 },
        postingHours: [17, 18, 19, 20, 21, 22],
    },
};

/**
 * Which formats each platform actually has. Without this the corpus contains
 * carousels and text-only posts on YouTube, which is both obviously wrong to any
 * reviewer and quietly corrupting: per-platform format analysis would report on
 * formats that cannot exist there.
 *
 * An account's formatMix is intersected with this, then re-weighted — so posting
 * habits stay a property of the person while the menu stays a property of the
 * platform. A text-forward principal is text-forward on X and long-form on
 * YouTube, which is what actually happens.
 */
const PLATFORM_FORMATS: Record<Platform, MediaType[]> = {
    // Shorts, regular uploads, streams. Community posts exist but the Data API
    // does not expose them usefully, so they are out of scope rather than faked.
    YOUTUBE: ["REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"],
    INSTAGRAM: ["REEL_SHORT_VIDEO", "CAROUSEL", "SINGLE_IMAGE", "LONG_FORM_VIDEO", "LIVE"],
    X: ["TEXT_ONLY", "LINK", "SINGLE_IMAGE", "CAROUSEL", "REEL_SHORT_VIDEO"],
    FACEBOOK: ["TEXT_ONLY", "LINK", "SINGLE_IMAGE", "CAROUSEL", "REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"],
};

/** The account's habits, restricted to what this platform can actually publish. */
function formatMixFor(platform: Platform, profile: SeedProfile): Partial<Record<MediaType, number>> {
    const allowed = PLATFORM_FORMATS[platform];
    const mix: Partial<Record<MediaType, number>> = {};

    for (const [format, weight] of Object.entries(profile.formatMix) as [MediaType, number][]) {
        if (allowed.includes(format)) mix[format] = weight;
    }

    // An account whose entire habit is unavailable here still has to post something.
    if (Object.keys(mix).length === 0) mix[allowed[0]!] = 1;

    return mix;
}

/** Handles differ per platform (@ShashiTharoor, ShashiTharoorOfficial, ...). Match on the person. */
function profileFor(handle: string): SeedProfile {
    const key = handle.toLowerCase().replace(/[^a-z]/g, "");
    for (const profile of Object.values(SEED_PROFILES)) {
        if (profile.aliases.some((alias) => key.includes(alias))) return profile;
    }
    return DEFAULT_PROFILE;
}

// ── Caption bank ─────────────────────────────────────────────────────────
// Captions are written to be genuinely classifiable into their theme, because
// the theme is NOT emitted on RawPost — the AI layer (Module D) has to infer it
// from this text. That makes classification a real step with a checkable answer:
// the planted theme mix is the ground truth its output can be measured against.

const CAPTIONS: Record<Theme, string[]> = {
    POLICY_ANNOUNCEMENT: [
        "Tabled my submission on the proposed amendments to the data protection framework today. The full text of my intervention is linked below.",
        "Raised the question of pending disbursements under the rural employment scheme in the House this morning. Awaiting a written reply from the ministry.",
        "My detailed position on the new education funding formula, and why the per-student allocation needs revisiting before the next cycle.",
        "Spoke in the Standing Committee on the healthcare infrastructure gap in tier-two districts. Three specific recommendations submitted.",
    ],
    CONSTITUENCY_VISIT: [
        "Spent the morning at the coastal ward hearing residents on the drainage work that has been pending since the monsoon. Escalating to the corporation this week.",
        "At the weekly grievance camp today. Forty-two cases heard, most on pension delays and ration card corrections.",
        "Visited the primary health centre after repeated complaints about staffing. Two vacancies confirmed; taking it up with the district administration.",
        "Walked the market road with local traders to see the encroachment problem first-hand rather than from a file.",
    ],
    PERSONAL_FAMILY: [
        "My father would have turned eighty-four today. He taught me that an argument you cannot make politely is usually an argument you have not thought through.",
        "A rare quiet Sunday at home, and the first book I have finished cover to cover in two months.",
        "Twenty-six years ago today. She has put up with far more than any manifesto ever promised her.",
        "My daughter asked me why politicians shout on television. I did not have a good answer for her.",
    ],
    ATTACK_REBUTTAL: [
        "The minister's claim in this morning's press conference does not survive contact with his own department's annual report. Page 47, table 3.",
        "I have been accused of opposing development. I opposed one contract, awarded without tender, to a firm incorporated four months earlier. That is not the same thing.",
        "Three separate figures for the same scheme in three separate speeches this week. The House deserves to know which one is true.",
        "Responding to yesterday's allegations point by point, because letting them stand unanswered is how they become received wisdom.",
    ],
    FESTIVAL_GREETING: [
        "Wishing everyone peace and good health this festival season. May the year ahead be kinder than the one behind us.",
        "Warm greetings to all celebrating today. May the light find every home.",
        "Wishing you and your families a joyous festival. Celebrate safely.",
        "Greetings on this auspicious occasion to everyone across the constituency and beyond.",
    ],
    ACHIEVEMENT_CLAIM: [
        "The bridge sanctioned three years ago is now open to traffic. Eleven thousand people no longer take the long detour.",
        "Pleased to report that the scholarship backlog we raised last session has been cleared. 1,340 students paid out.",
        "The new water connection project has reached its final ward. Full coverage for the first time.",
        "Our constituency office has now processed over nine thousand citizen grievances this year.",
    ],
    MEDIA_APPEARANCE: [
        "My conversation on the state of parliamentary debate, and why the quality of disagreement matters more than its volume. Full interview linked.",
        "On the panel this evening discussing the fiscal implications of the new scheme. Joining from Delhi.",
        "Excerpts from this morning's interview on foreign policy and the shifting position in the region.",
        "Spoke at the literature festival on language, politics and the uses of precision. Recording to follow.",
    ],
};

// ── Deterministic randomness ─────────────────────────────────────────────
// Seeded, not Math.random(), for three reasons: re-running the seed produces the
// same corpus (so demo numbers do not shift between the video and the README),
// the follower denominator stays put, and the analytics tests get stable fixtures.

function stableHash(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** mulberry32 — small, fast, good enough for fixtures. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(rng: () => number, items: T[]): T {
    return items[Math.floor(rng() * items.length)]!;
}

/** Weighted pick — the format and theme mixes are weights, not uniform lists. */
function pickWeighted<T extends string>(rng: () => number, weights: Partial<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;
    for (const [key, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return key;
    }
    return entries[entries.length - 1]![0];
}

/** Log-normal-ish jitter. Real engagement is right-skewed, not symmetric. */
function noise(rng: () => number): number {
    return Math.exp((rng() + rng() + rng() - 1.5) * 0.55);
}

// ── Platform metric availability ─────────────────────────────────────────
// Platforms genuinely disagree about what they expose, and the schema made every
// metric nullable for that reason. Honouring it here means the null-handling in
// the analytics layer is exercised by the seed data rather than only in theory.

function hasViews(platform: Platform, mediaType: MediaType): boolean {
    if (platform === "YOUTUBE") return true;
    if (platform === "X") return true; // X shows public impressions on all posts
    return mediaType === "REEL_SHORT_VIDEO" || mediaType === "LONG_FORM_VIDEO" || mediaType === "LIVE";
}

const HAS_SHARES: Record<Platform, boolean> = { INSTAGRAM: false, FACEBOOK: true, X: true, YOUTUBE: false };
const HAS_SAVES: Record<Platform, boolean> = { INSTAGRAM: true, FACEBOOK: false, X: false, YOUTUBE: false };

// ── The adapter ──────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function createSeedAdapter(platform: Platform): SocialAdapter {
    return {
        platform,
        source: "seed",

        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const profile = profileFor(accountHandle);
            const rng = makeRng(stableHash(`meta:${platform}:${accountHandle}`));
            const [lo, hi] = profile.followerBand;
            return {
                platform,
                accountHandle,
                displayName: accountHandle,
                // Stable across runs: this is the engagement-rate denominator, and a
                // denominator that moved between seeds would make the headline metric
                // jump for no reason.
                followerCount: Math.round(lo + rng() * (hi - lo)),
                isSynthetic: true,
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            const profile = profileFor(accountHandle);
            const rng = makeRng(stableHash(`posts:${platform}:${accountHandle}`));
            const { followerCount } = await this.fetchAccountMeta(accountHandle);
            const followers = followerCount ?? 500_000;

            const formatMix = formatMixFor(platform, profile);
            const posts: RawPost[] = [];

            for (let i = 0; i < profile.postsPer90Days; i++) {
                const mediaType = pickWeighted<MediaType>(rng, formatMix);
                const theme = pickWeighted<Theme>(rng, profile.themeMix);

                // Place the post at a local hour this account actually posts at, then
                // convert to the UTC instant the schema stores. Posting-hour choice is
                // an account habit; the engagement multiplier is a property of the hour.
                const daysAgo = Math.floor(rng() * 90);
                const localHour = pick(rng, profile.postingHours);
                const localMinute = Math.floor(rng() * 60);

                const local = new Date(Date.now() - daysAgo * 86_400_000);
                local.setUTCHours(localHour, localMinute, 0, 0);
                const postedAt = new Date(local.getTime() - IST_OFFSET_MS);
                const localDayOfWeek = local.getUTCDay();

                // reach first, interactions second — see the note at the top of the file
                const viral = rng() < VIRAL_RATE;
                const reach = Math.round(
                    followers * FORMAT_REACH[mediaType] * noise(rng) * (viral ? VIRAL_BOOST : 1),
                );

                const rate =
                    BASE_ER *
                    FORMAT_QUALITY[mediaType] *
                    HOUR_QUALITY[localHour]! *
                    DAY_QUALITY[localDayOfWeek]! *
                    THEME_QUALITY[theme] *
                    noise(rng);

                const interactions = Math.max(1, Math.round(reach * rate));

                // Split into the individual metrics, then null out whatever this
                // platform does not actually expose.
                const likes = Math.round(interactions * 0.8);
                const comments = Math.round(interactions * 0.07);
                const shares = Math.round(interactions * 0.08);
                const saves = Math.round(interactions * 0.05);

                posts.push({
                    platform,
                    accountHandle,
                    postId: `seed_${platform.toLowerCase()}_${accountHandle}_${i}`,
                    postedAt: postedAt.toISOString(),
                    mediaType,
                    caption: `[synthetic] ${pick(rng, CAPTIONS[theme])}`,
                    permalink: null, // nothing real to link to
                    metrics: {
                        likes,
                        comments,
                        shares: HAS_SHARES[platform] ? shares : null,
                        views: hasViews(platform, mediaType) ? reach : null,
                        saves: HAS_SAVES[platform] ? saves : null,
                    },
                    isSynthetic: true,
                });
            }

            return posts.filter((p) => new Date(p.postedAt) >= sinceDate);
        },
    };
}
