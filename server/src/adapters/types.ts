// The contract every data source (real API or seed file) must follow.
// Everything downstream (normalize, DB, analytics) only ever talks to this shape —
// it never knows or cares whether a post came from a live API or a seed file.

export interface RawPost {
    platform: "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";
    accountHandle: string;
    postId: string;
    postedAt: string; // ISO 8601 string, e.g. "2026-06-14T18:30:00+05:30"
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

export interface SocialAdapter {
    platform: "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";
    fetchPosts(accountHandle: string, sinceDate: Date): Promise<RawPost[]>;
}