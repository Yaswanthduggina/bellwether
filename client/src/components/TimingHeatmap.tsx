// Question 2 — "when should we post?"
//
// COLOUR IS DIVERGING, NOT SEQUENTIAL, and that is a data decision. The value
// plotted is a cell's median as a multiple of the account's OWN median, so 1.0×
// is a real midpoint meaning "exactly typical for this account" — above and
// below it are opposite findings. A one-hue sequential ramp would render "half
// as good as usual" and "typical" as neighbouring shades of the same colour and
// lose the sign. Two hues with a neutral grey midpoint keep it.
//
// THE HONESTY PROBLEM THIS PANEL HAS TO SOLVE
//
// A 7×24 grid is 168 cells; ninety days of heavy posting is under a hundred
// posts. So the typical cell holds zero or one post and a real account's grid is
// mostly empty. That is arithmetic, not a rendering bug, and no amount of visual
// polish fixes it. The server suppresses cells below n=3 before they ever reach
// here, and this component draws the suppressed ones as hatching rather than
// omitting them — an empty grid is itself the finding that an account posts in a
// narrow band, which is precisely the fact behind this product's most important
// recommendation.
//
// The hour and day marginals are shown alongside for the same reason: they carry
// ~4× and ~24× the sample of a grid cell, so they are what a recommendation is
// allowed to cite. The grid is a picture of posting habit.

import { useState } from "react";
import type { TimingAnalysis } from "../api/client";
import { DAY_NAMES } from "./ui";

/** Diverging steps around 1.0×. Four per arm, equal count, neutral midpoint. */
function colourFor(multiple: number): string {
    if (multiple >= 1.75) return "var(--div-up-4)";
    if (multiple >= 1.35) return "var(--div-up-3)";
    if (multiple >= 1.15) return "var(--div-up-2)";
    if (multiple > 1.05) return "var(--div-up-1)";
    if (multiple >= 0.95) return "var(--div-mid)";
    if (multiple >= 0.8) return "var(--div-down-1)";
    if (multiple >= 0.6) return "var(--div-down-2)";
    if (multiple >= 0.4) return "var(--div-down-3)";
    return "var(--div-down-4)";
}

interface Hovered {
    day: number;
    hour: number;
    n: number;
    multiple: number;
    confidence: string;
}

