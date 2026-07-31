// A corpus with known answers, for testing the analytics engine against.
//
// WHY THIS EXISTS, AND WHY IT IS NOT AN ADAPTER
//
// The seed adapter this replaces could be pointed at the ingestion pipeline, so
// generated rows could reach the database and be presented as real. That was the
// reason to delete it. Nothing here can: this module emits plain analytics rows,
// implements no adapter interface, is not exported from `src/adapters`, and lives
// under `__tests__` where the production build never looks.
//
// What it keeps is the part that was actually load-bearing — a corpus containing
// *discoverable truth*. If a test corpus is drawn at random, format analysis
// correctly reports "no format is better", timing analysis correctly reports "no
// hour is better", and every assertion downstream degenerates into "it returned a
// number". Planting known multipliers and asserting the engine recovers them is
// the difference between a tested pipeline and one that has merely been run.
//
// The generative model runs in the direction reality does:
//
//     reach        = followers x reachFactor(format)          <- how many saw it
//     interactions = reach x BASE_ER x format x hour x day x theme x noise
//
// and NOT `views = likes * k`. That ordering matters: engagement RATE is
// interactions/reach, so if reach were derived from interactions the rate would
// cancel to noise no matter how much signal the raw counts appeared to carry.
//
// Captions are gone with the adapter. They were there so the AI layer had text to
// classify; no test in this suite reads them, and inventing quotable political
// prose is exactly the kind of artefact that should not survive in a repo whose
// rule is that displayed data is real.

type Platform = "YOUTUBE" | "INSTAGRAM" | "X" | "FACEBOOK";
type MediaType =
    | "REEL_SHORT_VIDEO"
    | "LONG_FORM_VIDEO"
    | "CAROUSEL"
    | "SINGLE_IMAGE"
    | "TEXT_ONLY"
    | "LINK"
    | "LIVE";
type Theme =
    | "POLICY_ANNOUNCEMENT"
    | "CONSTITUENCY_VISIT"
    | "PERSONAL_FAMILY"
    | "ATTACK_REBUTTAL"
    | "FESTIVAL_GREETING"
    | "ACHIEVEMENT_CLAIM"
    | "MEDIA_APPEARANCE";

// ── The planted patterns ─────────────────────────────────────────────────
// Exported so a test can assert against the constant rather than a magic number,
// which keeps the test honest if a multiplier is ever retuned.

/** Baseline engagement rate before any multiplier: 3.2% of reach interacts. */
export const BASE_ER = 0.032;

/** PLANT: short video earns; link-outs and static images do not. */
export const FORMAT_QUALITY: Record<MediaType, number> = {
    REEL_SHORT_VIDEO: 1.9,
    CAROUSEL: 1.25,
    LIVE: 1.1,
    TEXT_ONLY: 1.0,
    LONG_FORM_VIDEO: 0.85,
    SINGLE_IMAGE: 0.75,
    LINK: 0.55, // platforms suppress off-site links; the data should show it
};

/** How far a format travels, independent of how well it engages. */
export const FORMAT_REACH: Record<MediaType, number> = {
    REEL_SHORT_VIDEO: 0.55,
    LIVE: 0.12,
    CAROUSEL: 0.3,
    SINGLE_IMAGE: 0.28,
    TEXT_ONLY: 0.25,
    LONG_FORM_VIDEO: 0.18,
    LINK: 0.15,
};

/** PLANT: a sharp 7-9pm IST peak, a dead overnight window. Hour is LOCAL time. */
export const HOUR_QUALITY: Record<number, number> = {
    0: 0.45, 1: 0.4, 2: 0.35, 3: 0.35, 4: 0.4, 5: 0.55,
    6: 0.8, 7: 0.95, 8: 1.05, 9: 1.0, 10: 0.9, 11: 0.85,
    12: 1.1, 13: 1.15, 14: 1.0, 15: 0.85, 16: 0.85, 17: 0.95,
    18: 1.3, 19: 1.75, 20: 1.85, 21: 1.6, 22: 1.15, 23: 0.7,
};

/** PLANT: midweek outperforms; the weekend sags. Index 0 = Sunday. */
export const DAY_QUALITY: Record<number, number> = {
    0: 0.85, 1: 1.0, 2: 1.12, 3: 1.1, 4: 1.12, 5: 0.95, 6: 0.82,
};

/** PLANT: conflict and personal content travel; greetings and self-praise do not. */
export const THEME_QUALITY: Record<Theme, number> = {
    ATTACK_REBUTTAL: 1.5,
    PERSONAL_FAMILY: 1.35,
    MEDIA_APPEARANCE: 1.15,
    CONSTITUENCY_VISIT: 1.0,
    POLICY_ANNOUNCEMENT: 0.9,
    ACHIEVEMENT_CLAIM: 0.8,
    FESTIVAL_GREETING: 0.7,
};

