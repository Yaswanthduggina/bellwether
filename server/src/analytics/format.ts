// "What content works?" — question 1 of the four the product answers.
//
// Performance by media format, on the normalised rate, WITH spread. The spread
// is not decoration: a format with one viral post and nine duds has a flattering
// mean, and a comms team that reallocates its week on that mean will be worse
// off. So every format reports mean, median, stdev, IQR and n, and the module
// nominates which of mean/median is the honest headline for each one.
//
// Two rules are enforced here rather than left to the UI:
//
//   - A format with fewer than MIN_FORMAT_N posts is not reported as a statistic.
//     It goes in `insufficient` with its count and is excluded from ranking and
//     from anything the AI layer is allowed to cite.
//   - Every format in one analysis shares one engagement basis. Mixed input
//     throws (see engagement.ts) rather than averaging incommensurable rates.

import {
    assertSingleBasis,
    partitionByBasis,
    type EngagementBasis,
    type EngagementPost,
    type MediaType,
    type RatedPost,
} from "./engagement";
import { describe as describeDistribution, type Distribution } from "./stats";

/**
 * Below five posts, a format's average is an anecdote.
 *
 * Enforced in the computation, not in the styling: a greyed-out number is still
 * a number, and a number on screen gets acted on regardless of its opacity. The
 * recommendation validator applies the same threshold, so an insufficient format
 * cannot reach a user through the AI layer either.
 */
export const MIN_FORMAT_N = 5;

export interface FormatStat {
    mediaType: MediaType;
    distribution: Distribution;
    /**
     * The figure to quote for this format — the median where the distribution is
     * outlier-driven, the mean otherwise. Computed here so that the UI, the
     * Markdown export and the AI prompt cannot each pick a different one.
     */
    headline: number;
    headlineStat: "MEAN" | "MEDIAN";
    /**
     * This format's median rate as a multiple of the account's overall median.
     * The product's quality bar requires every recommendation to carry a multiple
     * AND the baseline it is measured against — this is that multiple, and
     * `FormatAnalysis.overall` is that baseline.
     */
    multipleOfOverall: number;
}

export interface InsufficientFormat {
    mediaType: MediaType;
    n: number;
}

export interface FormatAnalysis {
    basis: EngagementBasis;
    /** Formats meeting MIN_FORMAT_N, ranked best first. */
    formats: FormatStat[];
    /** Formats seen but not reported, with the count that disqualified them. */
    insufficient: InsufficientFormat[];
    /** The distribution across every rated post, whatever its format. The baseline. */
    overall: Distribution;
    /** Posts that fed this analysis. The denominator behind every `n` above. */
    ratedPosts: number;
}

/**
 * Rank by MEDIAN, not by mean.
 *
 * Ranking on the mean would put a format with one freak post above a format that
 * reliably performs, which is precisely the mistake the spread reporting exists
 * to prevent. Ranking on the median asks "what does a typical post in this
 * format do", which is the question a content plan actually needs answered.
 */
function byMedianDescending(a: FormatStat, b: FormatStat): number {
    return b.distribution.median - a.distribution.median;
}

/**
 * Format statistics for one already-rated, single-basis corpus.
 *
 * `context` is only used to name the call site if the basis guard trips — it is
 * worth passing something specific ("formats: Tharoor / Instagram") because the
 * error is otherwise hard to trace back through the aggregation.
 */
export function analyseFormats<T extends EngagementPost>(
    rated: readonly RatedPost<T>[],
    context = "format analysis",
): FormatAnalysis | null {
    const basis = assertSingleBasis(
        rated.map((r) => r.engagement),
        context,
    );
    if (basis === null) return null; // no rated posts — the caller's "no data" case

    const overall = describeDistribution(rated.map((r) => r.engagement.rate));
    if (overall === null) return null;

    const byFormat = new Map<MediaType, number[]>();
    for (const { post, engagement } of rated) {
        const bucket = byFormat.get(post.mediaType);
        if (bucket) bucket.push(engagement.rate);
        else byFormat.set(post.mediaType, [engagement.rate]);
    }

    const formats: FormatStat[] = [];
    const insufficient: InsufficientFormat[] = [];

    for (const [mediaType, rates] of byFormat) {
        if (rates.length < MIN_FORMAT_N) {
            insufficient.push({ mediaType, n: rates.length });
            continue;
        }

        const distribution = describeDistribution(rates)!; // non-empty by construction

        formats.push({
            mediaType,
            distribution,
            headline: distribution.outlierDriven ? distribution.median : distribution.mean,
            headlineStat: distribution.outlierDriven ? "MEDIAN" : "MEAN",
            // Guarded because an overall median of 0 is possible on a corpus where
            // most posts earned nothing measurable. A multiple against a zero
            // baseline is meaningless, so it reports as 0 rather than Infinity.
            multipleOfOverall: overall.median === 0 ? 0 : distribution.median / overall.median,
        });
    }

    formats.sort(byMedianDescending);
    insufficient.sort((a, b) => b.n - a.n);

    return { basis, formats, insufficient, overall, ratedPosts: rated.length };
}

/**
 * The correct entry point for a corpus that spans platforms.
 *
 * A YouTube-and-Instagram set legitimately contains both bases, and forcing it
 * through `analyseFormats` would throw. This splits it into the two panels the
 * dashboard renders side by side — never one blended average. Either side may be
 * null, which simply means no post in the corpus used that denominator.
 */
export function analyseFormatsByBasis<T extends EngagementPost>(
    rated: readonly RatedPost<T>[],
    context = "format analysis",
): Record<EngagementBasis, FormatAnalysis | null> {
    const split = partitionByBasis(rated);
    return {
        VIEWS: analyseFormats(split.VIEWS, `${context} [VIEWS]`),
        FOLLOWERS: analyseFormats(split.FOLLOWERS, `${context} [FOLLOWERS]`),
    };
}

/**
 * The gap between the best and worst reportable format, as a multiple.
 *
 * Returned as null rather than 1 when there is nothing to compare, so a caller
 * cannot mistake "only one format qualified" for "all formats perform equally".
 */
export function formatSpread(analysis: FormatAnalysis): { best: FormatStat; worst: FormatStat; multiple: number } | null {
    if (analysis.formats.length < 2) return null;

    const best = analysis.formats[0];
    const worst = analysis.formats[analysis.formats.length - 1];
    if (worst.distribution.median === 0) return null;

    return { best, worst, multiple: best.distribution.median / worst.distribution.median };
}
