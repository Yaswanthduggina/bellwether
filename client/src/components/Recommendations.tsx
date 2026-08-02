// Question 4 — "so what do we do?" — at the TOP of the dashboard.
//
// Placement is a product decision, not a layout one. The brief is explicit that
// the recommendations are the deliverable; every chart below this panel exists
// to justify it. Burying it under the charts would make the reader do the
// analysis the product is supposed to have done for her.
//
// TWO THINGS THIS PANEL REFUSES TO HIDE
//
// 1. The drop count. Recommendations that cited a figure not present in the
//    analytics were retried once and then discarded. Showing "4 shown" while
//    silently binning three is the same dishonesty as inventing them, one level
//    up — so the footer states it and the detail is expandable.
// 2. The absence of an API key. The analytics half of this product works with
//    no key at all, so that state is degraded-and-expected rather than broken,
//    and it says what to do about it.

import { useEffect, useRef, useState } from "react";
import type { ApiError, Recommendation, RecommendationRun, ReportPost } from "../api/client";
import { Badge, Chip, humanise, Loading, Notes, Notice, Panel } from "./ui";

const CONFIDENCE_KIND: Record<string, string> = { HIGH: "live", MEDIUM: "mixed", LOW: "neutral" };

/**
 * A live seconds counter for the one slow request in the app.
 *
 * This panel used to promise "a few seconds" while the call actually takes
 * roughly a minute: a ~20k-token report, high thinking, and a model chain that
 * may burn a round trip on an exhausted primary before it starts. A silent
 * skeleton for that long does not read as "working", it reads as "hung", and
 * the reasonable response to a hung page is to reload — which cancels nothing
 * server-side and starts a second call that will be just as slow.
 *
 * A number that visibly moves is the whole fix. It costs one interval and it
 * turns a wait into progress.
 */
function useElapsed(active: boolean): number {
    const [seconds, setSeconds] = useState(0);
    const startedAt = useRef(0);

    useEffect(() => {
        if (!active) return;

        startedAt.current = Date.now();
        setSeconds(0);

        const timer = window.setInterval(() => {
            setSeconds(Math.round((Date.now() - startedAt.current) / 1000));
        }, 1000);

        return () => window.clearInterval(timer);
    }, [active]);

    return seconds;
}

/**
 * Set every numeric literal in the prose in tabular figures.
 *
 * Cosmetic on the surface, but it is the same regex the server validates with,
 * so what gets emphasised is exactly what got checked. The reader's eye lands on
 * the numbers that carry the guarantee.
 */
function withFigures(text: string) {
    const parts = text.split(/(-?\d+(?:\.\d+)?)/g);
    return parts.map((part, index) =>
        /^-?\d+(?:\.\d+)?$/.test(part) ? (
            <span className="fig" key={index}>
                {part}
            </span>
        ) : (
            part
        ),
    );
}

function EvidencePost({ post }: { post: ReportPost }) {
    const when = new Date(post.postedAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });

    return (
        <div className="evidence-post">
            <span className="num">{post.ratePct.toFixed(2)}%</span>
            <span className="num">{post.multipleOfMedian.toFixed(2)}×</span>
            <span>{humanise(post.mediaType)}</span>
            <span className="muted">{when}</span>
            {post.isSynthetic ? (
                <Badge kind="seeded">Seeded</Badge>
            ) : post.permalink ? (
                <a href={post.permalink} target="_blank" rel="noreferrer">
                    open ↗
                </a>
            ) : null}
        </div>
    );
}

function Item({
    rec,
    citedPosts,
}: {
    rec: Recommendation;
    citedPosts: Record<string, ReportPost>;
}) {
    const posts = rec.postIds.map((id) => citedPosts[id]).filter((p): p is ReportPost => Boolean(p));

    return (
        <article className="rec">
            <div className="rec-rank">{rec.priority}</div>
            <div>
                <h3 className="rec-action">{rec.action}</h3>
                <p className="rec-why">{withFigures(rec.rationale)}</p>

                <div className="chip-row">
                    <Badge kind="accent">{rec.platform}</Badge>
                    <Badge kind="neutral">{humanise(rec.dimension)}</Badge>
                    <Chip label="n" value={rec.sampleSize} title="Posts behind this claim." />
                    <Badge
                        kind={CONFIDENCE_KIND[rec.confidence] ?? "neutral"}
                        title="The model's own confidence in the finding, not in the arithmetic."
                    >
                        {rec.confidence}
                    </Badge>
                    {rec.figures.length > 0 && (
                        <Chip
                            label="figures"
                            value={rec.figures.join(" · ")}
                            title="Every figure checked against the analytics report before this was shown."
                        />
                    )}
                </div>

                {posts.length > 0 && (
                    <div className="evidence">
                        <span className="eyebrow">Posts behind this</span>
                        {posts.map((post) => (
                            <EvidencePost key={post.id} post={post} />
                        ))}
                    </div>
                )}
            </div>
        </article>
    );
}

