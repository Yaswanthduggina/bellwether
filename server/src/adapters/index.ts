// Adapter registry — the one place that decides which source serves an account.
//
// The decision is driven by Account.isSynthetic, which is already in the schema.
// That is deliberate: whether an account is live or seeded is a property of the
// account, recorded once at the row level, rather than a branch scattered through
// the ingestion code. Everything downstream stays unaware.

import { createSeedAdapter } from "./seedAdapter";
import { RawPost, SocialAdapter } from "./types";

type Platform = RawPost["platform"];

/**
 * Live adapters, added as they are built. A platform absent from this map has no
 * live implementation yet — which is a fact worth surfacing loudly rather than
 * silently falling back to seeded data and letting it be mistaken for real.
 */
const LIVE_ADAPTERS: Partial<Record<Platform, () => SocialAdapter>> = {
    // YOUTUBE: () => createYouTubeAdapter(),   // step 5
};

export function getAdapter(platform: Platform, isSynthetic: boolean): SocialAdapter {
    if (isSynthetic) return createSeedAdapter(platform);

    const live = LIVE_ADAPTERS[platform];
    if (!live) {
        throw new Error(
            `No live adapter for ${platform}. Either build one, or mark the account ` +
                `isSynthetic=true so it is served by the seed adapter and labelled as seeded.`,
        );
    }
    return live();
}

export function hasLiveAdapter(platform: Platform): boolean {
    return LIVE_ADAPTERS[platform] !== undefined;
}
