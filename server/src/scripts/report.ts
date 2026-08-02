// Export the analysis as Markdown.
//
// The portal has a download button that serves the same bytes; this exists so
// the export can be produced without a browser — which is how the committed
// sample report in the repository root is regenerated, and how anyone can check
// that the file in Git still matches what the code produces.
//
//   npm run report                                    the whole roster, to stdout
//   npm run report -- --out=../SAMPLE-REPORT.md       write it to a file
//   npm run report -- --platform=YOUTUBE              one platform
//   npm run report -- --recommendations               include the AI section (needs GEMINI_API_KEY)
//
// Recommendations are opt-in rather than default because they cost a model call
// and the analytics are complete without them. A report that refused to render
// without an API key would put the wrong dependency in the wrong place.

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReport } from "../analytics/buildReport";
import { renderReportMarkdown, type RenderableRecommendations } from "../analytics/reportMarkdown";
import type { CorpusFilter } from "../analytics/corpus";
import { hasApiKey } from "../ai/gemini";

function parseArgs(argv: readonly string[]): {
    filter: CorpusFilter;
    out: string | null;
    recommendations: boolean;
} {
    const filter: CorpusFilter = {};
    let out: string | null = null;
    let recommendations = false;

    for (const arg of argv) {
        if (arg === "--recommendations") {
            recommendations = true;
            continue;
        }

        const match = /^--([a-zA-Z]+)=(.+)$/.exec(arg);
        if (!match) continue;
        const [, key, value] = match as unknown as [string, string, string];

        switch (key) {
            case "out":
                out = value;
                break;
            case "platform":
                filter.platform = value.toUpperCase() as CorpusFilter["platform"];
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
            default:
                break;
        }
    }

    return { filter, out, recommendations };
}

async function main(): Promise<void> {
    const { filter, out, recommendations } = parseArgs(process.argv.slice(2));

    const report = await buildReport(filter);

    let run: RenderableRecommendations | null = null;
    if (recommendations) {
        if (!hasApiKey()) {
            // Loud, and it stops. Writing the file without the section the caller
            // asked for would produce a report that looks complete and is not.
            console.error(
                "--recommendations was passed but GEMINI_API_KEY is not set. Set it, or drop the flag to " +
                    "export the analytics on their own.",
            );
            process.exitCode = 1;
            return;
        }
        const { generateRecommendations } = await import("../ai/recommend");
        run = (await generateRecommendations(filter)) as unknown as RenderableRecommendations;
    }

    const markdown = renderReportMarkdown(report, run);

    if (out === null) {
        process.stdout.write(markdown);
        return;
    }

    const path = resolve(process.cwd(), out);
    writeFileSync(path, markdown, "utf8");
    console.log(
        `Wrote ${path} — ${report.corpusProvenance.totalPosts.toLocaleString()} posts, ` +
            `${report.platforms.length} platforms${run === null ? "" : `, ${run.recommendations.length} recommendations`}.`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
