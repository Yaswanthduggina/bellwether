// The KPI row. Stat tiles, not charts — six single numbers have no shape to
// plot, and a bar chart of unrelated magnitudes would invent a comparison
// between them that does not exist.
//
// `rated` is here rather than only in a tooltip on purpose. Every engagement
// figure in this product is computed over posts that HAVE metrics and a
// denominator, which is fewer than the posts ingested. A KPI row that shows 940
// posts beside an engagement rate computed over 512 of them is the quiet
// version of a made-up number.

import type { Overview } from "../api/client";
import { SeededBadge } from "./ui";

function Kpi({ label, value, foot }: { label: string; value: string; foot?: React.ReactNode }) {
    return (
        <div className="kpi">
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            {foot !== undefined && <div className="foot">{foot}</div>}
        </div>
    );
}

export function KpiRow({ overview }: { overview: Overview }) {
    const { provenance, classification } = overview;
    const ratedPct =
        overview.totalPosts === 0 ? 0 : Math.round((overview.ratedPosts / overview.totalPosts) * 100);

    return (
        <div className="kpi-row">
            <Kpi
                label="Posts"
                value={overview.totalPosts.toLocaleString()}
                foot={`${overview.principalPosts.toLocaleString()} from the principal`}
            />
            <Kpi
                label="Rated"
                value={overview.ratedPosts.toLocaleString()}
                foot={`${ratedPct}% — the rest lack metrics or a denominator`}
            />
            <Kpi
                label="Accounts"
                value={String(overview.accounts)}
                foot={`${overview.people} people across ${overview.platforms.length} platforms`}
            />
            <Kpi
                label="Provenance"
                value={`${100 - provenance.seededPct}% live`}
                foot={
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <SeededBadge
                            provenance={
                                provenance.seededPosts === 0
                                    ? "LIVE"
                                    : provenance.livePosts === 0
                                      ? "SEEDED"
                                      : "MIXED"
                            }
                            accounts={provenance.seededAccounts}
                        />
                        {provenance.seededPosts.toLocaleString()} seeded
                    </span>
                }
            />
            <Kpi
                label="Classified"
                value={
                    overview.totalPosts === 0
                        ? "—"
                        : `${Math.round((classification.classified / overview.totalPosts) * 100)}%`
                }
                foot={
                    classification.complete
                        ? "every post has a theme"
                        : `${classification.unclassified.toLocaleString()} still unclassified`
                }
            />
            <Kpi
                label="Cadence"
                value={
                    overview.cadence?.principalPostsPerWeek == null
                        ? "—"
                        : `${overview.cadence.principalPostsPerWeek.toFixed(1)}/wk`
                }
                foot={
                    overview.cadence === null
                        ? "no principal in this filter"
                        : // A blank rate here is the truncation guard, not a missing
                          // principal, and a tile that says nothing invites the reader
                          // to assume the pipeline broke. The full explanation is the
                          // sentence on the Compare panel.
                          overview.cadence.principalPostsPerWeek === null
                          ? "withheld — see Compare"
                          : overview.cadence.peerMedianPostsPerWeek === null
                            ? "no peer benchmark"
                            : `peers ${overview.cadence.peerMedianPostsPerWeek.toFixed(1)}/wk`
                }
            />
        </div>
    );
}