export function TimingHeatmap({ analysis }: { analysis: TimingAnalysis }) {
    const [hovered, setHovered] = useState<Hovered | null>(null);

    const cells = new Map<string, (typeof analysis.grid)[number]>();
    for (const cell of analysis.grid) cells.set(`${cell.dayOfWeek}:${cell.hour}`, cell);

    const bestHours = [...analysis.byHour].sort((a, b) => b.multipleOfOverall - a.multipleOfOverall).slice(0, 3);
    const bestDays = [...analysis.byDay].sort((a, b) => b.multipleOfOverall - a.multipleOfOverall).slice(0, 3);

    return (
        <div>
            <div className="table-scroll">
                <div className="heatmap">
                    {DAY_NAMES.map((dayName, day) => (
                        <div key={dayName} style={{ display: "contents" }}>
                            <div className="heat-label">{dayName}</div>
                            {Array.from({ length: 24 }, (_, hour) => {
                                const cell = cells.get(`${day}:${hour}`);
                                const label = `${dayName} ${String(hour).padStart(2, "0")}:00`;

                                if (!cell) {
                                    return (
                                        <div
                                            key={hour}
                                            className="heat-cell empty"
                                            title={`${label} — fewer than 3 posts, suppressed.`}
                                            onMouseEnter={() => setHovered(null)}
                                        />
                                    );
                                }

                                return (
                                    <div
                                        key={hour}
                                        className="heat-cell"
                                        style={{
                                            background: colourFor(cell.multipleOfOverall),
                                            // A low-confidence cell is outlined rather than
                                            // recoloured — recolouring would confuse "few
                                            // posts" with "poor performance".
                                            borderColor:
                                                cell.confidence === "LOW" ? "var(--rule-strong)" : "transparent",
                                            borderStyle: cell.confidence === "LOW" ? "dashed" : "solid",
                                        }}
                                        title={`${label} · ${cell.multipleOfOverall.toFixed(2)}× · n=${cell.n}`}
                                        tabIndex={0}
                                        onMouseEnter={() =>
                                            setHovered({
                                                day,
                                                hour,
                                                n: cell.n,
                                                multiple: cell.multipleOfOverall,
                                                confidence: cell.confidence,
                                            })
                                        }
                                        onFocus={() =>
                                            setHovered({
                                                day,
                                                hour,
                                                n: cell.n,
                                                multiple: cell.multipleOfOverall,
                                                confidence: cell.confidence,
                                            })
                                        }
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>

                <div className="heat-hours">
                    <span />
                    {Array.from({ length: 24 }, (_, hour) => (
                        <span key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>
                    ))}
                </div>
            </div>

            <div className="heat-readout" aria-live="polite">
                {hovered ? (
                    <>
                        <strong>
                            {DAY_NAMES[hovered.day]} {String(hovered.hour).padStart(2, "0")}:00
                        </strong>{" "}
                        — <span className="num">{hovered.multiple.toFixed(2)}×</span> the account median across{" "}
                        <span className="num">{hovered.n}</span> posts.
                        {hovered.confidence === "LOW" && " Thin sample — indicative, not citable."}
                    </>
                ) : (
                    <span className="muted">
                        Hover a cell for its multiple and sample size. All times are {analysis.timezone}, the account's
                        own zone.
                    </span>
                )}
            </div>

            <div className="legend" style={{ marginTop: 12 }}>
                <span>Worse than usual</span>
                <span className="legend-swatches">
                    <i style={{ background: "var(--div-down-4)" }} />
                    <i style={{ background: "var(--div-down-3)" }} />
                    <i style={{ background: "var(--div-down-2)" }} />
                    <i style={{ background: "var(--div-down-1)" }} />
                    <i style={{ background: "var(--div-mid)" }} />
                    <i style={{ background: "var(--div-up-1)" }} />
                    <i style={{ background: "var(--div-up-2)" }} />
                    <i style={{ background: "var(--div-up-3)" }} />
                    <i style={{ background: "var(--div-up-4)" }} />
                </span>
                <span>Better</span>
                <span className="legend-key" style={{ marginLeft: 10 }}>
                    <i className="heat-cell empty" style={{ aspectRatio: "auto", height: 11 }} /> suppressed (n&lt;3)
                </span>
                <span className="legend-key">
                    <i style={{ border: "1px dashed var(--rule-strong)", background: "transparent" }} /> thin (n&lt;5)
                </span>
            </div>

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
                {analysis.suppressedCells} of 168 cells hold posts but fewer than three, and are hidden —{" "}
                {analysis.suppressedPosts} posts in total. A grid this sparse is normal: 168 cells against{" "}
                {analysis.ratedPosts} rated posts. Read the marginals below, not individual cells.
            </p>

            <div className="split" style={{ marginTop: 16 }}>
                <div>
                    <span className="eyebrow">Best hours (day collapsed)</span>
                    <table className="table" style={{ marginTop: 6 }}>
                        <thead>
                            <tr>
                                <th>Hour</th>
                                <th className="n">vs own median</th>
                                <th className="n">n</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bestHours.map((bucket) => (
                                <tr key={bucket.hour}>
                                    <td className="num">{String(bucket.hour).padStart(2, "0")}:00</td>
                                    <td className="n">{bucket.multipleOfOverall.toFixed(2)}×</td>
                                    <td className="n">{bucket.n}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div>
                    <span className="eyebrow">Best days (hour collapsed)</span>
                    <table className="table" style={{ marginTop: 6 }}>
                        <thead>
                            <tr>
                                <th>Day</th>
                                <th className="n">vs own median</th>
                                <th className="n">n</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bestDays.map((bucket) => (
                                <tr key={bucket.dayOfWeek}>
                                    <td>{DAY_NAMES[bucket.dayOfWeek]}</td>
                                    <td className="n">{bucket.multipleOfOverall.toFixed(2)}×</td>
                                    <td className="n">{bucket.n}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
