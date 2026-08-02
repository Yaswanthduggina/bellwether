// The analytics routes.
//
// Every one of them is a thin projection over a module in analytics/, and that
// is the point: no arithmetic happens in this file. If a number is wrong, it is
// wrong in a tested module rather than in an untested route handler, and the
// test that catches it does not need an HTTP server.
//
// All of them share `parseFilter` (FR16) and all of them return per-basis
// panels rather than blended figures — the refusal to average a views-normalised
// rate against a follower-normalised one is a property of the analytics layer,
// and a route that flattened it away would silently undo the guarantee.

import { Router } from "express";
import { buildReport } from "../analytics/buildReport";
import { cadenceMatrix, compareCadence, describeCadence } from "../analytics/cadence";
import {
    compareAccountsByBasis,
    compareFormatMix,
    compareWindows,
    describeComparison,
} from "../analytics/compare";
import { loadCorpora, type LoadedCorpus } from "../analytics/corpus";
import { partitionByBasis, type EngagementBasis } from "../analytics/engagement";
import { analyseFormatsByBasis } from "../analytics/format";
import { describeGap, findGapsByBasis, mergeHourWindows } from "../analytics/gaps";
import { clampRecentCount, recentPosts } from "../analytics/recentPosts";
import { renderReportMarkdown } from "../analytics/reportMarkdown";
import { analyseTimingByBasis, occupiedHours } from "../analytics/timing";
import { topPostsByBasis } from "../analytics/topPosts";
import { parseFilter } from "./filters";
import { ApiError, route } from "./http";

export const analyticsRouter: Router = Router();

const BASES: readonly EngagementBasis[] = ["VIEWS", "FOLLOWERS"];

/** The corpora, plus the principal, or a 404 explaining which is missing. */
async function loadWithPrincipal(filter: Parameters<typeof loadCorpora>[0]): Promise<{
    corpora: LoadedCorpus[];
    principal: LoadedCorpus[];
}> {
    const corpora = await loadCorpora(filter);
    const principal = corpora.filter((c) => c.role === "PRINCIPAL");

    if (corpora.length === 0) {
        throw ApiError.notFound("No tracked accounts match this filter.");
    }
    if (principal.length === 0) {
        throw ApiError.notFound(
            "No principal account matches this filter. Add one via POST /api/accounts, or widen the filter.",
        );
    }

    return { corpora, principal };
}

analyticsRouter.get(
    "/overview",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const corpora = await loadCorpora(filter);

        const posts = corpora.flatMap((c) => c.posts);
        const seeded = posts.filter((p) => p.isSynthetic).length;
        const classified = posts.filter((p) => p.theme !== null).length;

        const principal = corpora.filter((c) => c.role === "PRINCIPAL");
        const principalPosts = principal.flatMap((c) => c.posts);

        res.json({
            filter,
            accounts: corpora.length,
            people: [...new Set(corpora.map((c) => c.personName))].length,
            principalName: principal[0]?.personName ?? null,
            totalPosts: posts.length,
            principalPosts: principalPosts.length,
            // Reported rather than hidden: a KPI row computed over an unstated
            // fraction of the corpus is the quiet version of a made-up number.
            ratedPosts: corpora.reduce((total, c) => total + c.rated.length, 0),
            unratedPosts: corpora.reduce((total, c) => total + c.gaps.NO_METRICS + c.gaps.NO_DENOMINATOR, 0),
            provenance: {
                livePosts: posts.length - seeded,
                seededPosts: seeded,
                seededPct: posts.length === 0 ? 0 : Math.round((seeded / posts.length) * 100),
                seededAccounts: corpora.filter((c) => c.isSynthetic && c.posts.length > 0).map((c) => c.personName),
            },
            classification: {
                classified,
                unclassified: posts.length - classified,
                complete: posts.length > 0 && classified === posts.length,
            },
            // No cadence figure here any more. It used to be a single
            // posts-per-week number over every platform at once, which is not a
            // quantity — see the note above `cadenceMatrix`. The honest version
            // needs a column per platform, so it has its own route and its own
            // panel rather than a tile it cannot fit in.
            platforms: [...new Set(corpora.map((c) => c.platform))].sort(),
        });
    }),
);

