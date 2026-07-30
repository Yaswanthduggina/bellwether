// "When should we post?" — question 2 of the four.
//
// Posts are stored as UTC instants; audiences live in local time. The whole job
// of this module is that conversion plus honest sample-size handling.
//
// THE THING TO UNDERSTAND BEFORE READING THE REST
//
// A 7×24 grid has 168 cells. Ninety days of posting at a fairly heavy cadence is
// under a hundred posts. So the *typical* cell holds zero or one post, and a
// full-grid heatmap of a real account is mostly empty — that is arithmetic, not
// a bug, and no amount of visual polish fixes it.
//
// The product therefore computes three views, and is explicit about which one
// is safe to draw a conclusion from:
//
//   grid     — 7×24, cells below MIN_CELL_N suppressed. Good for shape and for
//              showing where an account actually posts. Rarely citable.
//   byHour   — 24 buckets, collapsing day. ~4× the sample per bucket.
//   byDay    — 7 buckets, collapsing hour. ~24× the sample per bucket.
//
// Recommendations cite the marginals. The grid is a picture. Presenting a
// one-post cell as "Tuesday 8pm is your best slot" is exactly the confident
// claim from six data points the brief warns against — so the suppression is
// enforced here, in the computation, rather than in the CSS.

import {
    assertSingleBasis,
    partitionByBasis,
    type EngagementBasis,
    type EngagementPost,
    type RatedPost,
} from "./engagement";
import { describe as describeDistribution, type Distribution } from "./stats";

/** Below this, a cell is not rendered at all. Three posts is not a pattern. */
export const MIN_CELL_N = 3;

/** Below this, a cell renders muted and is flagged. At or above it, it is quotable. */
export const LOW_CONFIDENCE_N = 5;

export type CellConfidence = "OK" | "LOW";

export interface TimingPost extends EngagementPost {
    /** The UTC instant. Conversion to local time happens here, never at write time. */
    postedAt: Date;
}

/** 0 = Sunday, matching JavaScript's getDay() so the UI can use its own labels. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimingBucket {
    n: number;
    distribution: Distribution;
    confidence: CellConfidence;
    /** Median where the distribution is outlier-driven, mean otherwise. */
    headline: number;
    /** This bucket's median as a multiple of the account's overall median. */
    multipleOfOverall: number;
}

export interface GridCell extends TimingBucket {
    dayOfWeek: DayOfWeek;
    /** Local hour, 0–23, in the account's timezone. */
    hour: number;
}

export interface HourBucket extends TimingBucket {
    hour: number;
}

export interface DayBucket extends TimingBucket {
    dayOfWeek: DayOfWeek;
}

export interface TimingAnalysis {
    basis: EngagementBasis;
    /** The IANA zone every hour and day in this result is expressed in. */
    timezone: string;
    /** Cells meeting MIN_CELL_N, best first. */
    grid: GridCell[];
    /** Hour-of-day marginal. Collapses day; ~4× the sample of a grid cell. */
    byHour: HourBucket[];
    /** Day-of-week marginal. Collapses hour; ~24× the sample of a grid cell. */
    byDay: DayBucket[];
    overall: Distribution;
    ratedPosts: number;
    /**
     * What the grid does not show. Reported rather than dropped, because a
     * heatmap with two visible cells out of 168 is telling the reader something
     * about their posting spread, and silently omitting the rest hides it.
     */
    suppressedCells: number;
    suppressedPosts: number;
}

// ── UTC → local ──────────────────────────────────────────────────────────

/**
 * Intl formatters are expensive to construct and this runs once per post, so
 * they are built once per zone and reused. Correctness note: `Intl` applies the
 * zone's real DST rules, so this is a genuine conversion and not a fixed offset
 * — which matters the moment anyone tracks an account outside India, and is
 * tested against a DST-observing zone for that reason.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

const WEEKDAY_INDEX: Record<string, DayOfWeek> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

function formatterFor(timezone: string): Intl.DateTimeFormat {
    const cached = formatterCache.get(timezone);
    if (cached) return cached;

    let formatter: Intl.DateTimeFormat;
    try {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            weekday: "short",
            hour: "2-digit",
            // h23 explicitly: the default hour cycle renders midnight as "24" in
            // some locales, which would put every midnight post in a 25th column.
            hourCycle: "h23",
        });
    } catch {
        throw new Error(
            `Unknown timezone "${timezone}". Account.timezone must be an IANA zone name such as "Asia/Kolkata".`,
        );
    }

    formatterCache.set(timezone, formatter);
    return formatter;
}

/**
 * The local weekday and hour of a UTC instant.
 *
 * Exported because it is the single most error-prone line in the analytics
 * layer and deserves to be tested directly rather than only through a heatmap.
 */
