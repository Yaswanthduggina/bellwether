// The contract every data source (real API or seed file) must follow.
// Everything downstream (normalize, DB, analytics) only ever talks to this shape —
// it never knows or cares whether a post came from a live API or a seed file.

export interface RawPost {
    platform: "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";
    accountHandle: string;
    postId: string;
    postedAt: string; // ISO 8601 in UTC, e.g. "2026-06-14T13:00:00.000Z".
    // Local-time analysis (FR7) converts this using Account.timezone at query
    // time — the instant is stored once, the presentation zone is a property
    // of the account, not of the post.
    mediaType: "REEL_SHORT_VIDEO" | "LONG_FORM_VIDEO" | "CAROUSEL" | "SINGLE_IMAGE" | "TEXT_ONLY" | "LINK" | "LIVE";
    caption: string | null;
    permalink: string | null;
    metrics: {
        likes: number | null;
        comments: number | null;
        shares: number | null;
        views: number | null;
        saves: number | null;
    };
    isSynthetic: boolean;
}

// Account-level facts that live on the channel/profile rather than on any post.
// This exists because the engagement-rate denominator needs follower count for
// non-video platforms, and only the source can supply it — YouTube reports
// subscribers, the seed generator invents them. Without this, followers would
// have to be hand-maintained outside the adapter contract.
export interface RawAccountMeta {
    platform: RawPost["platform"];
    accountHandle: string;
    displayName: string;
    followerCount: number | null; // null where a platform hides it
    isSynthetic: boolean;
}

export interface SocialAdapter {
    platform: RawPost["platform"];
    fetchAccountMeta(accountHandle: string): Promise<RawAccountMeta>;
    fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]>;
}