analyticsRouter.get(
    "/report.md",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const report = await buildReport(filter);

        // Rendered from the same document `/report` serves, by the same function
        // the CLI export uses. A second rendering path would be a second source
        // of truth, and the first time they disagreed nobody could say which was
        // right. Recommendations are not included: they cost a model call, and a
        // download button must not silently spend one.
        const filename = `bellwether-${(report.principalName ?? "report").toLowerCase().replace(/\s+/g, "-")}.md`;

        res.type("text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(renderReportMarkdown(report));
    }),
);

analyticsRouter.get(
    "/cadence",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const corpora = await loadCorpora(filter);

        // Every account, one comparison per platform, each over its own window.
        // The arithmetic and the per-column withholding both live in
        // analytics/cadence.ts; this route only projects them.
        res.json({
            filter,
            ...cadenceMatrix(
                corpora.map((c) => ({
                    accountId: c.accountId,
                    personName: c.personName,
                    role: c.role,
                    handle: c.handle,
                    isSynthetic: c.isSynthetic,
                    timezone: c.timezone,
                    platform: c.platform,
                    posts: c.posts,
                })),
            ),
        });
    }),
);

analyticsRouter.get(
    "/formats",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { principal } = await loadWithPrincipal(filter);

        // Per account, not pooled. A Day 2 test proved pooling across accounts
        // conflates format quality with posting habit — it inflated
        // reel-over-link from the planted 3.45x to 6.46x.
        res.json({
            filter,
            accounts: principal.map((corpus) => ({
                accountId: corpus.accountId,
                personName: corpus.personName,
                platform: corpus.platform,
                isSynthetic: corpus.isSynthetic,
                byBasis: analyseFormatsByBasis(corpus.rated, `formats: ${corpus.personName}/${corpus.platform}`),
            })),
        });
    }),
);

analyticsRouter.get(
    "/timing",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { principal } = await loadWithPrincipal(filter);

        res.json({
            filter,
            accounts: principal.map((corpus) => ({
                accountId: corpus.accountId,
                personName: corpus.personName,
                platform: corpus.platform,
                timezone: corpus.timezone,
                isSynthetic: corpus.isSynthetic,
                byBasis: analyseTimingByBasis(corpus.rated, corpus.timezone, `timing: ${corpus.personName}`),
            })),
        });
    }),
);

analyticsRouter.get(
    "/recent-posts",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { principal } = await loadWithPrincipal(filter);

        const count = clampRecentCount(req.query["count"]);

        // The principal's accounts only, matching /timing and /formats. The
        // question behind this panel is "what have WE just put out" — a peer's
        // recent posts are a different question, and the comparison routes are
        // where that one is answered.
        //
        // Built from `corpus.posts` rather than `corpus.rated`: an unrated post
        // still happened. See recentPosts.ts.
        res.json({
            filter,
            count,
            accounts: principal.map((corpus) => ({
                accountId: corpus.accountId,
                personName: corpus.personName,
                platform: corpus.platform,
                handle: corpus.handle,
                timezone: corpus.timezone,
                isSynthetic: corpus.isSynthetic,
                followerCount: corpus.followerCount,
                /** Everything the filter matched — `posts` is the last `count` of these. */
                matchedPosts: corpus.posts.length,
                unratedPosts: corpus.gaps.NO_METRICS + corpus.gaps.NO_DENOMINATOR,
                posts: recentPosts(corpus.posts, { followerCount: corpus.followerCount }, count),
            })),
        });
    }),
);