/** Roughly 1 post in 25 goes unusually wide — gives the outlier logic something real to catch. */
export const VIRAL_RATE = 0.04;
export const VIRAL_BOOST = 6.5;

// ── The cast ─────────────────────────────────────────────────────────────
// Per-account behaviour. Four accounts drawn from one identical distribution
// would make every cross-account assertion vacuous, so each has distinct habits.
//
// THE CENTRAL PLANTED GAP: the principal posts policy and media appearances at
// safe daytime hours and rarely uses short video. Two of the others lean on
// ATTACK_REBUTTAL and PERSONAL_FAMILY — the two highest-performing themes — and
// post reels in the evening peak.

interface Profile {
    /** Handle fragments that resolve to this profile — handles differ per platform. */
    aliases: string[];
    followerBand: [number, number];
    postsPer90Days: number;
    formatMix: Partial<Record<MediaType, number>>;
    themeMix: Partial<Record<Theme, number>>;
    /** Local hours this account actually posts at, sampled uniformly. */
    postingHours: number[];
}

const DEFAULT_PROFILE: Profile = {
    aliases: [],
    followerBand: [400_000, 900_000],
    postsPer90Days: 55,
    formatMix: { SINGLE_IMAGE: 3, TEXT_ONLY: 3, CAROUSEL: 2, REEL_SHORT_VIDEO: 2, LINK: 1, LONG_FORM_VIDEO: 1 },
    themeMix: { POLICY_ANNOUNCEMENT: 3, CONSTITUENCY_VISIT: 3, MEDIA_APPEARANCE: 2, ACHIEVEMENT_CLAIM: 2, FESTIVAL_GREETING: 1 },
    postingHours: [9, 11, 13, 15, 17, 19, 20],
};

