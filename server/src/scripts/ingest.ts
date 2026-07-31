// `npm run ingest` — the one command that puts real posts in the database.
//
// This used to be two scripts, `seed` and `ingest`, because seeding decided WHO
// was tracked and ingestion decided WHAT they posted. Nothing is seeded any more,
// so a script called `seed` was describing a thing the system no longer does —
// and a command whose name implies generated data, in a product whose central
// claim is that its data is real, is the wrong name to leave lying around.
//
// The distinction it protected is still real, so it survives as a flag rather
// than a second file: refreshing posts must not silently re-assert the roster,
// because accounts added through the UI (FR1) would vanish.
//
//   npm run ingest                          refresh every tracked account, 90 days
//   npm run ingest -- --days=30             shorter window
//   npm run ingest -- --platform=INSTAGRAM  one platform
//   npm run ingest -- --roster              reconcile the roster from config first
//   npm run ingest -- --roster --reset      wipe and rebuild from scratch
//   npm run ingest -- --check-handles       resolve every handle, write nothing
//
// Idempotent. Posts upsert on (platform, postId) and the roster upserts on
// (platform, handle), so running it twice leaves the database as running it once.

import { getAdapter, plannedPlatforms } from "../adapters";
import { PLANNED_ACCOUNTS, TRACKED_ACCOUNTS } from "../config/accounts";
import { prisma } from "../db";
import { ingestAccount, ingestAll, type IngestResult } from "../ingestion/pipeline";

function flag(name: string): string | undefined {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match?.split("=")[1];
}

function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

// ── Roster reconciliation (--roster) ─────────────────────────────────────

async function resetDatabase(): Promise<void> {
    // Accounts cascade to posts and runs, so this is the only delete needed.
    const { count } = await prisma.account.deleteMany({});
    console.log(`  reset: removed ${count} accounts (posts and runs cascaded)\n`);
}

async function reconcileRoster(): Promise<void> {
    console.log("Roster");

    for (const account of TRACKED_ACCOUNTS) {
        // An account that used to be seeded must lose its generated posts before it
        // is served live. Leaving them would mix invented rows into a corpus the UI
        // now presents as real — the exact mislabelling isSynthetic exists to prevent.
        const purged = await prisma.post.deleteMany({
            where: {
                isSynthetic: true,
                account: { platform: account.platform, handle: account.handle },
            },
        });
        if (purged.count > 0) {
            console.log(`    purged ${purged.count} generated posts — @${account.handle} is live now`);
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
                // TRACKED_ACCOUNTS is filtered on hasLiveAdapter, so every row here
                // has a real source by construction.
                isSynthetic: false,
            },
            // followerCount is deliberately not set here — ingestion pulls it from
            // the source on every run, so the ER denominator has one owner.
            update: {
                personName: account.personName,
                role: account.role,
                displayName: account.displayName,
                timezone: account.timezone,
                isSynthetic: false,
            },
        });

        console.log(
            `  ${account.role === "PRINCIPAL" ? "*" : " "} ${account.platform.padEnd(9)} ` +
            `@${account.handle.padEnd(28)} LIVE`,
        );
    }

    // Declared but unreadable. Printed every run so the missing platforms stay
    // visible as a decision rather than quietly disappearing from the product.
    if (PLANNED_ACCOUNTS.length > 0) {
        console.log(`\n  Declared, no adapter yet — not ingested, not seeded:`);
        for (const { platform, blocker } of plannedPlatforms()) {
            const handles = PLANNED_ACCOUNTS.filter((a) => a.platform === platform).map((a) => `@${a.handle}`);
            console.log(`    ${platform.padEnd(9)} ${handles.length} accounts — ${blocker.split(";")[0]}`);
        }
    }

    await pruneOrphans();
    console.log(`\n  ${TRACKED_ACCOUNTS.length} tracked (* = principal), ${PLANNED_ACCOUNTS.length} declared\n`);
}