analyticsRouter.get(
    "/top-posts",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { corpora } = await loadWithPrincipal(filter);

        const count = Number(req.query["count"] ?? 5);

        res.json({
            filter,
            accounts: corpora.map((corpus) => ({
                accountId: corpus.accountId,
                personName: corpus.personName,
                platform: corpus.platform,
                role: corpus.role,
                isSynthetic: corpus.isSynthetic,
                byBasis: topPostsByBasis(corpus.rated, Number.isFinite(count) ? count : 5, `top: ${corpus.personName}`),
            })),
        });
    }),
);

analyticsRouter.get(
    "/compare",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { corpora } = await loadWithPrincipal(filter);

        // All four dimensions of the Module C MUST, on one response so the UI
        // can render them on one screen: engagement, cadence, format mix and
        // best-performing windows.
        const engagement = compareAccountsByBasis(corpora, "compare");

        const cadence = compareCadence(
            corpora.map((c) => ({
                accountId: c.accountId,
                personName: c.personName,
                role: c.role,
                handle: c.handle,
                isSynthetic: c.isSynthetic,
                timezone: c.timezone,
                posts: c.posts,
            })),
        );

        const formatMix = compareFormatMix(
            corpora.map((c) => ({
                accountId: c.accountId,
                personName: c.personName,
                role: c.role,
                isSynthetic: c.isSynthetic,
                posts: c.posts,
            })),
        );

        // Windows carry a basis, so they are computed per basis like engagement.
        const windows: Record<string, unknown> = {};
        for (const basis of BASES) {
            const onBasis = corpora
                .map((c) => ({ ...c, rated: partitionByBasis(c.rated)[basis] }))
                .filter((c) => c.rated.length > 0);

            windows[basis] =
                onBasis.length === 0
                    ? null
                    : compareWindows(
                          onBasis.map((c) => ({
                              accountId: c.accountId,
                              personName: c.personName,
                              role: c.role,
                              isSynthetic: c.isSynthetic,
                              timezone: c.timezone,
                              analysis: analyseTimingByBasis(c.rated, c.timezone, `windows: ${c.personName}`)[basis],
                              occupiedHours: occupiedHours(c.rated, c.timezone),
                          })),
                      );
        }

        res.json({
            filter,
            engagement: {
                VIEWS: engagement.VIEWS,
                FOLLOWERS: engagement.FOLLOWERS,
                sentences: {
                    VIEWS: engagement.VIEWS === null ? null : describeComparison(engagement.VIEWS),
                    FOLLOWERS: engagement.FOLLOWERS === null ? null : describeComparison(engagement.FOLLOWERS),
                },
            },
            cadence: cadence === null ? null : { ...cadence, sentence: describeCadence(cadence) },
            formatMix,
            windows,
        });
    }),
);

analyticsRouter.get(
    "/gaps",
    route(async (req, res) => {
        const filter = parseFilter(req);
        const { corpora } = await loadWithPrincipal(filter);

        const byBasis = findGapsByBasis(corpora, "gaps");

        const withNarrative = (basis: EngagementBasis) => {
            const analysis = byBasis[basis];
            if (analysis === null) return null;

            return {
                ...analysis,
                gaps: analysis.gaps.map((gap) => ({
                    ...gap,
                    sentence: describeGap(gap, analysis.principalName),
                })),
                // Contiguous hours collapsed into one schedulable instruction —
                // "post 19:00-21:00" rather than three separate findings that
                // would read as three independent pieces of evidence.
                hourWindows: mergeHourWindows(analysis.gaps),
            };
        };

        res.json({ filter, VIEWS: withNarrative("VIEWS"), FOLLOWERS: withNarrative("FOLLOWERS") });
    }),
);

/**
 * The whole analytics document — the same one the AI layer is given.
 *
 * Not in the original route list, and worth having for two reasons beyond
 * convenience: the dashboard can render its headline panels from one request
 * instead of six, and a reviewer can see EXACTLY what the recommendation model
 * was shown. The grounding claim is only checkable if the evidence is visible.
 */
analyticsRouter.get(
    "/report",
    route(async (req, res) => {
        const filter = parseFilter(req);
        res.json(await buildReport(filter));
    }),
);
