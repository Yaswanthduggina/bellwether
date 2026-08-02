// What competitors own that the principal does not — the evidence behind each
// finding, the candidates that were rejected and why, and the inverse, where his
// output goes for a below-baseline return.
//
// THIS IS THE ONLY LEGITIMATE SOURCE OF A TIMING RECOMMENDATION, which is worth
// stating in the UI and not just in the code. The principal posts inside a narrow
// daytime band, so his own best hours come out near 1.0× his median. An account's
// own timing data cannot reveal a slot it never posts in — the evening peak
// exists only in the peers' corpora. A reader looking at the heatmap above and
// concluding "his timing is fine" would be making exactly the mistake this panel
// exists to prevent, so the caveat is on screen.
//
// ── WHY THIS PANEL SHOWS ITS REJECTS ─────────────────────────────────────
//
// The gates in analytics/gaps.ts are strict, and on a real 90-day corpus they
// reject nearly everything: the first live run across three platforms returned
// ONE gap in six basis-platform combinations. Every earlier version of this file
// rendered that as a single grey line — "No gap clears the bar on this basis" —
// above a table about over-investment, which is a different question. The panel
// was mostly about the wrong thing, and the part that WAS about gaps looked like
// the analysis had not run.
//
// The statistic was not the problem. Throwing away the evidence was. The analysis
// knows which buckets came close and precisely which gate stopped each one, and
// that is the most useful thing on the screen when nothing clears: a bucket where
// one peer sits at 1.48× and a second at 1.11× is not "nothing", it is a named,
// quantified thing to watch with a stated distance to the bar.
//
// So near misses are rendered — separately, under their own heading, in muted
// type, each labelled with the gate it failed. THEY ARE NOT FINDINGS AND MUST
// NEVER READ AS FINDINGS. That is the entire design constraint of the lower half
// of this component: every affordance that makes a gap look actionable (the
// opportunity multiple, the accent badge, the full-strength type) is deliberately
// withheld from a near miss.
//
// The per-peer evidence rows are here for a related reason. "2 of 3 peers agree"
// is an assertion the reader previously had no way to check — which two, and by
// how much, was computed and then dropped on the way to the UI. A reader deciding
// whether to move a posting slot is entitled to the names.
//
// The provenance caveat is rendered inline rather than as a footnote. A gap whose
// peer evidence is entirely generated demonstrates that the pipeline works; it is
// not a fact about the world, and a reader deciding whether to move a posting slot
// needs that attached to the finding, not filed at the bottom of the page.

import type { ReportBasis, ReportNearMiss, ReportPeerEvidence } from "../api/client";
import { Badge, humanise, Notice } from "./ui";

const KIND_HINT: Record<string, string> = {
    ABSENT: "He has never posted here.",
    THIN: "Too few posts here to tell yet — a cheap next step is simply to post here a few more times.",
    UNDERPERFORMING: "He is present here but behind the peers.",
};

/**
 * Why a candidate was rejected, in the reader's language.
 *
 * Each label names the GATE rather than the outcome. "Not enough agreement" tells
 * a reader something they can reason about; "rejected" does not.
 */
const REASON_LABEL: Record<string, string> = {
    SINGLE_PEER_ONLY: "Only one peer has data",
    NO_PEER_AGREEMENT: "Peers disagree",
    PRINCIPAL_COMPETITIVE: "He already matches them",
};

/** The one reason that is good news rather than an untested candidate. */
const GOOD_NEWS = "PRINCIPAL_COMPETITIVE";

/**
 * The peers behind a figure, with the ones that carried it marked.
 *
 * `clears` comes from the API rather than being recomputed here against a
 * hardcoded 1.2 — the threshold lives in one place in the analytics layer, and a
 * UI copy of it would be a second place for it to drift.
 */
function PeerEvidenceRow({ peers }: { peers: readonly ReportPeerEvidence[] }) {
    if (peers.length === 0) return null;

    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginTop: 5 }}>
            {peers.map((peer) => (
                <span
                    key={peer.personName}
                    className="num"
                    style={{
                        fontSize: 12,
                        color: peer.clears ? "var(--ink)" : "var(--ink-faint)",
                        fontWeight: peer.clears ? 600 : 400,
                    }}
                    title={
                        peer.clears
                            ? `${peer.personName} clears the bar here on their own (n=${peer.n})`
                            : `${peer.personName} does not clear the bar here (n=${peer.n})`
                    }
                >
                    {peer.clears ? "✓" : "·"} {peer.personName} {peer.lift.toFixed(2)}×
                    <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}> (n={peer.n})</span>
                    {peer.isSynthetic && <span style={{ color: "var(--seeded)" }}> ⚑</span>}
                </span>
            ))}
        </div>
    );
}

/**
 * The rejected candidates.
 *
 * Deliberately not a table. A table would give these rows the same visual weight
 * as the findings above them, and the whole point is that they carry less.
 */
