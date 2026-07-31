// The small shared pieces. Everything here is presentational.
//
// SeededBadge is the only one that carries a requirement rather than a style.
// Every analytics endpoint returns provenance per ACCOUNT — YouTube is mixed,
// three tracked people have a live channel and the fourth does not — so a
// platform-level rollup would report YouTube as "real" while a quarter of its
// rows are generated. The badge therefore renders from the per-account
// provenance the API sends and is never inferred in the UI.

import type { ReactNode } from "react";
import type { Provenance } from "../api/client";

export function Panel({
    title,
    eyebrow,
    sub,
    right,
    lead,
    children,
}: {
    title: string;
    eyebrow?: string;
    sub?: ReactNode;
    right?: ReactNode;
    lead?: boolean;
    children: ReactNode;
}) {
    return (
        <section className={lead ? "panel lead" : "panel"}>
            {eyebrow !== undefined && <div className="eyebrow">{eyebrow}</div>}
            <div className="panel-head">
                <h2>{title}</h2>
                <div className="spacer" style={{ flex: 1 }} />
                {right}
            </div>
            {sub !== undefined && <p className="panel-sub">{sub}</p>}
            {children}
        </section>
    );
}

/**
 * FR — synthetic data must be visible wherever it contributes to a number.
 *
 * Rendered from the API's own provenance field. MIXED is its own state and not
 * rounded to either side: "some of the accounts behind this figure are
 * generated" is a different warning from "all of them are", and a reader
 * deciding whether to act on a finding needs to know which.
 */
export function SeededBadge({ provenance, accounts }: { provenance: Provenance; accounts?: string[] }) {
    const title =
        accounts && accounts.length > 0
            ? `Generated data for: ${accounts.join(", ")}. Any finding resting on it demonstrates the pipeline, not the real world.`
            : undefined;

    if (provenance === "LIVE") {
        return (
            <span className="badge badge-live" title="Every account behind these figures was fetched from a live API.">
                Live
            </span>
        );
    }

    if (provenance === "SEEDED") {
        return (
            <span className="badge badge-seeded" title={title}>
                Seeded
            </span>
        );
    }

    return (
        <span className="badge badge-mixed" title={title}>
            Mixed · {accounts?.length ?? 0} seeded
        </span>
    );
}

export function Badge({ kind = "neutral", children, title }: { kind?: string; children: ReactNode; title?: string }) {
    return (
        <span className={`badge badge-${kind}`} title={title}>
            {children}
        </span>
    );
}

export function Chip({ label, value, title }: { label: string; value?: ReactNode; title?: string }) {
    return (
        <span className="chip" title={title}>
            {label}
            {value !== undefined && <strong>{value}</strong>}
        </span>
    );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "bad" | "plain"; children: ReactNode }) {
    return <div className={kind === "plain" ? "notice" : `notice ${kind}`}>{children}</div>;
}

export function Loading({ lines = 3 }: { lines?: number }) {
    return (
        <div aria-live="polite" aria-busy="true">
            {Array.from({ length: lines }, (_, index) => (
                <div key={index} className="skeleton" style={{ width: `${100 - index * 12}%` }} />
            ))}
        </div>
    );
}

/**
 * What could not be computed, and why.
 *
 * Always rendered when present. An empty panel is ambiguous between "there is
 * nothing here" and "this could not be calculated", and those mean opposite
 * things to someone deciding what to post.
 */
export function Notes({ notes }: { notes: readonly string[] }) {
    if (notes.length === 0) return null;
    return (
        <ul className="notes-list">
            {notes.map((note) => (
                <li key={note}>{note}</li>
            ))}
        </ul>
    );
}

/** A media type or theme enum, made readable without losing its identity. */
export function humanise(token: string): string {
    return token
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A multiple, always with its × so it can never be misread as a rate. */
export function Multiple({ value }: { value: number | null }) {
    if (value === null) return <span className="muted">—</span>;
    return <span className="num">{value.toFixed(2)}×</span>;
}
