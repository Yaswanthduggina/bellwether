// Generate recommendations from the command line.
//
// The API route is the product; this exists because a reviewer should be able to
// see the grounded-recommendation pipeline work without starting a server, and
// because the drop count is the number worth watching while the prompt is being
// tuned. Reads the same filter block as the route.
//
//   npm run recommend
//   npm run recommend -- --platform=YOUTUBE
//   npm run recommend -- --platform=X --json

import "dotenv/config";
import { generateRecommendations } from "../ai/recommend";
import { hasApiKey } from "../ai/gemini";
import type { CorpusFilter } from "../analytics/corpus";

function parseArgs(argv: readonly string[]): { filter: CorpusFilter; json: boolean } {
    const filter: CorpusFilter = {};
    let json = false;

    for (const arg of argv) {
        if (arg === "--json") {
            json = true;
            continue;
        }
        const match = /^--([a-zA-Z]+)=(.+)$/.exec(arg);
        if (!match) continue;

        const [, key, value] = match as unknown as [string, string, string];
        switch (key) {
            case "platform":
                filter.platform = value.toUpperCase() as CorpusFilter["platform"];
                break;
            case "accountId":
                filter.accountId = value;
                break;
            case "personName":
                filter.personName = value;
                break;
            case "mediaType":
                filter.mediaType = value.toUpperCase() as CorpusFilter["mediaType"];
                break;
            case "theme":
                filter.theme = value.toUpperCase() as CorpusFilter["theme"];
                break;
            case "from":
                filter.from = new Date(value);
                break;
            case "to":
                filter.to = new Date(value);
                break;
        }
    }

    return { filter, json };
}

async function main(): Promise<void> {
    if (!hasApiKey()) {
        console.error(
            "No Gemini API key configured. Set GEMINI_API_KEY in server/.env.\n" +
                "Analytics work without one — try `npm run dev` and GET /api/analytics/report.",
        );
        process.exitCode = 1;
        return;
    }

    const { filter, json } = parseArgs(process.argv.slice(2));

    console.log(`Generating recommendations${Object.keys(filter).length ? ` for ${JSON.stringify(filter)}` : ""}...\n`);

    const run = await generateRecommendations(filter);

    if (json) {
        console.log(JSON.stringify(run, null, 2));
        return;
    }

    for (const rec of run.recommendations) {
        console.log(`[${rec.priority}] ${rec.platform} · ${rec.dimension} · ${rec.confidence} · n=${rec.sampleSize}`);
        console.log(`    ${rec.action}`);
        console.log(`    ${rec.rationale}`);
        console.log(`    figures: ${rec.figures.join(", ")}`);
        if (rec.postIds.length > 0) console.log(`    posts:   ${rec.postIds.join(", ")}`);
        console.log();
    }

    for (const drop of run.dropped) {
        console.log(`DROPPED  ${drop.recommendation.action}`);
        for (const violation of drop.violations) console.log(`    [${violation.code}] ${violation.message}`);
        console.log();
    }

    for (const note of run.notes) console.log(`note: ${note}`);

    console.log(
        `\ngenerated ${run.generated} · accepted ${run.recommendations.length} · repaired ${run.repaired} · ` +
            `dropped ${run.dropped.length}`,
    );
    console.log(
        `evidence: ${run.evidence.numbers} verified numbers, ${run.evidence.postIds} citable posts · ` +
            `tokens: ${run.usage.promptTokens} in / ${run.usage.outputTokens} out / ${run.usage.thoughtTokens} thinking`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
