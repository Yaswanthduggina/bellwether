// Idempotent writes.
//
// FR15 (re-running ingestion must update posts, not duplicate them) is satisfied
// by the @@unique([platform, postId]) constraint plus upsert. The constraint is
// what actually guarantees it — the upsert is just how we cooperate with it.

import { prisma } from "../db";
import { NormalizedPost } from "./normalize";

/**
 * Rows per transaction. Supabase is a network hop away, so one round trip per
 * post would dominate the run; batching keeps a 96-post account to two trips.
 */
const CHUNK_SIZE = 50;

export interface UpsertResult {
    written: number;
    failed: number;
    errors: { postId: string; reason: string }[];
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function buildUpsert(accountId: string, post: NormalizedPost) {
    const metrics = {
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
        views: post.views,
        saves: post.saves,
    };

    return prisma.post.upsert({
        where: { platform_postId: { platform: post.platform, postId: post.postId } },
        create: {
            accountId,
            platform: post.platform,
            postId: post.postId,
            postedAt: post.postedAt,
            mediaType: post.mediaType,
            caption: post.caption,
            permalink: post.permalink,
            isSynthetic: post.isSynthetic,
            ...metrics,
        },
        // NOTE: theme and themeConfidence are deliberately absent from this block.
        // They are written by the AI classification step (Module D), not by the
        // source — so a re-ingest refreshes the metrics without wiping the
        // classification and forcing every post to be re-classified (and re-paid for).
        update: {
            postedAt: post.postedAt,
            mediaType: post.mediaType,
            caption: post.caption,
            permalink: post.permalink,
            isSynthetic: post.isSynthetic,
            ...metrics,
        },
    });
}

export async function upsertPosts(accountId: string, posts: NormalizedPost[]): Promise<UpsertResult> {
    const result: UpsertResult = { written: 0, failed: 0, errors: [] };

    for (const batch of chunk(posts, CHUNK_SIZE)) {
        try {
            await prisma.$transaction(batch.map((post) => buildUpsert(accountId, post)));
            result.written += batch.length;
        } catch {
            // A transaction is all-or-nothing, so one bad row would discard the other
            // 49 and leave rowsFailed unattributable. Retry the chunk row by row to
            // find out which post actually failed and save the rest.
            for (const post of batch) {
                try {
                    await buildUpsert(accountId, post);
                    result.written += 1;
                } catch (error) {
                    result.failed += 1;
                    result.errors.push({
                        postId: post.postId,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
    }

    return result;
}
