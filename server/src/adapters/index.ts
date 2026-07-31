// Adapter registry — the one place that decides which source serves an account.
//
// Every platform the product intends to cover is declared here, whether or not it
// has a working adapter yet. That is deliberate: a platform absent from this file
// is invisible, and an invisible gap gets rediscovered by the next person from
// first principles. A platform present with a stated blocker is a decision anyone
// can read, argue with, and eventually close.
//
//   LIVE      an adapter exists and fetches real data
//   PLANNED   the platform is in scope, the adapter is not built, and the reason
//             it is not built is recorded next to it
//
// Nothing generates data any more. There is no seed adapter: the generator was
// deleted along with the seeded corpus, and the only thing that survives it is a
// test fixture under `__tests__/fixtures/plantedCorpus.ts`, which emits plain
// analytics rows, implements no adapter interface, and cannot be routed to from
// here. A corpus the UI presents as real is real all the way down.
//
// Account.isSynthetic is still read here rather than ignored. An account carrying
// the flag is a leftover from the seeded era, and serving it live would silently
// relabel generated history as fetched data — so it fails loudly instead and says
// how to fix it.

import { createApifyAdapter } from "./apifyAdapter";
import { RawPost, SocialAdapter } from "./types";
import { createYouTubeAdapter } from "./youtubeAdapter";

type Platform = RawPost["platform"];

export type PlatformSource =
    | { status: "LIVE"; source: string; create: () => SocialAdapter }
    | { status: "PLANNED"; blocker: string; adapterFile: string };

/**
 * Every platform in scope, with its current source.
 *
 * Adding a live adapter is a one-line change here — and because the roster in
 * config/accounts.ts filters on this map, the accounts already declared for that
 * platform start ingesting on the next run without anyone remembering a flag.
 */
export const PLATFORM_SOURCES: Record<Platform, PlatformSource> = {
    YOUTUBE: {
        status: "LIVE",
        source: "youtube_api",
        create: () => createYouTubeAdapter(),
    },
    INSTAGRAM: {
        status: "LIVE",
        source: "apify_instagram",
        create: () => createApifyAdapter(),
    },
    X: {
        status: "PLANNED",
        adapterFile: "xAdapter.ts",
        blocker:
            "free read tier caps are far below a 90-day backfill across four accounts; " +
            "a truncated sample would look live and hide its own sampling bias. Needs a paid tier.",
    },
    FACEBOOK: {
        status: "PLANNED",
        adapterFile: "facebookAdapter.ts",
        blocker:
            "Graph API reads only Pages you administer, and competitor benchmarking is by " +
            "definition about Pages you do not. Needs either Page access granted by each owner, or a public-web source.",
    },
};

export function getAdapter(platform: Platform, isSynthetic: boolean): SocialAdapter {
    if (isSynthetic) {
        throw new Error(
            `Account is flagged isSynthetic, but seeded ingestion has been removed. ` +
            `Set isSynthetic=false on the account (or re-run \`npm run ingest -- --roster\`, which ` +
            `purges its generated posts and re-points it at the live adapter).`,
        );
    }

    const entry = PLATFORM_SOURCES[platform];
    if (entry.status !== "LIVE") {
        // Loud, and specific about WHY. "No adapter for FACEBOOK" sends the next
        // person to go and discover the blocker for themselves.
        throw new Error(
            `${platform} has no live adapter yet (planned: ${entry.adapterFile}). ` +
            `Blocker: ${entry.blocker} Until then, import the data as CSV/JSON.`,
        );
    }
    return entry.create();
}

export function hasLiveAdapter(platform: Platform): boolean {
    return PLATFORM_SOURCES[platform].status === "LIVE";
}

/** Platforms in scope but not yet readable, with the reason. Used by the roster and the run log. */
export function plannedPlatforms(): { platform: Platform; blocker: string }[] {
    return (Object.keys(PLATFORM_SOURCES) as Platform[])
        .map((platform) => ({ platform, entry: PLATFORM_SOURCES[platform] }))
        .filter((row): row is { platform: Platform; entry: Extract<PlatformSource, { status: "PLANNED" }> } =>
            row.entry.status === "PLANNED",
        )
        .map(({ platform, entry }) => ({ platform, blocker: entry.blocker }));
}
