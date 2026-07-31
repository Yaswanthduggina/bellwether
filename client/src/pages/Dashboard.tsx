// The briefing. Recommendations first, then the evidence for them.
//
// THREE REQUESTS, NOT NINE. `GET /api/analytics/report` is the same document the
// recommendation model is given, and it already carries formats, comparison,
// cadence, gaps, over-investment and top posts for every platform. Rendering the
// dashboard from it means the reviewer is looking at exactly what the model
// looked at — the grounding claim is only checkable if the evidence is visible.
// The heatmap needs the full 7×24 grid, which the report deliberately does not
// carry, so timing is the second request. Recommendations are the third.
//
// PLATFORMS ARE TABS, NOT STACKED SECTIONS. Engagement rates on different
// platforms have different denominators — views on YouTube and X, followers on
// Instagram and Facebook — and are not comparable. Tabs make "one platform at a
// time" the default way to read the page, where four stacked sections would
// invite exactly the cross-platform comparison the analytics layer refuses to
// compute.

import { useMemo, useState } from "react";
import { api, type Filter, type Platform, type ReportBasis } from "../api/client";
import { ComparePanel } from "../components/ComparePanel";
import { Filters } from "../components/Filters";
import { FormatChart } from "../components/FormatChart";
import { GapPanel } from "../components/GapPanel";
import { KpiRow } from "../components/KpiRow";
import { Recommendations } from "../components/Recommendations";
import { TimingHeatmap } from "../components/TimingHeatmap";
import { TopPosts } from "../components/TopPosts";
import { Loading, Notes, Notice, Panel, SeededBadge } from "../components/ui";
import { useAsync } from "../hooks/useAsync";