function NearMisses({ misses }: { misses: readonly ReportNearMiss[] }) {
    return (
        <div>
            <span className="eyebrow">Considered, did not clear the bar</span>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 10 }}>
                Buckets where at least one peer beat their own baseline by 20% or more, but the evidence did not
                survive the gate named against each. <strong>These are not findings.</strong> They are what the
                analysis looked at and refused, and the distance to the bar is the part worth watching.
            </p>

            <div className="stack" style={{ gap: 10 }}>
                {misses.map((miss) => (
                    <div
                        key={`${miss.dimension}-${miss.label}-${miss.reason}`}
                        style={{
                            borderLeft: "2px solid var(--rule)",
                            paddingLeft: 12,
                            opacity: miss.reason === GOOD_NEWS ? 0.75 : 1,
                        }}
                    >
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                            <strong className="num" style={{ color: "var(--ink-soft)" }}>
                                {humanise(miss.label)}
                            </strong>
                            <span className="muted" style={{ fontSize: 11.5 }}>
                                {miss.dimension}
                            </span>
                            <Badge kind="neutral">{REASON_LABEL[miss.reason] ?? miss.reason}</Badge>
                            <span className="num" style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                                peers {miss.peerLift.toFixed(2)}× · {miss.peerAgreement} clear · his n=
                                {miss.principalN}
                            </span>
                        </div>

                        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                            {miss.whatWouldChangeIt}
                        </div>

                        <PeerEvidenceRow peers={miss.peers} />
                    </div>
                ))}
            </div>
        </div>
    );
}

export function GapPanel({ basis }: { basis: ReportBasis }) {
    const hasTimingGap = basis.gaps.some((gap) => gap.dimension === "HOUR" || gap.dimension === "DAY");
    const hasTimingNearMiss = basis.nearMisses.some((m) => m.dimension === "HOUR" || m.dimension === "DAY");

    return (
        <div className="stack">
            {(hasTimingGap || hasTimingNearMiss) && (
                <Notice kind="info">
                    <strong>Timing findings can only come from here.</strong> The principal posts inside a narrow
                    daytime band, so his own corpus contains no evidence about the hours he never uses — his best hours
                    sit near 1.0× his median for that reason. Any recommendation to move a slot draws on the peers'
                    data, below.
                </Notice>
            )}

            {basis.gaps.length === 0 ? (
                <p className="muted">
                    No gap clears the bar on this basis: a gap needs at least one peer beating its own baseline by 20%
                    or more, over five posts or more, in the same bucket
                    {basis.nearMisses.length > 0 && (
                        <>
                            {" "}
                            — but {basis.nearMisses.length} bucket{basis.nearMisses.length === 1 ? "" : "s"} came close
                            enough to name, below
                        </>
                    )}
                    .
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
                                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                                            <strong className="num">{humanise(gap.label)}</strong>
                                            <Badge
                                                kind={gap.kind === "ABSENT" ? "accent" : "neutral"}
                                                title={KIND_HINT[gap.kind]}
                                            >
                                                {gap.kind}
                                            </Badge>
                                            {/*
                                                The peer floor is 1, so a gap can rest on a single
                                                competitor. That used to be refused outright, on the
                                                argument that one account's strong bucket is that
                                                account's habit rather than a pattern — an argument
                                                that was never wrong, only outweighed. Since the
                                                finding now ships, the reader has to be able to see
                                                it is a finding about one account WITHOUT reading
                                                the evidence row below it.
                                            */}
                                            {gap.peers.filter((p) => p.clears).length === 1 && (
                                                <Badge
                                                    kind="mixed"
                                                    title="Only one competitor clears the bar in this bucket. One account's strong bucket can be that account's habit rather than a pattern — check the evidence below before acting on it."
                                                >
                                                    ONE PEER
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                                            {gap.sentence}
                                        </div>
                                        {/* Who the finding rests on. "2 of 3" is not checkable without it. */}
                                        <PeerEvidenceRow peers={gap.peers} />
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

            {basis.nearMisses.length > 0 && <NearMisses misses={basis.nearMisses} />}

            {/*
                What each dimension was able to test. Without this, a dimension that
                ran on nothing — theme, before classification completes — is
                indistinguishable from one that ran and found nothing.
            */}
            {basis.gapCoverage.length > 0 && (
                <div>
                    <span className="eyebrow">What was searched</span>
                    <div
                        style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 5, fontSize: 12 }}
                        className="muted"
                    >
                        {basis.gapCoverage.map((c) => (
                            <span key={c.dimension} title={`${c.gaps} gaps, ${c.nearMisses} near misses`}>
                                <strong>{c.dimension}</strong>{" "}
                                <span className="num">
                                    {c.bucketsTestable}/{c.bucketsConsidered}
                                </span>{" "}
                                buckets testable
                            </span>
                        ))}
                    </div>
                    <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                        A bucket is testable when at least one peer has five or more posts in it. The rest are not
                        findings of absence — they are buckets with too little peer data to judge.
                    </p>
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
