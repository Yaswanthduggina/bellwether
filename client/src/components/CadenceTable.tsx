// How often does everyone post, everywhere? — person × platform.
//
// This panel replaced a single KPI tile, and the reason is worth keeping. One
// posts-per-week number over every platform at once is not a quantity: the
// principal posts at three different rates on three platforms, measured over
// three different windows, and the old tile picked whichever platform happened
// to sort first and compared it against a peer median pooled across all of
// them. The shape of the honest answer is a grid, so this is a grid.
//
// WHAT THE READER MUST NOT DO WITH IT. Reading DOWN a column is a like-for-like
// comparison — same platform, same window, same unit of work. Reading ACROSS a
// row is not: a tweet and a twenty-minute upload are not the same thing to
// produce, and each column carries its own window besides. The footnote says
// so, because the grid itself invites the comparison it cannot support.
//
// Every figure here is the same arithmetic as the Compare panel — posts inside
// the window ÷ (window ÷ 7) — over the same per-platform window, so the two
// panels cannot disagree.

import type { CadenceMatrix } from "../api/client";
import { Badge } from "./ui";

/** One cell. An em dash is never a zero, and the two reasons for it differ. */
function Cell({ matrix, platform, row }: { matrix: CadenceMatrix; platform: string; row: CadenceMatrix["rows"][number] }) {
    const cell = row.cells[platform];

    if (cell === undefined) {
        return (
            <td className="n muted" title={`${row.personName} has no tracked ${platform} account under this filter.`}>
                —
            </td>
        );
    }

    if (cell.postsPerWeek === null) {
        // The column was withheld, not this account. Named here rather than left
        // blank so the reader does not read it as "posted nothing".
        const window = matrix.windows[platform];
        return (
            <td
                className="n muted"
                title={
                    `Withheld. ${window?.truncatedAccounts.join(", ")} ` +
                    `${window?.truncatedAccounts.length === 1 ? "has" : "have"} no posts in the earlier part of the ` +
                    `${platform} window, so every account on this platform would be divided by a window its data ` +
                    `does not cover. ${cell.posts} posts were counted.`
                }
            >
                withheld
            </td>
        );
    }

    return (
        <td
            className="n"
            title={
                `@${cell.handle} — ${cell.posts} posts over ${matrix.windows[platform]?.days.toFixed(0)} days` +
                (cell.consistencyPct === null ? "" : `, posting in ${cell.consistencyPct}% of weeks`) +
                "."
            }
        >
            {cell.postsPerWeek.toFixed(1)}
            <span className="muted" style={{ fontSize: 10.5, marginLeft: 3 }}>
                /wk
            </span>
        </td>
    );
}

export function CadenceTable({ matrix }: { matrix: CadenceMatrix }) {
    if (matrix.platforms.length === 0 || matrix.rows.length === 0) {
        return <p className="muted">No posts under the current filter, so there is no posting rate to report.</p>;
    }

    // Stated per column because the columns genuinely differ: the platforms are
    // ingested on different days, so each spans its own number of days. A single
    // "measured over 90 days" line under this table would be wrong for at least
    // two of the three columns.
    const windowNote = matrix.platforms
        .map((platform) => {
            const window = matrix.windows[platform];
            if (window === undefined) return null;
            return window.narrowedFromDays === null
                ? `${platform} ${window.days.toFixed(0)}d`
                : `${platform} ${window.days.toFixed(0)}d (narrowed from ${window.narrowedFromDays.toFixed(0)}, ` +
                  `${window.narrowedBy.join(", ")} had no history before that)`;
        })
        .filter((note) => note !== null)
        .join(" · ");

    return (
        <div>
            <div className="table-scroll">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Person</th>
                            {matrix.platforms.map((platform) => (
                                <th key={platform} className="n">
                                    {platform}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {matrix.rows.map((row) => (
                            <tr key={row.personName}>
                                <td>
                                    <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                                        <span>{row.personName}</span>
                                        {row.role === "PRINCIPAL" && <Badge kind="accent">Principal</Badge>}
                                    </div>
                                </td>
                                {matrix.platforms.map((platform) => (
                                    <Cell key={platform} matrix={matrix} platform={platform} row={row} />
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
                Posts inside each platform's window ÷ that window in weeks, counting every post rather than only the
                rated ones — a post whose metrics the platform withheld still happened. Compare <em>down</em> a column:
                same platform, same window. Comparing <em>across</em> a row is a judgement call, not a measurement —
                each column is measured over its own span, and a tweet is not the same unit of work as a
                twenty-minute upload. Measured over {windowNote}.
            </p>
        </div>
    );
}