export function localSlot(instant: Date, timezone: string): { dayOfWeek: DayOfWeek; hour: number } {
    const parts = formatterFor(timezone).formatToParts(instant);

    let weekday: string | undefined;
    let hour: string | undefined;
    for (const part of parts) {
        if (part.type === "weekday") weekday = part.value;
        else if (part.type === "hour") hour = part.value;
    }

    const dayOfWeek = weekday === undefined ? undefined : WEEKDAY_INDEX[weekday];
    if (dayOfWeek === undefined || hour === undefined) {
        throw new Error(`Could not read a local weekday and hour for ${instant.toISOString()} in ${timezone}`);
    }

    return { dayOfWeek, hour: Number(hour) % 24 };
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The local calendar date of a UTC instant, as `YYYY-MM-DD`.
 *
 * Needed wherever "the same day" is the question rather than "the same hour" —
 * cadence's burst detection, for one. A UTC-aligned day bucket gets this wrong
 * in both directions in IST: 23:00 and 01:00 local fall on one UTC day and two
 * local days, and the account posted on two days.
 */
export function localDateKey(instant: Date, timezone: string): string {
    let formatter = dateFormatterCache.get(timezone);
    if (formatter === undefined) {
        try {
            formatter = new Intl.DateTimeFormat("en-CA", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            });
        } catch {
            throw new Error(
                `Unknown timezone "${timezone}". Account.timezone must be an IANA zone name such as "Asia/Kolkata".`,
            );
        }
        dateFormatterCache.set(timezone, formatter);
    }

    // en-CA renders as YYYY-MM-DD, which sorts lexicographically as it sorts
    // chronologically — worth having even though this is only used as a key.
    return formatter.format(instant);
}

// ── Bucketing ────────────────────────────────────────────────────────────

function toBucket(rates: number[], overallMedian: number): TimingBucket | null {
    const distribution = describeDistribution(rates);
    if (distribution === null) return null;

    return {
        n: distribution.n,
        distribution,
        confidence: distribution.n < LOW_CONFIDENCE_N ? "LOW" : "OK",
        headline: distribution.outlierDriven ? distribution.median : distribution.mean,
        multipleOfOverall: overallMedian === 0 ? 0 : distribution.median / overallMedian,
    };
}

function byHeadlineDescending(a: TimingBucket, b: TimingBucket): number {
    return b.distribution.median - a.distribution.median;
}

/**
 * Build the three timing views for one already-rated, single-basis corpus.
 *
 * `timezone` comes from `Account.timezone` — it is a property of the account,
 * not of the post, which is why posts are stored as instants and converted here.
 */
export function analyseTiming<T extends TimingPost>(
    rated: readonly RatedPost<T>[],
    timezone: string,
    context = "timing analysis",
): TimingAnalysis | null {
    const basis = assertSingleBasis(
        rated.map((r) => r.engagement),
        context,
    );
    if (basis === null) return null;

    const overall = describeDistribution(rated.map((r) => r.engagement.rate));
    if (overall === null) return null;

    const cellRates = new Map<string, number[]>();
    const hourRates = new Map<number, number[]>();
    const dayRates = new Map<DayOfWeek, number[]>();

    for (const { post, engagement } of rated) {
        const { dayOfWeek, hour } = localSlot(post.postedAt, timezone);

        const cellKey = `${dayOfWeek}:${hour}`;
        const cell = cellRates.get(cellKey);
        if (cell) cell.push(engagement.rate);
        else cellRates.set(cellKey, [engagement.rate]);

        const byHour = hourRates.get(hour);
        if (byHour) byHour.push(engagement.rate);
        else hourRates.set(hour, [engagement.rate]);

        const byDay = dayRates.get(dayOfWeek);
        if (byDay) byDay.push(engagement.rate);
        else dayRates.set(dayOfWeek, [engagement.rate]);
    }

    const grid: GridCell[] = [];
    let suppressedCells = 0;
    let suppressedPosts = 0;

    for (const [key, rates] of cellRates) {
        if (rates.length < MIN_CELL_N) {
            suppressedCells += 1;
            suppressedPosts += rates.length;
            continue;
        }

        const [day, hour] = key.split(":").map(Number);
        grid.push({ ...toBucket(rates, overall.median)!, dayOfWeek: day as DayOfWeek, hour });
    }

    // The marginals carry the same suppression rule. An hour the account has
    // posted at twice is no more quotable than a cell it has posted in twice.
    const byHour: HourBucket[] = [];
    for (const [hour, rates] of hourRates) {
        if (rates.length < MIN_CELL_N) continue;
        byHour.push({ ...toBucket(rates, overall.median)!, hour });
    }

    const byDay: DayBucket[] = [];
    for (const [dayOfWeek, rates] of dayRates) {
        if (rates.length < MIN_CELL_N) continue;
        byDay.push({ ...toBucket(rates, overall.median)!, dayOfWeek });
    }

    grid.sort(byHeadlineDescending);
    byHour.sort(byHeadlineDescending);
    byDay.sort(byHeadlineDescending);

    return {
        basis,
        timezone,
        grid,
        byHour,
        byDay,
        overall,
        ratedPosts: rated.length,
        suppressedCells,
        suppressedPosts,
    };
}

