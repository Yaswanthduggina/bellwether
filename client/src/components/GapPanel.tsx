// What competitors own that the principal does not — and the inverse, where his
// output goes for a below-baseline return.
//
// THIS IS THE ONLY LEGITIMATE SOURCE OF A TIMING RECOMMENDATION, which is worth
// stating in the UI and not just in the code. The principal posts 08:00–16:00
// and never in the evening, so his own best hours come out near 1.0× his median.
// An account's own timing data cannot reveal a slot it never posts in — the
// evening peak exists only in the peers' corpora. A reader looking at the
// heatmap above and concluding "his timing is fine" would be making exactly the
// mistake this panel exists to prevent, so the caveat is on screen.
//
// The provenance caveat is rendered inline rather than as a footnote. A gap
// whose peer evidence is entirely generated demonstrates that the pipeline
// works; it is not a fact about the world, and a reader deciding whether to
// move a posting slot needs that attached to the finding, not filed at the
// bottom of the page.

import type { ReportBasis } from "../api/client";
import { Badge, humanise, Notice } from "./ui";

const KIND_HINT: Record<string, string> = {
    ABSENT: "He has never posted here.",
    THIN: "Too few posts here to tell yet — a cheap next step is simply to post here a few more times.",
    UNDERPERFORMING: "He is present here but behind the peers.",
};

export function GapPanel({ basis }: { basis: ReportBasis }) {
    const hasTimingGap = basis.gaps.some((gap) => gap.dimension === "HOUR" || gap.dimension === "DAY");

    return (
        <div className="stack">
            {hasTimingGap && (
                <Notice kind="info">
                    <strong>Timing findings can only come from here.</strong> The principal posts inside a narrow
                    daytime band, so his own corpus contains no evidence about the hours he never uses — his best hours
                    sit near 1.0× his median for that reason. Any recommendation to move a slot draws on the peers'
                    data, below.
                </Notice>
            )}

            {basis.gaps.length === 0 ? (
                <p className="muted">
                    No gap clears the bar on this basis: a gap needs at least two peers independently beating their own
                    baseline by 20% or more in the same bucket.
                </p>
            ) : (
                <div className="table-scroll">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Opportunity</th>
                                <th>Dimension</th>
                                <th className="n">Peer lift</th>
                                <th>Agreement</th>
                                <th className="n">His n</th>
                            </tr>
                        </thead>
                        <tbody>
                            {basis.gaps.map((gap) => (
                                <tr key={`${gap.dimension}-${gap.label}`}>
                                    <td>
                                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                                            <strong className="num">{humanise(gap.label)}</strong>
                                            <Badge
                                                kind={gap.kind === "ABSENT" ? "accent" : "neutral"}
                                                title={KIND_HINT[gap.kind]}
                                            >
                                                {gap.kind}
                                            </Badge>
                                        </div>
                                        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                                            {gap.sentence}
                                        </div>
                                        {gap.provenanceCaveat !== null && (
                                            <div style={{ fontSize: 12.5, marginTop: 4, color: "var(--seeded)" }}>
                                                ⚑ {gap.provenanceCaveat}
                                            </div>
                                        )}
                                    </td>
                                    <td>{gap.dimension}</td>
                                    <td className="n">{gap.peerLift.toFixed(2)}×</td>
                                    <td className="num" style={{ fontSize: 12.5 }}>
                                        {gap.peerAgreement}
                                    </td>
                                    <td className="n">{gap.principalN}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {basis.overInvested.length > 0 && (
                <div>
                    <span className="eyebrow">Where his output is going for a below-baseline return</span>
                    <table className="table" style={{ marginTop: 6 }}>
                        <thead>
                            <tr>
                                <th>Bucket</th>
                                <th className="n">Share of output</th>
                                <th className="n">vs own baseline</th>
                                <th className="n">n</th>
                            </tr>
                        </thead>
                        <tbody>
                            {basis.overInvested.map((item) => (
                                <tr key={item.label}>
                                    <td>
                                        <strong>{humanise(item.label)}</strong>
                                        <div className="muted" style={{ fontSize: 12.5 }}>
                                            {item.sentence}
                                        </div>
                                    </td>
                                    <td className="n">{item.shareOfOutputPct}%</td>
                                    <td className="n" style={{ color: "var(--bad)" }}>
                                        {item.lift.toFixed(2)}×
                                    </td>
                                    <td className="n">{item.n}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
