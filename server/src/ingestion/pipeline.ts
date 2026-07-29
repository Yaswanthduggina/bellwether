// Orchestration: fetch -> normalise -> upsert -> log.
//
// This is the only module that knows the whole sequence. Each step it calls is
// independently testable, and none of them know about each other.
//
// Ingestion REFRESHES accounts; it does not create them. Which accounts to track
// is a user decision (FR1: add/remove from the UI), not something a data source
// gets to assert — so an account must exist before it can be ingested.

import { getAdapter } from "../adapters";
import { prisma } from "../db";
import { normalizePosts } from "./normalize";
import { failRun, finishRun, startRun, summariseErrors, type RunStatus } from "./runLog";
import { upsertPosts } from "./upsert";

const DEFAULT_WINDOW_DAYS = 90; // FR2: the last 90 days of public posts

export interface IngestResult {
    accountId: string;
    handle: string;
    platform: string;
    source: string;
    runId: string;
    status: RunStatus;
    rowsFetched: number;
    rowsFailed: number;
}

export async function ingestAccount(
    accountId: string,
    options: { sinceDays?: number } = {},
): Promise<IngestResult> {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) throw new Error(`No account with id ${accountId}`);

    const adapter = getAdapter(account.platform, account.isSynthetic);
    const since = new Date(Date.now() - (options.sinceDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000);

    // Opened before any fetching, so a source that hangs or throws still leaves a
    // trace. A run that vanishes without a row is the one you cannot debug later.
    const runId = await startRun(account.id, adapter.source);

    try {
        // Follower count is the engagement-rate denominator for non-video platforms,
        // so it is refreshed on every run. displayName is left alone deliberately —
        // it is a label the user set in the UI, and a source should not overwrite it.
        const meta = await adapter.fetchAccountMeta(account.handle);
        if (meta.followerCount !== null) {
            await prisma.account.update({
                where: { id: account.id },
                data: { followerCount: meta.followerCount },
            });
        }

        const raw = await adapter.fetchPosts(account.handle, since);

        // Guard against an adapter returning another platform's rows: the unique key
        // is (platform, postId), so a mislabelled row would collide with a real post
        // from the platform it claims to be from and silently overwrite it.
        const mismatched = raw.filter((p) => p.platform !== account.platform);
        if (mismatched.length > 0) {
            throw new Error(
                `${adapter.source} returned ${mismatched.length} rows for a platform other than ${account.platform}`,
            );
        }

        const { posts, failures } = normalizePosts(raw);
        const written = await upsertPosts(account.id, posts);

        const rowsFailed = failures.length + written.failed;
        const status = await finishRun(runId, {
            rowsFetched: written.written,
            rowsFailed,
            errorNote: summariseErrors([...failures, ...written.errors]),
        });

        return {
            accountId: account.id,
            handle: account.handle,
            platform: account.platform,
            source: adapter.source,
            runId,
            status,
            rowsFetched: written.written,
            rowsFailed,
        };
    } catch (error) {
        await failRun(runId, error);
        throw error;
    }
}

/**
 * Ingest every tracked account. Sequential on purpose: real APIs rate-limit, and a
 * burst of parallel requests is the fastest way to get a key throttled. One slow
 * pass that finishes beats a fast one that gets cut off.
 *
 * One account failing does not stop the others — the failure is already recorded
 * in its own IngestionRun row, and a partial refresh is more useful than none.
 */
export async function ingestAll(options: { sinceDays?: number } = {}): Promise<IngestResult[]> {
    const accounts = await prisma.account.findMany({
        select: { id: true, handle: true, platform: true },
        orderBy: [{ personName: "asc" }, { platform: "asc" }],
    });

    const results: IngestResult[] = [];
    for (const account of accounts) {
        try {
            results.push(await ingestAccount(account.id, options));
        } catch (error) {
            console.error(
                `[ingest] ${account.platform}/${account.handle} failed:`,
                error instanceof Error ? error.message : error,
            );
        }
    }
    return results;
}
