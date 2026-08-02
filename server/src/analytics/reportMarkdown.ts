// The analytics document, rendered for a person rather than a model.
//
// `buildReport.ts` produces one JSON document and two consumers read it: the
// recommendation model, and this file. That is deliberate — a report written
// from a second query would be a second source of truth, and the first time the
// two disagreed nobody would know which one to believe. Every figure below is
// already rounded by `buildReport`, so nothing here computes anything. If a
// number in the exported Markdown is wrong, it is wrong in a tested analytics
// module, not in a formatter.
//
// WHAT THIS FILE IS ALLOWED TO DO: order, label, and lay out. Nothing more. It
// has no access to the corpus and no arithmetic beyond joining strings, which is
// what makes it safe to hand the output to someone who will act on it.
//
// The audience is a communications manager, so the layout answers the four
// questions in the order she asks them — what works, when to post, how we
// compare, what to do — and every section states the sample size beside the
// figure rather than in a footnote. A caveat she has to hunt for is a caveat she
// will not read.

import type { AnalyticsReport, ReportBasisSection, ReportPlatformSection, ReportPost } from "./buildReport";

/**
 * The subset of `RecommendationRun` this renderer needs.
 *
 * Structural rather than an import of the real type, so the Markdown export does
 * not drag the AI layer — and therefore an API key — into a code path that works
 * perfectly well without one.
 */
export interface RenderableRecommendations {
    generatedAt: string;
    model: string;
    recommendations: {
        action: string;
        rationale: string;
        platform: string;
        dimension: string;
        postIds: string[];
        sampleSize: number;
        confidence: string;
        priority: number;
    }[];
    dropped: unknown[];
    generated: number;
    repaired: number;
    citedPosts: Record<string, ReportPost>;
    evidence: { numbers: number; postIds: number };
}

const DASH = "—";