const PROFILES: Record<string, Profile> = {
    // PRINCIPAL — high volume, text- and link-heavy, daytime, policy-dominated.
    // Deliberately weak where the data says the wins are.
    tharoor: {
        aliases: ["tharoor"],
        followerBand: [1_800_000, 1_800_000],
        postsPer90Days: 96, // flooding — cadence analysis should notice the dilution
        formatMix: { TEXT_ONLY: 5, LINK: 4, SINGLE_IMAGE: 4, CAROUSEL: 2, LONG_FORM_VIDEO: 2, REEL_SHORT_VIDEO: 1 },
        themeMix: { POLICY_ANNOUNCEMENT: 5, MEDIA_APPEARANCE: 4, ACHIEVEMENT_CLAIM: 3, CONSTITUENCY_VISIT: 2, FESTIVAL_GREETING: 2 },
        postingHours: [8, 9, 10, 11, 12, 13, 14, 15, 16],
    },

    // Reel-forward, evening poster, heavy on rebuttal content.
    chaturvedi: {
        aliases: ["chaturvedi", "priyankac"],
        followerBand: [1_100_000, 1_100_000],
        postsPer90Days: 62,
        formatMix: { REEL_SHORT_VIDEO: 5, TEXT_ONLY: 3, SINGLE_IMAGE: 2, CAROUSEL: 2, LONG_FORM_VIDEO: 1 },
        themeMix: { ATTACK_REBUTTAL: 5, MEDIA_APPEARANCE: 4, POLICY_ANNOUNCEMENT: 2, PERSONAL_FAMILY: 2, CONSTITUENCY_VISIT: 1 },
        postingHours: [18, 19, 20, 20, 21, 21, 13],
    },

    // Low volume, high craft. The counter-example to "post more".
    varungandhi: {
        aliases: ["varungandhi", "varunferozegandhi"],
        followerBand: [1_400_000, 1_400_000],
        postsPer90Days: 31,
        formatMix: { CAROUSEL: 4, LONG_FORM_VIDEO: 3, TEXT_ONLY: 3, SINGLE_IMAGE: 2, REEL_SHORT_VIDEO: 2 },
        themeMix: { PERSONAL_FAMILY: 4, POLICY_ANNOUNCEMENT: 4, CONSTITUENCY_VISIT: 3, ACHIEVEMENT_CLAIM: 1 },
        postingHours: [19, 20, 21, 12],
    },

    // Video-native, ground-level, evening peak.
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
 * carousels on YouTube, and per-platform format analysis would be tested against
 * formats that cannot exist there.
 *
 * An account's formatMix is intersected with this, so posting habits stay a
 * property of the person while the menu stays a property of the platform.
 */
const PLATFORM_FORMATS: Record<Platform, MediaType[]> = {
    YOUTUBE: ["REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"],
    INSTAGRAM: ["REEL_SHORT_VIDEO", "CAROUSEL", "SINGLE_IMAGE", "LONG_FORM_VIDEO", "LIVE"],
    X: ["TEXT_ONLY", "LINK", "SINGLE_IMAGE", "CAROUSEL", "REEL_SHORT_VIDEO"],
    FACEBOOK: ["TEXT_ONLY", "LINK", "SINGLE_IMAGE", "CAROUSEL", "REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"],
};

function formatMixFor(platform: Platform, profile: Profile): Partial<Record<MediaType, number>> {
    const allowed = PLATFORM_FORMATS[platform];
    const mix: Partial<Record<MediaType, number>> = {};

    for (const [format, weight] of Object.entries(profile.formatMix) as [MediaType, number][]) {
        if (allowed.includes(format)) mix[format] = weight;
    }

    if (Object.keys(mix).length === 0) mix[allowed[0]!] = 1;
    return mix;
}

function profileFor(handle: string): Profile {
    const key = handle.toLowerCase().replace(/[^a-z]/g, "");
    for (const profile of Object.values(PROFILES)) {
        if (profile.aliases.some((alias) => key.includes(alias))) return profile;
    }
    return DEFAULT_PROFILE;
}

// ── Deterministic randomness ─────────────────────────────────────────────
// Seeded, not Math.random(): a fixture that changes between runs turns a real
// regression and a reroll into the same red test.

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
// metric nullable for that reason. Honouring it here means the null-handling and
// the mixed-basis guard are exercised by the fixture rather than only in theory.

function hasViews(platform: Platform, mediaType: MediaType): boolean {
    if (platform === "YOUTUBE") return true;
    if (platform === "X") return true; // X shows public impressions on all posts
    return mediaType === "REEL_SHORT_VIDEO" || mediaType === "LONG_FORM_VIDEO" || mediaType === "LIVE";
}

const HAS_SHARES: Record<Platform, boolean> = { INSTAGRAM: false, FACEBOOK: true, X: true, YOUTUBE: false };
const HAS_SAVES: Record<Platform, boolean> = { INSTAGRAM: true, FACEBOOK: false, X: false, YOUTUBE: false };

// ── The generator ────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Shaped to satisfy both `EngagementPost` and `TimingPost` directly, so tests can
 * hand the rows to `rateAll` without a mapping step whose bugs would be mistaken
 * for engine bugs.
 */
export interface PlantedPost {
    platform: Platform;
    mediaType: MediaType;
    postedAt: Date;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
    saves: number | null;
}

export interface PlantedCorpus {
    /** The engagement-rate denominator. Stable across calls. */
    followerCount: number;
    posts: PlantedPost[];
}

/** A deterministic corpus for one account on one platform, over the last `days` days. */
export function plantedCorpus(platform: Platform, handle: string, days = 90): PlantedCorpus {
    const profile = profileFor(handle);

    const metaRng = makeRng(stableHash(`meta:${platform}:${handle}`));
    const [lo, hi] = profile.followerBand;
    const followerCount = Math.round(lo + metaRng() * (hi - lo));

    const rng = makeRng(stableHash(`posts:${platform}:${handle}`));
    const formatMix = formatMixFor(platform, profile);
    const posts: PlantedPost[] = [];

    for (let i = 0; i < profile.postsPer90Days; i++) {
        const mediaType = pickWeighted<MediaType>(rng, formatMix);
        const theme = pickWeighted<Theme>(rng, profile.themeMix);

        // Place the post at a local hour this account actually posts at, then
        // convert to the UTC instant the schema stores. Posting-hour choice is an
        // account habit; the engagement multiplier is a property of the hour.
        const daysAgo = Math.floor(rng() * days);
        const localHour = pick(rng, profile.postingHours);
        const localMinute = Math.floor(rng() * 60);

        const local = new Date(Date.now() - daysAgo * 86_400_000);
        local.setUTCHours(localHour, localMinute, 0, 0);
        const postedAt = new Date(local.getTime() - IST_OFFSET_MS);
        const localDayOfWeek = local.getUTCDay();

        // reach first, interactions second — see the note at the top of the file
        const viral = rng() < VIRAL_RATE;
        const reach = Math.round(followerCount * FORMAT_REACH[mediaType] * noise(rng) * (viral ? VIRAL_BOOST : 1));

        const rate =
            BASE_ER *
            FORMAT_QUALITY[mediaType] *
            HOUR_QUALITY[localHour]! *
            DAY_QUALITY[localDayOfWeek]! *
            THEME_QUALITY[theme] *
            noise(rng);

        const interactions = Math.max(1, Math.round(reach * rate));

        // Split into individual metrics, then null out whatever this platform
        // does not actually expose.
        const likes = Math.round(interactions * 0.8);
        const comments = Math.round(interactions * 0.07);
        const shares = Math.round(interactions * 0.08);
        const saves = Math.round(interactions * 0.05);

        posts.push({
            platform,
            mediaType,
            postedAt,
            likes,
            comments,
            shares: HAS_SHARES[platform] ? shares : null,
            views: hasViews(platform, mediaType) ? reach : null,
            saves: HAS_SAVES[platform] ? saves : null,
        });
    }

    return { followerCount, posts };
}
