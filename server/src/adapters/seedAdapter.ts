import { RawAccountMeta, RawPost, SocialAdapter } from "./types";

const CAPTIONS = [
    "Met with constituents today to discuss local infrastructure concerns.",
    "Proud to have raised this issue in Parliament this session.",
    "Grateful for the warm welcome during today's visit.",
    "Standing with farmers on this important issue.",
    "Great discussion at today's youth town hall.",
    "Wishing everyone a joyous festival season.",
    "Addressing the press on today's key developments.",
    "An important milestone for our community achieved today.",
    "Reflecting on the year's progress and what's ahead.",
    "Honoured to speak at today's public event.",
];

const MEDIA_TYPES: RawPost["mediaType"][] = [
    "REEL_SHORT_VIDEO",
    "LONG_FORM_VIDEO",
    "CAROUSEL",
    "SINGLE_IMAGE",
    "TEXT_ONLY",
    "LINK",
];

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDateWithin(days: number): Date {
    const now = Date.now();
    const past = now - randomInt(0, days) * 24 * 60 * 60 * 1000;
    return new Date(past);
}

// Follower counts must be STABLE across seed runs — they are the denominator of
// the engagement rate, so a value that changed on every re-seed would make the
// headline metric jump for no reason. Derived from the handle, not Math.random().
function stableHash(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
}

export function createSeedAdapter(platform: RawPost["platform"]): SocialAdapter {
    return {
        platform,

        async fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta> {
            const h = stableHash(`${platform}:${accountHandle}`);
            return {
                platform,
                accountHandle,
                displayName: accountHandle,
                // 400K–2.4M — the peer-tier band the principal and competitors sit in.
                followerCount: 400_000 + (h % 2_000_000),
                isSynthetic: true,
            };
        },

        async fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]> {
            const count = randomInt(35, 60); // realistic post volume over 90 days
            const posts: RawPost[] = [];

            for (let i = 0; i < count; i++) {
                const mediaType = MEDIA_TYPES[randomInt(0, MEDIA_TYPES.length - 1)];
                const likes = randomInt(500, 15000);
                posts.push({
                    platform,
                    accountHandle,
                    postId: `seed_${platform.toLowerCase()}_${accountHandle}_${i}`,
                    postedAt: randomDateWithin(90).toISOString(),
                    mediaType,
                    caption: `[synthetic] ${CAPTIONS[randomInt(0, CAPTIONS.length - 1)]}`,
                    permalink: null,
                    metrics: {
                        likes,
                        comments: randomInt(20, Math.floor(likes * 0.1)),
                        shares: randomInt(5, Math.floor(likes * 0.05)),
                        views: mediaType.includes("VIDEO") ? likes * randomInt(3, 8) : null,
                        saves: randomInt(10, Math.floor(likes * 0.03)),
                    },
                    isSynthetic: true,
                });
            }

            return posts.filter((p) => new Date(p.postedAt) >= sinceDate);
        },
    };
}