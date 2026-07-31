// FR16 — the filter block, applied to every panel on the page at once.
//
// Held as DRAFT state and committed on Apply rather than firing on every
// keystroke. Two reasons: the recommendations panel costs a model call, so
// refetching per character would be expensive and slow; and a half-typed date
// is a 400 from the server, which would flash an error under the user's cursor
// while they are still typing it.

import { useState } from "react";
import type { Filter } from "../api/client";
import { humanise } from "./ui";

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"];

const MEDIA_TYPES = [
    "REEL_SHORT_VIDEO",
    "LONG_FORM_VIDEO",
    "CAROUSEL",
    "SINGLE_IMAGE",
    "TEXT_ONLY",
    "LINK",
    "LIVE",
];

const THEMES = [
    "POLICY_ANNOUNCEMENT",
    "CONSTITUENCY_VISIT",
    "PERSONAL_FAMILY",
    "ATTACK_REBUTTAL",
    "FESTIVAL_GREETING",
    "ACHIEVEMENT_CLAIM",
    "MEDIA_APPEARANCE",
    "OTHER",
];

function Select({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string | undefined;
    options: string[];
    onChange: (value: string | undefined) => void;
}) {
    return (
        <div className="field">
            <label htmlFor={`filter-${label}`}>{label}</label>
            <select
                id={`filter-${label}`}
                value={value ?? ""}
                onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
            >
                <option value="">All</option>
                {options.map((option) => (
                    <option key={option} value={option}>
                        {humanise(option)}
                    </option>
                ))}
            </select>
        </div>
    );
}

export function Filters({ value, onApply }: { value: Filter; onApply: (filter: Filter) => void }) {
    const [draft, setDraft] = useState<Filter>(value);

    const set = <K extends keyof Filter>(key: K, next: Filter[K]) =>
        setDraft((current) => ({ ...current, [key]: next }));

    const dirty = JSON.stringify(draft) !== JSON.stringify(value);

    return (
        <form
            className="filters"
            onSubmit={(event) => {
                event.preventDefault();
                onApply(draft);
            }}
        >
            <Select
                label="Platform"
                value={draft.platform}
                options={PLATFORMS}
                onChange={(next) => set("platform", next)}
            />
            <Select
                label="Format"
                value={draft.mediaType}
                options={MEDIA_TYPES}
                onChange={(next) => set("mediaType", next)}
            />
            <Select label="Theme" value={draft.theme} options={THEMES} onChange={(next) => set("theme", next)} />

            <div className="field">
                <label htmlFor="filter-from">From</label>
                <input
                    id="filter-from"
                    type="date"
                    value={draft.from ?? ""}
                    onChange={(event) => set("from", event.target.value === "" ? undefined : event.target.value)}
                />
            </div>

            <div className="field">
                <label htmlFor="filter-to">To</label>
                <input
                    id="filter-to"
                    type="date"
                    value={draft.to ?? ""}
                    onChange={(event) => set("to", event.target.value === "" ? undefined : event.target.value)}
                />
            </div>

            <div className="field check">
                <input
                    id="filter-live"
                    type="checkbox"
                    checked={draft.liveOnly ?? false}
                    onChange={(event) => set("liveOnly", event.target.checked || undefined)}
                />
                <label htmlFor="filter-live">Live data only</label>
            </div>

            <button className="button" type="submit" disabled={!dirty}>
                Apply
            </button>
            <button
                className="button ghost"
                type="button"
                onClick={() => {
                    setDraft({});
                    onApply({});
                }}
            >
                Reset
            </button>
        </form>
    );
}