function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function fmtDateTime(iso: string): string {
    return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A table row, with every cell escaped so a caption containing "|" cannot break it. */
function row(cells: (string | number)[]): string {
    return `| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
}

function table(headers: string[], rows: (string | number)[][]): string[] {
    if (rows.length === 0) return [];
    return [row(headers), `|${headers.map(() => "---").join("|")}|`, ...rows.map(row), ""];
}

function humanise(token: string): string {
    return token
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** A post line: date, format, rate, and the link if there is one to give. */
function postLine(post: ReportPost): (string | number)[] {
    const when = post.postedAt.slice(0, 10);
    const link = post.permalink === null ? DASH : `[open](${post.permalink})`;
    const caption = post.captionExcerpt === null ? "" : post.captionExcerpt.replace(/\s+/g, " ").slice(0, 80);
    return [when, humanise(post.mediaType), `${post.ratePct}%`, `${post.multipleOfMedian}×`, caption, link];
}

function renderBasis(basis: ReportBasisSection, principalName: string): string[] {
    const lines: string[] = [];
    const label = basis.basis === "VIEWS" ? "views" : "followers";

    lines.push(`#### Rates normalised on ${label}`, "");
    lines.push(
        `Divided by ${basis.denominator}. Across **${basis.principalRatedPosts} rated posts**, ` +
            `${principalName}'s typical post earns **${basis.principalMedianRatePct}%**.`,
        "",
    );

    // ── Question 1 ───────────────────────────────────────────────────────
    if (basis.formats.length > 0) {
        lines.push("**What content works**", "");
        lines.push(
            ...table(
                ["Format", "Posts", "Median rate", "vs his own median", "Note"],
                basis.formats.map((f) => [
                    humanise(f.mediaType),
                    f.n,
                    `${f.medianRatePct}%`,
                    `${f.multipleOfOverall}×`,
                    f.outlierDriven ? "Outlier-driven — read the median, not the mean" : "",
                ]),
            ),
        );
    }

    // ── Question 2 ───────────────────────────────────────────────────────
    if (basis.bestHours.length > 0) {
        lines.push(`**When to post** — local time (${basis.timezone})`, "");
        lines.push(
            ...table(
                ["Slot", "Posts", "vs his own median"],
                basis.bestHours.map((h) => [h.label, h.n, `${h.multipleOfOverall}×`]),
            ),
        );
        if (basis.suppressedCells > 0) {
            lines.push(
                `${basis.suppressedCells} of the 168 day×hour cells hold too few posts to report and are ` +
                    `suppressed rather than shown faintly. A thin cell that reaches the page gets acted on.`,
                "",
            );
        }
    }

    // ── Question 3 ───────────────────────────────────────────────────────
    lines.push("**How he compares**", "");
    lines.push(basis.comparisonSentence, "");
    if (basis.rank !== null) {
        lines.push(`Ranked **${basis.rank.position} of ${basis.rank.outOf}** accounts on this basis.`, "");
    }
    if (basis.peerWindows.length > 0) {
        lines.push("Windows the peers win in that are worth watching:", "");
        lines.push(
            ...table(
                ["Peer", "Window", "Posts", "vs their own median"],
                basis.peerWindows.map((w) => [w.personName, w.label, w.n, `${w.multipleOfOverall}×`]),
            ),
        );
    }

    // ── Gaps ─────────────────────────────────────────────────────────────
    if (basis.gaps.length > 0) {
        lines.push("**Gaps — what peers do that he does not**", "");
        // The sentence is composed by `describeGap` from the same verified
        // figures and already names every peer behind the finding, so nothing is
        // restated here — a second rendering of the same evidence is a second
        // chance for the two to disagree.
        for (const gap of basis.gaps) {
            lines.push(`- **${gap.label}** (${gap.dimension.toLowerCase()}) — ${gap.sentence}`);
            if (gap.provenanceCaveat !== null) lines.push(`  ${gap.provenanceCaveat}`);
        }
        lines.push("");
    }

    // Rejections are part of the finding. A gap list with nothing in it is
    // indistinguishable from a gap engine that never ran.
    if (basis.nearMisses.length > 0) {
        lines.push("**Considered and rejected** — close to the bar, not over it", "");
        lines.push(
            ...table(
                ["Bucket", "Peer lift", "Why it was not reported", "What would change it"],
                basis.nearMisses.map((n) => [n.label, `${n.peerLift}×`, n.reason, n.whatWouldChangeIt]),
            ),
        );
    }

    if (basis.overInvested.length > 0) {
        lines.push("**Where his own output is going for a below-baseline return**", "");
        for (const item of basis.overInvested) lines.push(`- ${item.sentence}`);
        lines.push("");
    }

    // ── Question 1, at the post level ────────────────────────────────────
    if (basis.bestPosts.length > 0) {
        lines.push("**Best posts**", "");
        lines.push(
            ...table(
                ["Posted", "Format", "Rate", "vs median", "Caption", "Link"],
                basis.bestPosts.map(postLine),
            ),
        );
    }
    if (basis.worstPosts.length > 0) {
        lines.push("**Weakest posts**", "");
        lines.push(
            ...table(
                ["Posted", "Format", "Rate", "vs median", "Caption", "Link"],
                basis.worstPosts.map(postLine),
            ),
        );
    }

    return lines;
}

function renderPlatform(platform: ReportPlatformSection, principalName: string): string[] {
    const lines: string[] = [`### ${platform.platform}`, ""];

    const provenance =
        platform.provenance === "LIVE"
            ? "Every post on this platform was fetched from the platform itself."
            : platform.provenance === "SEEDED"
              ? `Generated data — ${platform.seededAccounts.join(", ")}.`
              : `Mixed provenance — generated data for ${platform.seededAccounts.join(", ")}.`;

    lines.push(`${platform.totalPosts} posts in the window. ${provenance}`, "");

    if (platform.cadence !== null) {
        lines.push("**How often he posts**", "");
        lines.push(platform.cadence.sentence, "");
        lines.push(
            ...table(
                ["", principalName, "Peer median"],
                [
                    [
                        "Posts per week",
                        platform.cadence.principalPostsPerWeek ?? DASH,
                        platform.cadence.peerMedianPostsPerWeek ?? DASH,
                    ],
                    [
                        "Weeks with at least one post",
                        platform.cadence.principalConsistencyPct === null
                            ? DASH
                            : `${platform.cadence.principalConsistencyPct}%`,
                        platform.cadence.peerConsistencyPct === null
                            ? DASH
                            : `${platform.cadence.peerConsistencyPct}%`,
                    ],
                    [
                        "Longest silence",
                        platform.cadence.principalLongestSilenceDays === null
                            ? DASH
                            : `${platform.cadence.principalLongestSilenceDays} days`,
                        DASH,
                    ],
                ],
            ),
        );
        lines.push(
            platform.cadence.narrowedFromDays === null
                ? `Measured over ${platform.cadence.windowDays} days.`
                : `Measured over the last ${platform.cadence.windowDays} days rather than ` +
                      `${platform.cadence.narrowedFromDays}: ${platform.cadence.narrowedBy.join(", ")} has no ` +
                      `history before that, so the longer window would have measured the gap in coverage ` +
                      `rather than the accounts.`,
            "",
        );
    }

    if (platform.formatMixDivergences.length > 0) {
        lines.push("**Format mix — where his output differs from the peer set**", "");
        lines.push(
            ...table(
                ["Format", `${principalName}'s share`, "Peer share"],
                platform.formatMixDivergences.map((d) => [
                    humanise(d.mediaType),
                    `${d.principalSharePct}%`,
                    `${d.peerSharePct}%`,
                ]),
            ),
        );
    }

    for (const basis of platform.bases) lines.push(...renderBasis(basis, principalName));

    return lines;
}

function renderRecommendations(run: RenderableRecommendations, principalName: string): string[] {
    const lines: string[] = ["## What to change next week", ""];

    if (run.recommendations.length === 0) {
        lines.push(
            "No recommendation cleared validation on this corpus. Every candidate the model produced cited a " +
                "figure that could not be matched against the analytics above, or rested on too few posts, and " +
                "was discarded rather than published.",
            "",
        );
        return lines;
    }

    lines.push(
        `Ranked by the model, grounded in the figures above. Every number in a rationale was checked against ` +
            `the analytics document before this list was written; anything unverifiable was dropped, not softened.`,
        "",
    );

    for (const rec of run.recommendations) {
        lines.push(`### ${rec.priority}. ${rec.action}`, "");
        lines.push(rec.rationale, "");
        lines.push(
            `*${rec.platform} · ${humanise(rec.dimension)} · ${rec.sampleSize} posts · ${rec.confidence} confidence*`,
            "",
        );

        const cited = rec.postIds.map((id) => run.citedPosts[id]).filter((p): p is ReportPost => p !== undefined);
        if (cited.length > 0) {
            lines.push("Posts behind this:", "");
            for (const post of cited) {
                const link = post.permalink === null ? "" : ` — [open](${post.permalink})`;
                lines.push(
                    `- ${post.postedAt.slice(0, 10)} · ${humanise(post.mediaType)} · ${post.ratePct}% ` +
                        `(${post.multipleOfMedian}× his median)${link}`,
                );
            }
            lines.push("");
        }
    }

    lines.push(
        `Generated by ${run.model} on ${fmtDate(run.generatedAt)} for ${principalName}. ` +
            `${run.generated} produced, ${run.dropped.length} rejected by validation, ${run.repaired} passed only ` +
            `on retry. The verified set the validator checked against held ${run.evidence.numbers} figures and ` +
            `${run.evidence.postIds} post ids.`,
        "",
    );

    return lines;
}

/**
 * The whole report as Markdown.
 *
 * `recommendations` is optional because the analytics stand on their own: the
 * export must work for a reader with no model access, and a report that refuses
 * to render without an API key would be the wrong dependency in the wrong place.
 */
export function renderReportMarkdown(
    report: AnalyticsReport,
    recommendations?: RenderableRecommendations | null,
): string {
    const principalName = report.principalName ?? "the principal";
    const lines: string[] = [];

    lines.push(`# ${principalName} — social performance report`, "");

    if (report.window !== null) {
        lines.push(
            `**${fmtDate(report.window.from)} to ${fmtDate(report.window.to)}** · ${report.window.days} days · ` +
                `measured against ${report.peerNames.join(", ")}.`,
            "",
        );
    }

    const prov = report.corpusProvenance;
    lines.push(
        `${prov.totalPosts.toLocaleString()} posts across ${report.platforms.length} ` +
            `${report.platforms.length === 1 ? "platform" : "platforms"}. ` +
            (prov.seededPosts === 0
                ? "Every one of them was fetched from the platform it came from — none are generated."
                : `${prov.seededPct}% of them (${prov.seededPosts.toLocaleString()}) are generated rather than ` +
                  `fetched, and every figure they contribute to is marked in the portal.`),
        "",
    );

    // Recommendations lead. They are the product; the evidence is what follows.
    if (recommendations !== undefined && recommendations !== null) {
        lines.push(...renderRecommendations(recommendations, principalName));
    }

    lines.push("## The evidence", "");
    lines.push(
        "One section per platform. Rates are never compared across platforms, and within a platform never " +
            "across denominators — a rate over views and a rate over followers are different quantities, so they " +
            "are reported in separate blocks rather than averaged into one.",
        "",
    );

    for (const platform of report.platforms) lines.push(...renderPlatform(platform, principalName));

    // ── The method, stated rather than assumed ───────────────────────────
    lines.push("## How every number here was produced", "");
    lines.push(
        "**Engagement rate** = weighted interactions ÷ denominator. Interactions are weighted by the effort " +
            "and reach they represent: a like counts 1, a comment 3, a save 4, a share 5 — a share puts the post " +
            "in front of people who do not follow the account, which is the outcome the weighting is built " +
            "around. A metric a platform does not report is absent, never zero: a post with no share count is " +
            "not a post with no shares.",
        "",
    );
    lines.push(
        "**Denominator** is views where the platform or format genuinely reports them, and followers " +
            "otherwise. Views are a realised audience and followers only a potential one, so a views-based rate " +
            'answers "of the people who saw this, how many acted" — which is the question a content plan is ' +
            "actually asking. Each rate carries the basis it used, and rates on different bases are never " +
            "averaged together.",
        "",
    );
    lines.push(
        "**Multiples** are always against the account's own median, never against a pool. Pooling several " +
            "accounts' posts conflates how good a format is with how often a particular account posts it; " +
            "measuring each account against itself cancels its own habits out.",
        "",
    );
    lines.push(
        "**Sample sizes** are printed beside every figure, and buckets below the threshold are withheld rather " +
            "than shown faintly. A greyed-out number is still a number, and a number on the page gets acted on.",
        "",
    );

    if (report.notes.length > 0) {
        lines.push("## What could not be computed", "");
        for (const note of report.notes) lines.push(`- ${note}`);
        lines.push("");
    }

    if (report.truncations.length > 0) {
        lines.push("## Lists shortened for this report", "");
        for (const truncation of report.truncations) lines.push(`- ${truncation}`);
        lines.push("");
    }

    lines.push("---", "");
    lines.push(
        `Generated by Bellwether on ${fmtDateTime(report.generatedAt)} from the analytics document at ` +
            "`GET /api/analytics/report` — the same document the recommendation model is grounded against.",
        "",
    );

    return lines.join("\n");
}