export function Recommendations({
    run,
    error,
    loading,
    onRetry,
}: {
    run: RecommendationRun | null;
    error: ApiError | null;
    loading: boolean;
    onRetry: () => void;
}) {
    const [showDropped, setShowDropped] = useState(false);

    // Before the early returns — a hook cannot live behind a branch.
    const elapsed = useElapsed(loading);

    const sub =
        "Every number below was checked against the computed analytics before it was shown. " +
        "Anything that cited a figure the data does not contain was retried once, then discarded.";

    if (loading) {
        return (
            <Panel lead eyebrow="Question 4 · so what do we do?" title="Recommendations" sub={sub}>
                <Loading lines={4} />
                <p className="muted" style={{ fontSize: 13 }}>
                    Generating and validating — <strong>{elapsed}s elapsed</strong>. This is the only request in the
                    app that calls the model, and it usually takes <strong>40–70 seconds</strong>: the model is given
                    the whole analytics report and every figure it writes is then checked back against it. Leave the
                    page open — reloading starts again from zero. Repeat views of the same filter are served from the
                    last run and are instant.
                    {elapsed > 90 && (
                        <>
                            {" "}
                            <strong>Longer than expected.</strong> Still waiting rather than failed — the request has
                            no client timeout. The server log names the model actually answering.
                        </>
                    )}
                </p>
            </Panel>
        );
    }

    if (error) {
        return (
            <Panel lead eyebrow="Question 4 · so what do we do?" title="Recommendations">
                <Notice kind={error.isAiUnavailable ? "warn" : "bad"}>
                    <strong>{error.isAiUnavailable ? "The AI layer is unavailable." : "Could not generate."}</strong>{" "}
                    {error.message}
                    {error.isAiUnavailable && (
                        <>
                            {" "}
                            The analytics below are unaffected — they are computed, not generated. The exact document
                            the model would have been given is at <code>GET /api/analytics/report</code>.
                        </>
                    )}
                </Notice>
                <button className="button ghost" onClick={onRetry}>
                    Try again
                </button>
            </Panel>
        );
    }

    if (!run) return null;

    return (
        <Panel
            lead
            eyebrow="Question 4 · so what do we do?"
            title="Recommendations"
            sub={sub}
            right={
                <button
                    className="icon-button"
                    onClick={onRetry}
                    title="Re-request for the current filter. If nothing about the corpus has changed the server returns the run it already has — these calls run at temperature 0, so a second one would produce the same advice at the cost of another minute and another request against the daily quota."
                >
                    ↻ Regenerate
                </button>
            }
        >
            {run.recommendations.length === 0 ? (
                <Notice kind="warn">
                    No recommendations survived validation.{" "}
                    {run.generated > 0
                        ? `The model produced ${run.generated}, and every one cited a figure that is not in the analytics.`
                        : "The model produced none for this filter."}
                </Notice>
            ) : (
                run.recommendations.map((rec, index) => (
                    <Item key={`${rec.priority}-${index}`} rec={rec} citedPosts={run.citedPosts} />
                ))
            )}

            <div
                className="chip-row"
                style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--rule)", fontSize: 12 }}
            >
                <Chip label="generated" value={run.generated} />
                <Chip label="shown" value={run.recommendations.length} />
                <Chip
                    label="repaired"
                    value={run.repaired}
                    title="Failed validation once, then passed after being told the specific violation."
                />
                <Chip
                    label="dropped"
                    value={run.dropped.length}
                    title="Failed validation twice and were discarded. A dropped recommendation is better than a fabricated one."
                />
                <Chip
                    label="verified numbers"
                    value={run.evidence.numbers}
                    title="The size of the set the validator checks against. A large jump here would mean validation has weakened."
                />
                <Chip label="model" value={run.model} />
                {run.cached && (
                    <Chip
                        label="served from"
                        value={`run of ${new Date(run.generatedAt).toLocaleTimeString()}`}
                        title="The corpus and filter have not changed since this was generated, so the model was not called again. Any ingestion, classification or roster edit invalidates it automatically."
                    />
                )}
                {run.dropped.length > 0 && (
                    <button className="icon-button" onClick={() => setShowDropped((v) => !v)}>
                        {showDropped ? "Hide" : "Show"} what was dropped
                    </button>
                )}
            </div>

            {showDropped && (
                <div style={{ marginTop: 14 }}>
                    {run.dropped.map((drop, index) => (
                        <Notice kind="plain" key={index}>
                            <strong>{drop.recommendation.action}</strong>
                            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                                {drop.violations.map((violation, i) => (
                                    <li key={i} style={{ fontSize: 12.5 }}>
                                        <code>{violation.code}</code> {violation.message}
                                    </li>
                                ))}
                            </ul>
                        </Notice>
                    ))}
                </div>
            )}

            <Notes notes={run.notes} />
        </Panel>
    );
}