export function Dashboard() {
    const [filter, setFilter] = useState<Filter>({});
    const [platformTab, setPlatformTab] = useState<Platform | null>(null);
    const [basisTab, setBasisTab] = useState<string | null>(null);

    // Stable across renders so useAsync's dependency array does not thrash.
    const key = JSON.stringify(filter);

    const report = useAsync(() => api.report(filter), [key]);
    const overview = useAsync(() => api.overview(filter), [key]);
    const timing = useAsync(() => api.timing(filter), [key]);
    const recommendations = useAsync(() => api.recommendations(filter), [key]);

    const platforms = report.data?.platforms ?? [];

    const activePlatform = useMemo(
        () => platforms.find((p) => p.platform === platformTab) ?? platforms[0] ?? null,
        [platforms, platformTab],
    );

    const activeBasis: ReportBasis | null = useMemo(() => {
        if (activePlatform === null) return null;
        return activePlatform.bases.find((b) => b.basis === basisTab) ?? activePlatform.bases[0] ?? null;
    }, [activePlatform, basisTab]);

    // The timing route returns the principal's accounts across every platform.
    const timingAccount = useMemo(() => {
        if (activePlatform === null) return null;
        return timing.data?.accounts.find((a) => a.platform === activePlatform.platform) ?? null;
    }, [timing.data, activePlatform]);

    const timingAnalysis =
        timingAccount === null || activeBasis === null ? null : (timingAccount.byBasis[activeBasis.basis] ?? null);

    if (report.error) {
        return (
            <>
                <Filters value={filter} onApply={setFilter} />
                <Notice kind="bad">
                    <strong>Could not load the analytics.</strong> {report.error.message}
                </Notice>
                <button className="button ghost" onClick={report.reload}>
                    Try again
                </button>
            </>
        );
    }

    return (
        <>
            <Filters value={filter} onApply={setFilter} />

            <Recommendations
                run={recommendations.data}
                error={recommendations.error}
                loading={recommendations.loading}
                onRetry={recommendations.reload}
            />

            {overview.loading || overview.data === null ? (
                <Loading lines={2} />
            ) : (
                <div style={{ marginBottom: 20 }}>
                    <KpiRow overview={overview.data} />
                </div>
            )}

            {report.loading || report.data === null ? (
                <Panel title="Analytics">
                    <Loading lines={6} />
                </Panel>
            ) : platforms.length === 0 ? (
                <Notice kind="warn">
                    No platform has any posts under this filter. Widen it, or ingest data with{" "}
                    <code>cd server &amp;&amp; npm run seed</code>.
                </Notice>
            ) : (
                <>
                    <div className="tabs" role="tablist">
                        {platforms.map((platform) => (
                            <button
                                key={platform.platform}
                                role="tab"
                                aria-selected={platform.platform === activePlatform?.platform}
                                className={platform.platform === activePlatform?.platform ? "active" : ""}
                                onClick={() => {
                                    setPlatformTab(platform.platform);
                                    setBasisTab(null);
                                }}
                            >
                                {platform.platform}
                                <SeededBadge provenance={platform.provenance} accounts={platform.seededAccounts} />
                            </button>
                        ))}
                    </div>

                    {activePlatform !== null && activeBasis !== null ? (
                        <>
                            {activePlatform.bases.length > 1 && (
                                <div className="chip-row" style={{ marginBottom: 16 }}>
                                    <span className="eyebrow">Engagement basis</span>
                                    {activePlatform.bases.map((basis) => (
                                        <button
                                            key={basis.basis}
                                            className={basis.basis === activeBasis.basis ? "button" : "button ghost"}
                                            onClick={() => setBasisTab(basis.basis)}
                                            title={`Rates divided by ${basis.denominator}.`}
                                        >
                                            {basis.basis}
                                        </button>
                                    ))}
                                    <span className="muted" style={{ fontSize: 12.5 }}>
                                        Rates on different bases are never averaged together — {activeBasis.denominator}.
                                    </span>
                                </div>
                            )}

                            <Panel
                                eyebrow="Question 1 · what content works?"
                                title="Format performance"
                                sub={`Median engagement rate by format on ${activePlatform.platform}, over ${activeBasis.principalRatedPosts} rated posts. Formats below five posts are not reported.`}
                                right={
                                    <SeededBadge
                                        provenance={activePlatform.provenance}
                                        accounts={activePlatform.seededAccounts}
                                    />
                                }
                            >
                                <FormatChart basis={activeBasis} />
                            </Panel>

                            <Panel
                                eyebrow="Question 2 · when should we post?"
                                title="Timing"
                                sub={`Day × hour in ${activeBasis.timezone}, the account's own zone. Each cell is that slot's median as a multiple of the account's overall median.`}
                            >
                                {timing.loading ? (
                                    <Loading lines={4} />
                                ) : timingAnalysis === null ? (
                                    <p className="muted">
                                        No timing analysis on this basis — the principal has no rated posts here.
                                    </p>
                                ) : (
                                    <TimingHeatmap analysis={timingAnalysis} />
                                )}
                            </Panel>

                            <Panel
                                eyebrow="Question 3 · how do we compare?"
                                title="Principal vs peers"
                                sub="Engagement, cadence, format mix and best-performing windows, on one screen."
                                right={
                                    <SeededBadge
                                        provenance={activePlatform.provenance}
                                        accounts={activePlatform.seededAccounts}
                                    />
                                }
                            >
                                <ComparePanel platform={activePlatform} basis={activeBasis} />
                            </Panel>

                            <Panel
                                title="Gaps"
                                sub="Formats, slots and themes at least two peers independently win with, that the principal does not use — and where his own output is going for a below-baseline return."
                            >
                                <GapPanel basis={activeBasis} />
                            </Panel>

                            <Panel title="Best and worst posts" sub="Ranked on engagement rate, never on raw counts.">
                                <TopPosts best={activeBasis.bestPosts} worst={activeBasis.worstPosts} />
                            </Panel>
                        </>
                    ) : (
                        <Notice kind="warn">
                            {activePlatform?.platform ?? "This platform"} has {activePlatform?.totalPosts ?? 0} posts
                            but no computable engagement rates — every post is missing metrics or a denominator.
                        </Notice>
                    )}

                    <Panel title="What this report could not establish">
                        {report.data.notes.length === 0 && report.data.truncations.length === 0 ? (
                            <p className="muted">Nothing was suppressed or truncated under this filter.</p>
                        ) : (
                            <>
                                <Notes notes={report.data.notes} />
                                <Notes notes={report.data.truncations} />
                            </>
                        )}
                        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                            Report generated {new Date(report.data.generatedAt).toLocaleString()}
                            {report.data.window !== null && ` · window ${report.data.window.days} days`}
                            {" · "}
                            {report.data.corpusProvenance.livePosts.toLocaleString()} live and{" "}
                            {report.data.corpusProvenance.seededPosts.toLocaleString()} seeded posts.
                        </p>
                    </Panel>
                </>
            )}
        </>
    );
}