/**
 * The same corpus split into one analysis per basis.
 *
 * Needed for the same reason as the format equivalent: an Instagram corpus rates
 * reels against views and carousels against followers, so a single timing
 * analysis over both would throw.
 */
export function analyseTimingByBasis<T extends TimingPost>(
    rated: readonly RatedPost<T>[],
    timezone: string,
    context = "timing analysis",
): Record<EngagementBasis, TimingAnalysis | null> {
    const split = partitionByBasis(rated);
    return {
        VIEWS: analyseTiming(split.VIEWS, timezone, `${context} [VIEWS]`),
        FOLLOWERS: analyseTiming(split.FOLLOWERS, timezone, `${context} [FOLLOWERS]`),
    };
}

/**
 * The top `count` hour buckets that are actually quotable.
 *
 * LOW-confidence buckets are excluded rather than merely flagged: this feeds the
 * recommendation layer, and a recommendation is the one place a thin sample does
 * real damage. The grid and the full marginals still expose them for display.
 */
export function bestHours(analysis: TimingAnalysis, count = 3): HourBucket[] {
    return analysis.byHour.filter((bucket) => bucket.confidence === "OK").slice(0, count);
}

/** As `bestHours`, from the other end. Useful for "stop posting at" advice. */
export function worstHours(analysis: TimingAnalysis, count = 3): HourBucket[] {
    return analysis.byHour
        .filter((bucket) => bucket.confidence === "OK")
        .slice(-count)
        .reverse();
}

/**
 * Every local hour an account has ANY post in, suppression ignored.
 *
 * Distinct from `analysis.byHour`, and the distinction is load-bearing. `byHour`
 * drops buckets below MIN_CELL_N because three posts are not a pattern — correct
 * for "how does this hour PERFORM", wrong for "does this account POST here".
 * Reading presence off the suppressed marginal reports an hour with two posts in
 * it as one the account has never used, and a recommendation to "start posting
 * at 10:00" then goes to someone who already does.
 */
export function occupiedHours<T extends TimingPost>(
    rated: readonly RatedPost<T>[],
    timezone: string,
): number[] {
    const hours = new Set<number>();
    for (const { post } of rated) hours.add(localSlot(post.postedAt, timezone).hour);
    return [...hours].sort((a, b) => a - b);
}

// ── Contiguous hour runs ─────────────────────────────────────────────────

export interface HourRun<T> {
    /** Local hour the run opens, inclusive. */
    startHour: number;
    /** Local hour the run closes, inclusive — 19 and 21 means 19:00–21:59. */
    endHour: number;
    label: string;
    items: T[];
}

export function formatHour(hour: number): string {
    return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Collapse items on adjacent hours into runs.
 *
 * A comms manager schedules a WINDOW, not an hour. "Post between 19:00 and
 * 21:00" is one instruction; "post at 19:00, and also at 20:00, and also at
 * 21:00" is three instructions that say the same thing — and, worse, three
 * findings that read as three independent pieces of evidence when they are one.
 *
 * Wrap-around is deliberately not merged: 23:00 and 00:00 are adjacent on a
 * clock but a window crossing midnight is a different scheduling instruction,
 * and nothing in a 90-day corpus justifies inferring it.
 *
 * Generic because both the gap analysis and the comparison view need exactly
 * this, and two copies would be two chances to disagree about the boundary.
 */
export function groupContiguousHours<T>(items: readonly T[], hourOf: (item: T) => number): HourRun<T>[] {
    const sorted = [...items].sort((a, b) => hourOf(a) - hourOf(b));

    const runs: HourRun<T>[] = [];
    let current: T[] = [];

    const flush = () => {
        if (current.length === 0) return;
        const startHour = hourOf(current[0]);
        const endHour = hourOf(current[current.length - 1]);
        runs.push({
            startHour,
            endHour,
            label: startHour === endHour ? formatHour(startHour) : `${formatHour(startHour)}–${formatHour(endHour).replace(":00", ":59")}`,
            items: [...current],
        });
        current = [];
    };

    for (const item of sorted) {
        if (current.length > 0 && hourOf(item) !== hourOf(current[current.length - 1]) + 1) flush();
        current.push(item);
    }
    flush();

    return runs;
}
