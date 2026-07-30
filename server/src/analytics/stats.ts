// Descriptive statistics, in one place.
//
// This file is not in the original architecture sketch. It exists because
// format.ts, timing.ts and compare.ts all need the same five numbers, and three
// private copies of a quartile implementation is three chances to compute
// quartiles three different ways — which would make two panels of the same
// dashboard quietly disagree.
//
// Everything here is pure, total, and defined for the degenerate inputs. A
// statistics helper that throws on an empty array pushes the empty case into
// every caller, and one of them always forgets.

/**
 * The distribution of a set of values.
 *
 * `mean` alone is not enough and the product never shows it alone: a format with
 * one viral post and nine duds has a flattering mean and a truthful median, and
 * the brief is explicit that spread must be reported. Hence median, stdev and
 * the interquartile range alongside it.
 */
export interface Distribution {
    n: number;
    mean: number;
    median: number;
    /** Sample standard deviation (n−1). Null below n=2, where it is undefined. */
    stdev: number | null;
    q1: number;
    q3: number;
    /** q3 − q1. The middle half's width — robust to the outliers stdev is not. */
    iqr: number;
    min: number;
    max: number;
    /**
     * mean / median. Above OUTLIER_RATIO the distribution is being pulled by a
     * small number of large values, and the median is the number to quote.
     */
    meanMedianRatio: number;
    outlierDriven: boolean;
}

/**
 * Where a distribution stops describing "typical" and starts describing "one
 * post got lucky". A mean 50% above the median means the tail is doing the
 * talking — at that point the product leads with the median and flags the
 * distribution, rather than reporting an average nobody's next post will hit.
 */
export const OUTLIER_RATIO = 1.5;

/**
 * Quantile by linear interpolation between the two closest ranks — the R type-7
 * definition, which is what NumPy, pandas and Excel's PERCENTILE all default to.
 *
 * Named explicitly because there are nine defensible quantile definitions and
 * they disagree on small samples. Picking one and writing it down is the
 * difference between a reproducible IQR and a number that depends on which
 * library happened to compute it.
 *
 * Expects `sorted` to be ascending; callers sort once and reuse.
 */
export function quantile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) return Number.NaN;
    if (sorted.length === 1) return sorted[0];

    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) return sorted[lower];

    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function median(sorted: readonly number[]): number {
    return quantile(sorted, 0.5);
}

export function mean(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
}

/**
 * Sample standard deviation (Bessel-corrected, n−1).
 *
 * Sample rather than population because 90 days of posts is a sample of how an
 * account behaves, not the complete population of everything it will ever post
 * — and the spread figure is being used to say something about the account, not
 * only about these rows.
 *
 * Null at n < 2: with one observation there is no deviation to measure, and
 * returning 0 would claim a certainty the data does not support.
 */
export function stdev(values: readonly number[]): number | null {
    if (values.length < 2) return null;

    const m = mean(values);
    let sumSquares = 0;
    for (const value of values) sumSquares += (value - m) ** 2;

    return Math.sqrt(sumSquares / (values.length - 1));
}

/** The full five-number summary plus the outlier flag. Empty input returns null. */
export function describe(values: readonly number[]): Distribution | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const m = mean(sorted);
    const med = median(sorted);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);

    // A median of 0 makes the ratio undefined. That happens when more than half
    // the posts earned nothing measurable, which is itself a finding — but it is
    // not an outlier-driven distribution, so the flag stays off rather than
    // reporting Infinity.
    const meanMedianRatio = med === 0 ? (m === 0 ? 1 : Number.POSITIVE_INFINITY) : m / med;

    return {
        n: sorted.length,
        mean: m,
        median: med,
        stdev: stdev(sorted),
        q1,
        q3,
        iqr: q3 - q1,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        meanMedianRatio,
        outlierDriven: Number.isFinite(meanMedianRatio) && meanMedianRatio > OUTLIER_RATIO,
    };
}
