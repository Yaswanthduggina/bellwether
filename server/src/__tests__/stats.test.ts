// Hand-computed fixtures throughout. These five numbers sit underneath every
// format panel, every heatmap cell summary and every comparison in the product,
// so they are checked against arithmetic done on paper rather than against
// whatever the implementation happened to return the first time it ran.

import { describe as describeSuite, expect, it } from "vitest";
import { describe as summarise, mean, median, OUTLIER_RATIO, quantile, stdev } from "../analytics/stats";

describeSuite("mean / median", () => {
    it("computes the mean of a hand-checked set", () => {
        // (2 + 4 + 4 + 4 + 5 + 5 + 7 + 9) / 8 = 40 / 8 = 5
        expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    });

    it("takes the midpoint of the two central values on an even-length set", () => {
        // sorted [1,2,3,4] → (2 + 3) / 2 = 2.5
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    it("takes the central value on an odd-length set", () => {
        expect(median([1, 2, 3, 4, 5])).toBe(3);
    });

    it("returns the single value for a one-element set", () => {
        expect(median([42])).toBe(42);
        expect(mean([42])).toBe(42);
    });
});

describeSuite("quantile — R type-7, by linear interpolation", () => {
    // Nine defensible quantile definitions exist and they disagree on small
    // samples. These fixtures pin the one this codebase uses, so an IQR computed
    // in format.ts and one computed in timing.ts cannot silently differ.
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    it("interpolates between ranks", () => {
        // position = (10 - 1) * 0.25 = 2.25 → 3 + 0.25 * (4 - 3) = 3.25
        expect(quantile(sorted, 0.25)).toBeCloseTo(3.25, 12);
        // position = (10 - 1) * 0.75 = 6.75 → 7 + 0.75 * (8 - 7) = 7.75
        expect(quantile(sorted, 0.75)).toBeCloseTo(7.75, 12);
    });

    it("returns the endpoints at p=0 and p=1", () => {
        expect(quantile(sorted, 0)).toBe(1);
        expect(quantile(sorted, 1)).toBe(10);
    });
});

describeSuite("stdev — sample, Bessel-corrected", () => {
    it("matches a hand-computed sample standard deviation", () => {
        // values [2,4,4,4,5,5,7,9], mean 5
        // squared deviations: 9,1,1,1,0,0,4,16 → sum 32
        // sample variance = 32 / (8 - 1) = 4.571428…  → sd ≈ 2.13809
        expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])!).toBeCloseTo(Math.sqrt(32 / 7), 12);
    });

    it("is null at n < 2, where deviation is undefined", () => {
        // Returning 0 here would claim a certainty one observation cannot support.
        expect(stdev([5])).toBeNull();
        expect(stdev([])).toBeNull();
    });
});

describeSuite("describe — the outlier flag", () => {
    it("does not flag a symmetric distribution", () => {
        const d = summarise([10, 10, 10, 10, 10])!;
        expect(d.mean).toBe(10);
        expect(d.median).toBe(10);
        expect(d.meanMedianRatio).toBe(1);
        expect(d.outlierDriven).toBe(false);
    });

    it("flags one viral post among nine duds", () => {
        // The case the flag exists for: nine posts at 1, one at 100.
        // mean = 109/10 = 10.9, median = 1 → ratio 10.9, far above 1.5
        const d = summarise([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])!;

        expect(d.median).toBe(1);
        expect(d.mean).toBeCloseTo(10.9, 12);
        expect(d.outlierDriven).toBe(true);
        // And the median is dramatically the more honest headline here.
        expect(d.mean / d.median).toBeGreaterThan(OUTLIER_RATIO);
    });

    it("does not flag at exactly the threshold — the rule is strictly greater", () => {
        // median 2, mean 3 → ratio exactly 1.5
        const d = summarise([2, 2, 2, 6])!;
        expect(d.median).toBe(2);
        expect(d.mean).toBe(3);
        expect(d.meanMedianRatio).toBe(OUTLIER_RATIO);
        expect(d.outlierDriven).toBe(false);
    });

    it("does not report Infinity when the median is zero", () => {
        // More than half the posts earning nothing measurable is a finding in
        // itself, but it is not an outlier-driven distribution.
        const d = summarise([0, 0, 0, 5])!;
        expect(d.median).toBe(0);
        expect(Number.isFinite(d.meanMedianRatio)).toBe(false);
        expect(d.outlierDriven).toBe(false);
    });

    it("reports the full five-number summary", () => {
        const d = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
        expect(d.n).toBe(10);
        expect(d.min).toBe(1);
        expect(d.max).toBe(10);
        expect(d.q1).toBeCloseTo(3.25, 12);
        expect(d.q3).toBeCloseTo(7.75, 12);
        expect(d.iqr).toBeCloseTo(4.5, 12);
    });

    it("returns null for an empty set rather than a NaN-filled object", () => {
        expect(summarise([])).toBeNull();
    });
});