/**
 * Remove accounts that are no longer in the roster.
 *
 * Upsert keys on (platform, handle), so CORRECTING a handle creates a new account
 * and silently orphans the old one — with all its posts still attached. That is
 * not a cosmetic leak: the same person then appears twice in every comparison,
 * once with real data and once with the stale corpus, and the competitor analysis
 * quietly double-counts them.
 *
 * The roster is the source of truth for `--roster` only. Accounts added ad hoc
 * through the UI (FR1) are not preserved by it — run `npm run ingest` with no
 * flags to refresh those without re-asserting the roster.
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

// ── Handle verification (--check-handles) ────────────────────────────────

/**
 * Resolve every tracked handle against its live source and print what came back.
 * Writes nothing.
 *
 * This exists because a wrong handle is the one error the pipeline cannot catch
 * for you: it either fails the run, or — worse — resolves to a stranger's account
 * and attributes their posts to a politician. Checking costs one cheap call per
 * account, which is a great deal less than discovering it from a dashboard.
 */
async function checkHandles(): Promise<void> {
    console.log("Resolving handles (no rows written)\n");

    let failed = 0;

    for (const account of TRACKED_ACCOUNTS) {
        const label = `  ${account.platform.padEnd(9)} @${account.handle.padEnd(28)}`;
        try {
            const meta = await getAdapter(account.platform, false).fetchAccountMeta(account.handle);
            const followers = meta.followerCount === null ? "hidden" : meta.followerCount.toLocaleString();
            console.log(`${label} OK    ${meta.displayName} — ${followers} followers`);
        } catch (error) {
            failed += 1;
            console.log(`${label} FAIL  ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    console.log(
        failed === 0
            ? `\n  all ${TRACKED_ACCOUNTS.length} handles resolved\n`
            : `\n  ${failed} of ${TRACKED_ACCOUNTS.length} handles did not resolve — fix config/accounts.ts before ingesting\n`,
    );
    if (failed > 0) process.exitCode = 1;
}

// ── Ingestion ────────────────────────────────────────────────────────────

function report(results: IngestResult[], days: number): void {
    console.log(`\nIngested ${results.length} accounts over ${days} days\n`);

    for (const r of results) {
        const flagged = r.rowsFailed > 0 ? ` (${r.rowsFailed} failed)` : "";
        console.log(
            `  ${r.platform.padEnd(9)} @${r.handle.padEnd(28)} ` +
            `${String(r.rowsFetched).padStart(4)} posts  ${r.source}/${r.status}${flagged}`,
        );
    }
}

async function main(): Promise<void> {
    if (has("check-handles")) {
        await checkHandles();
        return;
    }

    const days = Number(flag("days") ?? 90);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number`);

    const platform = flag("platform")?.toUpperCase();

    if (has("reset") && !has("roster")) {
        throw new Error("--reset wipes every account, so it only makes sense with --roster");
    }

    if (has("roster")) {
        console.log("\nBellwether ingest\n" + "=".repeat(60) + "\n");
        if (has("reset")) await resetDatabase();
        await reconcileRoster();
    }

    let results: IngestResult[];

    if (platform) {
        const accounts = await prisma.account.findMany({
            where: { platform: platform as never },
            select: { id: true, handle: true },
        });
        if (accounts.length === 0) throw new Error(`No tracked accounts on platform ${platform}`);

        results = [];
        for (const account of accounts) {
            try {
                results.push(await ingestAccount(account.id, { sinceDays: days }));
            } catch (error) {
                // Logged, not fatal: the failure is already recorded in its own
                // IngestionRun row, and a partial refresh beats none.
                console.error(`  @${account.handle} failed:`, error instanceof Error ? error.message : error);
            }
        }
    } else {
        results = await ingestAll({ sinceDays: days });
    }

    report(results, days);

    const posts = await prisma.post.count();
    const synthetic = await prisma.post.count({ where: { isSynthetic: true } });
    const failed = results.reduce((sum, r) => sum + r.rowsFailed, 0);

    console.log("\n" + "=".repeat(60));
    console.log(`  ${posts} posts in the database, ${posts - synthetic} of them real`);
    // Should be zero. Printed anyway: a non-zero count is a leftover from the
    // seeded era, and a number nobody prints is a number nobody notices.
    if (synthetic > 0) {
        console.log(`  ⚠ ${synthetic} synthetic posts remain — run with --roster to purge them`);
    }
    if (failed > 0) console.log(`  ${failed} rows failed — see the IngestionRun table`);
    console.log("=".repeat(60) + "\n");
}

main()
    .catch((error) => {
        console.error("\nIngest failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
