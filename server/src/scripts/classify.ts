// `npm run classify` — populate the theme dimension.
//
// Incremental: only posts with no theme are considered, so re-running after an
// ingest costs a couple of calls rather than the whole corpus.

import { classificationStatus, classifyPosts } from "../ai/classify";
import { prisma } from "../db";

const force = process.argv.includes("--force");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

console.log("\nBellwether classification\n" + "=".repeat(60));
console.log("before:", await classificationStatus(), "\n");

const report = await classifyPosts({
    force,
    ...(limit ? { limit } : {}),
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} posts...`),
});

console.log("\n\nResults");
console.log(`  candidates      ${report.candidates}`);
console.log(`  classified      ${report.classified}`);
console.log(`  low confidence  ${report.lowConfidence}  (written as OTHER, confidence kept)`);
console.log(`  no caption      ${report.unclassifiable}  (never sent to the model)`);
console.log(`  missing         ${report.missing}  (model skipped the index — left unclassified)`);
console.log(`  batches         ${report.batches}, ${report.failedBatches.length} failed`);
for (const f of report.failedBatches) console.log(`    batch ${f.batch}: ${f.error.slice(0, 120)}`);

if (report.stoppedEarly) {
    console.log(`
  STOPPED EARLY: ${report.stoppedEarly.reason}`);
    console.log(`  ${report.stoppedEarly.message}`);
    console.log(`  ${report.stoppedEarly.remaining} posts were not attempted. Re-run this command to continue.`);
}

console.log("\nDistribution");
for (const [theme, n] of Object.entries(report.distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${theme.padEnd(22)} ${String(n).padStart(4)}`);
}

console.log(
    `\nTokens: ${report.usage.promptTokens} prompt, ${report.usage.outputTokens} output, ` +
        `${report.usage.thoughtTokens} thinking`,
);
console.log("=".repeat(60) + "\n");

await prisma.$disconnect();
process.exit(0);
