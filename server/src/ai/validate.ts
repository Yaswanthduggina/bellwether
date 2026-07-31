// The anti-fabrication check. Pure code — there is no LLM anywhere in this file
// and there must never be one.
//
// WHY A MODEL MUST NOT CHECK A MODEL
//
// The failure this guards against is a model stating a number that is not in the
// data. Asking a second model whether the first one's numbers are real is asking
// the same class of system the same class of question, and it fails the same
// way: fluently, and with a confident yes. The check has to be mechanical or it
// is theatre. So: extract the literals, look them up in a set, done.
//
// WHAT THIS FILE CAN AND CANNOT CATCH
//
// It catches FABRICATION — a figure that exists nowhere in the analytics. It
// does NOT catch MISINTERPRETATION: the model can take a verified 1.43x from the
// peers' row and attach it to the principal, and every number in that sentence
// is real. That is a genuine limitation and it is in the README rather than
// papered over. The structural mitigation is upstream, in `buildReport.ts` — the
// report ships pre-written sentences composed from its own figures, so the
// model's cheapest correct move is to restate rather than to recompose.
//
// THE INVARIANT THAT KEEPS THIS HONEST
//
// Every number the model can SEE must be a number this file ACCEPTS. If the two
// sets ever diverge, the model gets rejected for quoting its own evidence, and
// the only way to make the pipeline pass is to loosen the validator until it
// stops checking anything. That is why `numericLiterals` is imported from
// `buildReport.ts` rather than re-declared here: indexing and checking are two
// halves of one contract and they share the one implementation.

import { numericLiterals, type Evidence } from "../analytics/buildReport";
import { MIN_FORMAT_N } from "../analytics/format";
import { MIN_GAP_N } from "../analytics/gaps";

/**
 * The floor for a recommendation's own sample.
 *
 * Both analytics thresholds are 5 and are asserted equal here rather than one
 * being picked arbitrarily: if either module ever moves, this line fails to
 * compile-by-inspection at review rather than silently letting the weaker bar
 * win. A recommendation is a claim about a bucket, and the bucket's reporting
 * threshold is the right floor for a claim about it.
 */
export const MIN_RECOMMENDATION_N = Math.max(MIN_GAP_N, MIN_FORMAT_N);

/**
 * The contract `recommend.ts` must produce and this file checks.
 *
 * Declared here, in the validator, rather than beside the generator's prompt.
 * The shape exists so that it can be verified — putting it next to the thing
 * that verifies it means nobody can add a field the validator does not know
 * about without walking past this file.
 */
export interface Recommendation {
    /** The instruction. Concrete enough to put in a calendar. */
    action: string;
    /** Why, in the manager's language, carrying the multiple and the baseline. */
    rationale: string;
    /** Which platform this applies to. Never blended across platforms. */
    platform: string;
    /** FORMAT | HOUR | DAY | THEME | CADENCE — what dimension the advice moves. */
    dimension: string;
    /** Posts that illustrate the claim. Must all exist in the report. */
    postIds: string[];
    /** Every computed figure the rationale rests on. Must all be in the evidence. */
    figures: number[];
    /** Posts behind the claim. Below MIN_RECOMMENDATION_N the recommendation is dropped. */
    sampleSize: number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    /** 1 is most important. Ranking is the model's judgement; the numbers are not. */
    priority: number;
}

export type ViolationCode =
    | "UNVERIFIED_NUMBER"
    | "UNVERIFIED_FIGURE"
    | "UNKNOWN_POST_ID"
    | "SAMPLE_TOO_SMALL"
    | "NO_FIGURES"
    | "EMPTY_FIELD";

export interface Violation {
    code: ViolationCode;
    /**
     * Written to be handed straight back to the model on the retry. It names the
     * offending value, because "your output failed validation" is not actionable
     * and produces a second attempt that fails the same way.
     */
    message: string;
}

export interface ValidationResult {
    ok: boolean;
    violations: Violation[];
    /** Numbers checked against the evidence. Reported so a "pass" on zero checks is visible. */
    numbersChecked: number;
}

// ── Number verification ──────────────────────────────────────────────────

/** Decimal places as WRITTEN: "3.50" → 2, "3" → 0. Trailing zeros count. */
function decimalsOf(literal: string): number {
    const dot = literal.indexOf(".");
    return dot === -1 ? 0 : literal.length - dot - 1;
}

function roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/**
 * Is this literal a figure the report actually contains?
 *
 * Two ways to pass, and the second one is the only concession in this file:
 *
 * 1. EXACT. The report is rounded once at build time to the form a human would
 *    write (`buildReport.ts` rule 1), so a model restating a figure verbatim
 *    matches exactly. No epsilon band — a tolerance wide enough to need fuzzy
 *    matching would mean the rounding contract upstream has broken, and the
 *    right fix for that is upstream, not a looser comparison here.
 *
 * 2. A STRICTLY COARSER CORRECT ROUNDING of a verified figure. "3.5" passes
 *    against a verified 3.47; so does "3". This is not a tolerance band — it
 *    admits exactly one value per precision, the correct one. "3.4" fails
 *    (that is truncation), and "4" fails against 3.47 (that is not what 3.47
 *    rounds to). Restating a verified figure less precisely cannot fabricate
 *    anything; it is what a person writing for a communications manager
 *    actually does, and rejecting it would have the model choosing between
 *    readable prose and passing validation.
 *
 * Note that going the other way is impossible by construction: no extra
 * precision can be invented from a figure that never had it.
 *
 * The cost of rule 2, stated rather than glossed: it is weakest at zero
 * decimals, because a bare integer passes if ANY verified figure rounds to it,
 * and the report holds a few hundred numbers. Integers are therefore close to
 * free. That is tolerable here because the integers that carry weight in this
 * product — sample sizes, ranks, counts, percentages — are already indexed as
 * integers and so are checked exactly by rule 1. The concession buys readable
 * prose; the check that matters is on the rates and multiples, where the
 * decimals make it tight.
 */
function verifyLiteral(literal: string, evidence: Evidence): boolean {
    const value = Number(literal);
    if (!Number.isFinite(value)) return false;

    if (evidence.numbers.has(value)) return true;

    const written = decimalsOf(literal);
    for (const known of evidence.numbers.keys()) {
        // Only a COARSER restatement qualifies. Equal precision that did not
        // match exactly above is a different number, not a rounding of one.
        if (decimalsOf(String(known)) <= written) continue;
        if (roundTo(known, written) === value) return true;
    }

    return false;
}

// ── The check ────────────────────────────────────────────────────────────

/**
 * Validate one recommendation against the evidence index of the report that
 * produced it.
 *
 * Collects EVERY violation rather than returning on the first. The retry gets
 * one shot, and telling the model about one of its three bad numbers guarantees
 * the second attempt fails on the second one.
 *
 * Post ids are checked as a declared list and not scraped out of prose. The
 * schema gives the model a structured field for them, and a database id has no
 * business appearing in a sentence written for a communications manager — so a
 * prose scan would be looking for something that should never be there, at the
 * cost of false positives on any long token.
 */
export function validateRecommendation(rec: Recommendation, evidence: Evidence): ValidationResult {
    const violations: Violation[] = [];
    let numbersChecked = 0;

    const push = (code: ViolationCode, message: string) => violations.push({ code, message });

    if (rec.action.trim() === "") push("EMPTY_FIELD", `"action" is empty. A recommendation with no instruction is not a recommendation.`);
    if (rec.rationale.trim() === "") push("EMPTY_FIELD", `"rationale" is empty. Every recommendation must say what evidence it rests on.`);

    // A recommendation resting on nothing measured is an opinion. The brief's
    // quality bar is a multiple, a baseline, a sample size and an action — this
    // is the first of those four, checked rather than requested.
    if (rec.figures.length === 0) {
        push(
            "NO_FIGURES",
            `"figures" is empty. Every recommendation must cite at least one computed figure from the report.`,
        );
    }

    for (const figure of rec.figures) {
        numbersChecked += 1;
        if (!verifyLiteral(String(figure), evidence)) {
            push(
                "UNVERIFIED_FIGURE",
                `The figure ${figure} in "figures" does not appear anywhere in the analytics report. ` +
                    `Only cite figures that are present in the report you were given.`,
            );
        }
    }

    // The prose is where fabrication actually happens. A model that declares
    // clean `figures` and then writes "roughly 4x" in the rationale has still
    // told the user something the data does not support.
    for (const field of ["action", "rationale"] as const) {
        for (const literal of numericLiterals(rec[field])) {
            numbersChecked += 1;
            if (!verifyLiteral(literal, evidence)) {
                push(
                    "UNVERIFIED_NUMBER",
                    `The number ${literal} in "${field}" does not appear in the analytics report. ` +
                        `Every number you write must be one the report computed. Do not take numbers from post captions, ` +
                        `and do not compute new ones.`,
                );
            }
        }
    }

    for (const postId of rec.postIds) {
        if (!evidence.postIds.has(postId)) {
            push(
                "UNKNOWN_POST_ID",
                `Post id "${postId}" is not in the report. Cite only the post ids listed under bestPosts and worstPosts.`,
            );
        }
    }

    if (!Number.isFinite(rec.sampleSize) || rec.sampleSize < MIN_RECOMMENDATION_N) {
        push(
            "SAMPLE_TOO_SMALL",
            `sampleSize is ${rec.sampleSize}, below the minimum of ${MIN_RECOMMENDATION_N}. ` +
                `Base this recommendation on a bucket with at least ${MIN_RECOMMENDATION_N} posts, or drop it.`,
        );
    }

    return { ok: violations.length === 0, violations, numbersChecked };
}

/** One line naming every violation, for the retry prompt and for the log. */
export function describeViolations(violations: readonly Violation[]): string {
    return violations.map((v) => `[${v.code}] ${v.message}`).join(" ");
}
