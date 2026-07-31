// Question 1 — "what content works?"
//
// FORM: horizontal bars. The data is magnitude by category with long category
// names, and a horizontal layout gives the labels room without rotating them.
// One series, so no legend — the title names it.
//
// COLOUR: a single sequential hue, because there is one measure. Colouring each
// bar differently would encode identity that carries no information, and
// colouring by rank would repaint the survivors whenever a filter changes the
// set — the rule is that colour follows the entity, never its position.
//
// The table beside the chart is not a fallback. Median alone hides the shape of
// a distribution, so n and the outlier flag ride along with every bar: the brief
// asks for spread, and a format that looks good because of one viral post is a
// trap this product is supposed to catch rather than fall into.

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ReportBasis } from "../api/client";
import { Badge, humanise } from "./ui";

interface Row {
    name: string;
    rate: number;
    multiple: number;
    n: number;
    outlierDriven: boolean;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
    if (!active || !payload?.length) return null;
    const row = payload[0]!.payload;

    return (
        <div
            style={{
                background: "var(--paper-raised)",
                border: "1px solid var(--rule-strong)",
                borderRadius: "var(--radius)",
                padding: "8px 11px",
                boxShadow: "var(--shadow)",
                fontSize: 13,
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{row.name}</div>
            <div className="num">{row.rate.toFixed(2)}% median engagement</div>
            <div className="num">{row.multiple.toFixed(2)}× the account median</div>
            <div className="muted num">n = {row.n}</div>
            {row.outlierDriven && (
                <div style={{ color: "var(--warn)", marginTop: 4, maxWidth: 210 }}>
                    Outlier-driven — mean is more than 1.5× the median, so one post is carrying this.
                </div>
            )}
        </div>
    );
}

export function FormatChart({ basis }: { basis: ReportBasis }) {
    const rows: Row[] = basis.formats.map((format) => ({
        name: humanise(format.mediaType),
        rate: format.medianRatePct,
        multiple: format.multipleOfOverall,
        n: format.n,
        outlierDriven: format.outlierDriven,
    }));

    if (rows.length === 0) {
        return <p className="muted">No format meets the minimum sample size on this basis.</p>;
    }

    return (
        <div className="split" style={{ gridTemplateColumns: "minmax(300px, 1.15fr) minmax(280px, 1fr)" }}>
            <div>
                <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 46)}>
                    <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }}>
                        <CartesianGrid horizontal={false} stroke="var(--grid-line)" />
                        <XAxis
                            type="number"
                            tick={{ fill: "var(--axis-ink)", fontSize: 11 }}
                            stroke="var(--rule-strong)"
                            tickLine={false}
                            unit="%"
                        />
                        <YAxis
                            type="category"
                            dataKey="name"
                            width={122}
                            tick={{ fill: "var(--ink-soft)", fontSize: 12 }}
                            stroke="var(--rule-strong)"
                            tickLine={false}
                        />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--paper-sunken)" }} />
                        <Bar dataKey="rate" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
                            {rows.map((row) => (
                                <Cell key={row.name} fill="var(--series-1)" />
                            ))}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
                <p className="muted" style={{ fontSize: 12, margin: "2px 0 0 4px" }}>
                    Median engagement rate, {basis.denominator}.
                </p>
            </div>

            <div className="table-scroll">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Format</th>
                            <th className="n">Median</th>
                            <th className="n">vs own</th>
                            <th className="n">n</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.name}>
                                <td>
                                    {row.name}{" "}
                                    {row.outlierDriven && (
                                        <Badge
                                            kind="mixed"
                                            title="Mean is more than 1.5× the median — one viral post is carrying this format. Read the median."
                                        >
                                            outlier-driven
                                        </Badge>
                                    )}
                                </td>
                                <td className="n">{row.rate.toFixed(2)}%</td>
                                <td className="n">{row.multiple.toFixed(2)}×</td>
                                <td className="n">{row.n}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
