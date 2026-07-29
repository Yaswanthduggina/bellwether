// `npm run ingest` — refresh posts for accounts that already exist.
//
// Separate from `seed` because they answer different questions. Seeding decides
// WHO is tracked; ingestion refreshes WHAT they posted. Conflating them would mean
// you could not refresh data without also re-asserting the roster.
//
//   npm run ingest                     all accounts, last 90 days
//   npm run ingest -- --days=30        shorter window
//   npm run ingest -- --platform=YOUTUBE

import { prisma } from "../db";
import { ingestAccount, ingestAll, type IngestResult } from "../ingestion/pipeline";

function flag(name: string): string | undefined {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match?.split("=")[1];
}

async function main(): Promise<void> {
    const days = Number(flag("days") ?? 90);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number`);

    const platform = flag("platform")?.toUpperCase();

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

    console.log(`\nIngested ${results.length} accounts over ${days} days\n`);
    for (const r of results) {
        const flagged = r.rowsFailed > 0 ? ` (${r.rowsFailed} failed)` : "";
        console.log(
            `  ${r.platform.padEnd(9)} @${r.handle.padEnd(20)} ` +
                `${String(r.rowsFetched).padStart(4)} posts  ${r.source}/${r.status}${flagged}`,
        );
    }
    console.log();
}

main()
    .catch((error) => {
        console.error("\nIngest failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
