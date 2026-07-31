// `npm run import -- --file=data/imports/sample_x_posts.csv`
//
// Routes a CSV/JSON export through the identical pipeline the live and seed
// adapters use — normalise, upsert, run log. Imported rows are indistinguishable
// downstream, which is the payoff of the adapter contract.
//
// Accounts must already exist. Ingestion refreshes the roster, it does not define
// it: which accounts are tracked is a user decision (FR1), and letting a dropped
// file silently add accounts would mean a typo'd handle creates a ghost account
// that quietly accumulates data nobody asked for.

import { createFileAdapter, describeImportFile } from "../adapters/fileAdapter";
import { prisma } from "../db";
import { ingestAccount } from "../ingestion/pipeline";

function flag(name: string): string | undefined {
    return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
    const file = flag("file");
    if (!file) throw new Error("Usage: npm run import -- --file=<path to .csv or .json> [--days=90]");

    const days = Number(flag("days") ?? 90);
    if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");

    const groups = describeImportFile(file);
    if (groups.length === 0) throw new Error(`No usable rows in ${file} — check the header names and platform column`);

    console.log(`\nImporting ${file}\n` + "=".repeat(60));
    for (const g of groups) console.log(`  ${g.platform.padEnd(9)} @${g.handle.padEnd(22)} ${g.rows} rows`);
    console.log();

    // Resolve every account BEFORE writing anything. A half-applied import is worse
    // than a rejected one — the user would have to work out which parts landed.
    const resolved: { id: string; platform: string; handle: string }[] = [];
    const unknown: string[] = [];

    for (const group of groups) {
        const account = await prisma.account.findUnique({
            where: { platform_handle: { platform: group.platform, handle: group.handle } },
            select: { id: true, platform: true, handle: true },
        });
        if (account) resolved.push(account);
        else unknown.push(`${group.platform} @${group.handle}`);
    }

    if (unknown.length > 0) {
        throw new Error(
            `These accounts are not tracked yet:\n    ${unknown.join("\n    ")}\n` +
                `  Add them first (UI, or src/config/accounts.ts + npm run ingest -- --roster), then re-run the import.`,
        );
    }

    let written = 0;
    let failed = 0;

    for (const account of resolved) {
        const adapter = createFileAdapter(account.platform as never, file);
        const result = await ingestAccount(account.id, { sinceDays: days, adapter });

        written += result.rowsFetched;
        failed += result.rowsFailed;

        const note = result.rowsFailed > 0 ? ` (${result.rowsFailed} rejected)` : "";
        console.log(
            `  ${result.platform.padEnd(9)} @${result.handle.padEnd(22)} ` +
                `${String(result.rowsFetched).padStart(4)} written  ${result.source}/${result.status}${note}`,
        );
    }

    console.log("\n" + "=".repeat(60));
    console.log(`  ${written} rows written, ${failed} rejected`);
    if (failed > 0) console.log(`  Rejection reasons are in IngestionRun.errorNote`);
    console.log("=".repeat(60) + "\n");
}

main()
    .catch((error) => {
        console.error("\nImport failed:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
