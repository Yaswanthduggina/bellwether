// Question 3 — "how do we compare?" — all four dimensions of the Module C MUST
// on one screen: engagement, cadence, format mix and best-performing windows.
//
// The pre-written sentence from the server leads each block, and that is not
// laziness. Those sentences are composed by deterministic code from the same
// figures rendered beside them, so they are guaranteed to agree with the table —
// whereas a sentence assembled in the UI is a second implementation of the same
// arithmetic, free to drift from the first.
//
// NOTHING IS POOLED ACROSS PEERS. Each peer is measured against its own median,
// upstream. Pooling would conflate format quality with posting habit, which a
// Day 2 test caught inflating a planted 3.45× to 6.46×.

import type { ReportBasis, ReportPlatform } from "../api/client";
import { humanise, Multiple } from "./ui";

function Cadence({ platform }: { platform: ReportPlatform }) {
    const cadence = platform.cadence;
    if (cadence === null) return <p className="muted">No cadence comparison on this platform.</p>;

    return (
        <>
            <p className="sentence">{cadence.sentence}</p>
            <table className="table">
                <thead>
                    <tr>
                        <th>Cadence</th>
                        <th className="n">Principal</th>
                        <th className="n">Peer median</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Posts per week</td>
                        <td className="n">{cadence.principalPostsPerWeek?.toFixed(2) ?? "—"}</td>
                        <td className="n">{cadence.peerMedianPostsPerWeek?.toFixed(2) ?? "—"}</td>
                    </tr>
                    <tr>
                        <td>
                            Weekly consistency
                            <div className="muted" style={{ fontSize: 11.5 }}>
                                share of weeks with at least one post
                            </div>
                        </td>
                        <td className="n">
                            {cadence.principalConsistencyPct === null ? "—" : `${cadence.principalConsistencyPct}%`}
                        </td>
                        <td className="n">
                            {cadence.peerConsistencyPct === null ? "—" : `${cadence.peerConsistencyPct}%`}
                        </td>
                    </tr>
                    <tr>
                        <td>Longest silence</td>
                        <td className="n">
                            {cadence.principalLongestSilenceDays === null
                                ? "—"
                                : `${cadence.principalLongestSilenceDays} days`}
                        </td>
                        <td className="n muted">—</td>
                    </tr>
                </tbody>
            </table>
            {/* The denominator, stated under the table it divides. Every figure
                above is a rate over this window, and a narrowed window is the
                one thing a reader cannot infer from the numbers themselves. */}
            <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {cadence.narrowedFromDays === null
                    ? `Measured over ${cadence.windowDays} days.`
                    : `Measured over the last ${cadence.windowDays} days, not ${cadence.narrowedFromDays} — ` +
                      `${cadence.narrowedBy.join(", ")} ${cadence.narrowedBy.length === 1 ? "has" : "have"} ` +
                      `no history before that. Consistency over so few weeks is weak evidence.`}
            </p>
        </>
    );
}

function FormatMix({ platform }: { platform: ReportPlatform }) {
    if (platform.formatMixDivergences.length === 0) {
        return <p className="muted">No format the principal allocates differently from peers by 10 points or more.</p>;
    }

    return (
        <table className="table">
            <thead>
                <tr>
                    <th>Format mix</th>
                    <th className="n">Principal</th>
                    <th className="n">Peers</th>
                    <th className="n">Gap</th>
                </tr>
            </thead>
            <tbody>
                {platform.formatMixDivergences.map((row) => {
                    const gap = row.principalSharePct - row.peerSharePct;
                    return (
                        <tr key={row.mediaType}>
                            <td>{humanise(row.mediaType)}</td>
                            <td className="n">{row.principalSharePct}%</td>
                            <td className="n">{row.peerSharePct}%</td>
                            <td className="n" style={{ color: gap > 0 ? "var(--warn)" : "var(--accent)" }}>
                                {gap > 0 ? "+" : ""}
                                {gap}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

export function ComparePanel({ platform, basis }: { platform: ReportPlatform; basis: ReportBasis }) {
    return (
        <div className="stack">
            <div>
                <span className="eyebrow">Engagement</span>
                <p className="sentence" style={{ marginTop: 6 }}>
                    {basis.comparisonSentence}
                </p>
                <div className="chip-row">
                    <span className="chip">
                        rank
                        <strong>
                            {basis.rank === null ? "—" : `${basis.rank.position} of ${basis.rank.outOf}`}
                        </strong>
                    </span>
                    <span className="chip">
                        his median
                        <strong>{basis.principalMedianRatePct.toFixed(2)}%</strong>
                    </span>
                    <span className="chip">
                        peer benchmark
                        <strong>
                            {basis.peerBenchmarkRatePct === null ? "—" : `${basis.peerBenchmarkRatePct.toFixed(2)}%`}
                        </strong>
                    </span>
                    <span className="chip">
                        vs peers
                        <strong>
                            <Multiple value={basis.principalVsPeers} />
                        </strong>
                    </span>
                </div>
            </div>

            <div className="split">
                <div>
                    <span className="eyebrow">Cadence</span>
                    <div style={{ marginTop: 6 }}>
                        <Cadence platform={platform} />
                    </div>
                </div>
                <div>
                    <span className="eyebrow">Format mix</span>
                    <div style={{ marginTop: 6 }}>
                        <FormatMix platform={platform} />
                    </div>
                </div>
            </div>

            <div>
                <span className="eyebrow">Best-performing windows</span>
                {basis.peerWindows.length === 0 ? (
                    <p className="muted" style={{ marginTop: 6 }}>
                        No peer window clears the sample-size bar on this basis.
                    </p>
                ) : (
                    <table className="table" style={{ marginTop: 6 }}>
                        <thead>
                            <tr>
                                <th>Account</th>
                                <th>Best window</th>
                                <th className="n">vs own median</th>
                                <th className="n">n</th>
                            </tr>
                        </thead>
                        <tbody>
                            {basis.bestHours.slice(0, 1).map((hour) => (
                                <tr key={`principal-${hour.hour}`}>
                                    <td>
                                        <strong>Principal</strong>
                                    </td>
                                    <td className="num">{hour.label}</td>
                                    <td className="n">{hour.multipleOfOverall.toFixed(2)}×</td>
                                    <td className="n">{hour.n}</td>
                                </tr>
                            ))}
                            {basis.peerWindows.map((window) => (
                                <tr key={`${window.personName}-${window.label}`}>
                                    <td>{window.personName}</td>
                                    <td className="num">{window.label}</td>
                                    <td className="n">{window.multipleOfOverall.toFixed(2)}×</td>
                                    <td className="n">{window.n}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                    Each account is measured against its own median, never pooled. Pooling would conflate how good a
                    window is with how often that account posts in it.
                </p>
            </div>
        </div>
    );
}
