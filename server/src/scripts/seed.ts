// `npm run seed` — from an empty database to a demonstrable portal in one command.
//
// Creates the tracked accounts, then runs the ingestion pipeline over them. The
// portal is fully usable from here with no API keys at all, which is the point:
// a reviewer who clones this repo and has no YouTube quota still sees the whole
// product working.
//
// Idempotent. Re-running updates the roster in place rather than duplicating it,
// and ingestion upserts on (platform, postId), so `npm run seed` twice leaves the
// database in the same state as running it once.

import { hasLiveAdapter } from "../adapters";
import { TRACKED_ACCOUNTS } from "../config/accounts";
import { prisma } from "../db";
import { ingestAll } from "../ingestion/pipeline";

async function resetDatabase(): Promise<void> {
    // Accounts cascade to posts and runs, so this is the only delete needed.
    const { count } = await prisma.account.deleteMany({});
    console.log(`  reset: removed ${count} accounts (posts and runs cascaded)\n`);
}

async function upsertAccounts(): Promise<void> {
    console.log("Accounts");

    for (const account of TRACKED_ACCOUNTS) {
        // An account is served by the seed adapter unless a live adapter exists for
        // its platform AND the roster has not pinned it to seeding for a stated
        // reason. Deriving this rather than hardcoding it means adding a live
        // adapter flips the relevant accounts without anyone remembering a flag.
        const isSynthetic = !hasLiveAdapter(account.platform) || Boolean(account.seedReason);

        // An account moving from seeded to live must lose its synthetic posts first.
        // Leaving them would mix generated rows into a corpus the UI now presents as
        // real — the exact mislabelling the isSynthetic flag exists to prevent.
        if (!isSynthetic) {
            const purged = await prisma.post.deleteMany({
                where: {
                    isSynthetic: true,
                    account: { platform: account.platform, handle: account.handle },
                },
            });
            if (purged.count > 0) {
                console.log(`    purged ${purged.count} seeded posts — @${account.handle} is now live`);
            }
        }

        await prisma.account.upsert({
            where: { platform_handle: { platform: account.platform, handle: account.handle } },
            create: {
                personName: account.personName,
                role: account.role,
                platform: account.platform,
                handle: account.handle,
                displayName: account.displayName,
                timezone: account.timezone,
                isSynthetic,
            },
            // followerCount is deliberately not set here — ingestion pulls it from
            // the source on every run, so the ER denominator has one owner.
            update: {
                personName: account.personName,
                role: account.role,
                displayName: account.displayName,
                timezone: account.timezone,
                isSynthetic,
            },
        });

        console.log(
            `  ${account.role === "PRINCIPAL" ? "*" : " "} ${account.platform.padEnd(9)} ` +
                `@${account.handle.padEnd(28)} ${isSynthetic ? "seeded" : "LIVE"}` +
                (account.seedReason ? `  (${account.seedReason})` : ""),
        );
    }

    await pruneOrphans();
    console.log(`  ${TRACKED_ACCOUNTS.length} accounts (* = principal)\n`);
}

/**
 * Remove accounts that are no longer in the roster.
 *
 * Upsert keys on (platform, handle), so CORRECTING a handle creates a new account
 * and silently orphans the old one — with all its posts still attached. That is
 * not a cosmetic leak: the same person then appears twice in every comparison,
 * once with real data and once with the stale seeded corpus, and the competitor
 * analysis quietly double-counts them.
 *
 * The roster is the source of truth for `npm run seed`. Accounts added ad hoc
 * through the UI (FR1) are not preserved by it — use `npm run ingest` to refresh
 * those without re-asserting the roster.
 */
async function pruneOrphans(): Promise<void> {
    const keep = new Set(TRACKED_ACCOUNTS.map((a) => `${a.platform}:${a.handle}`));

    const orphans = await prisma.account.findMany({
        select: { id: true, platform: true, handle: true, _count: { select: { posts: true } } },
    });

    for (const orphan of orphans) {
        if (keep.has(`${orphan.platform}:${orphan.handle}`)) continue;
        await prisma.account.delete({ where: { id: orphan.id } });
        console.log(
            `    pruned @${orphan.handle} (${orphan.platform}) — not in the roster, ` +
                `${orphan._count.posts} posts removed`,
        );
    }
}

async function main(): Promise<void> {
    const reset = process.argv.includes("--reset");

    console.log("\nBellwether seed\n" + "=".repeat(60) + "\n");
    if (reset) await resetDatabase();

    await upsertAccounts();

    console.log("Ingesting 90 days...\n");
    const results = await ingestAll();

    console.log("\nResults");
    for (const r of results) {
        const flag = r.rowsFailed > 0 ? ` (${r.rowsFailed} failed)` : "";
        console.log(
            `  ${r.platform.padEnd(9)} @${r.handle.padEnd(20)} ` +
                `${String(r.rowsFetched).padStart(4)} posts  ${r.source}/${r.status}${flag}`,
        );
    }

    const posts = await prisma.post.count();
    const synthetic = await prisma.post.count({ where: { isSynthetic: true } });
    const failed = results.reduce((sum, r) => sum + r.rowsFailed, 0);

    console.log("\n" + "=".repeat(60));
    console.log(`  ${posts} posts across ${results.length} accounts`);
    console.log(`  ${synthetic} synthetic (${Math.round((synthetic / posts) * 100)}%), ${posts - synthetic} live`);
    if (failed > 0) console.log(`  ${failed} rows failed — see the IngestionRun table`);
    console.log("=".repeat(60) + "\n");
}

main()
    .catch((error) => {
        console.error("\nSeed failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
