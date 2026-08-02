// Question 4 — "so what do we do?" — and the only part of this product where an
// LLM writes something a user reads as advice.
//
// THE GROUNDING IS ARCHITECTURAL, NOT A PROMPT INSTRUCTION.
//
// Three separate mechanisms, in the order they do their work, because any one of
// them alone is defeatable:
//
//   1. buildReport.ts   The model is handed computed analytics and NOTHING else.
//                       It never sees a raw post metric, so it has no corpus to
//                       average in its head and nothing to misread. It can
//                       misinterpret a verified figure; it cannot invent one.
//   2. the schema       Every field is constrained. There is no free-text field
//                       a claim can be smuggled into and no parsing of prose.
//   3. validate.ts      Pure code checks every literal against the evidence
//                       index of the exact report that produced it.
//
// A prompt saying "do not make up numbers" is the weakest of the four things in
// this file and it is present only because it is free.
//
// WHY TIMING ADVICE COMES FROM THE PEERS
//
// The single most important instruction below, and it is a finding rather than a
// preference. The principal posts 08:00-16:00 and never in the evening, so his
// own best hours come out at ~1.0x his median — an account's own timing data
// cannot reveal a slot it never posts in. A timing recommendation drawn from his
// corpus will always say "carry on". The evening peak exists only in the peers'
// corpora, which is why `gaps.ts` exists and why the prompt sends the model
// there for anything about WHEN.

import { Type, type Schema } from "@google/genai";
import {
    buildReport,
    collectEvidence,
    type AnalyticsReport,
    type Evidence,
    type ReportPost,
} from "../analytics/buildReport";
import type { CorpusFilter } from "../analytics/corpus";
import { RECOMMEND_MODEL, structured, ThinkingLevel } from "./gemini";
import {
    describeViolations,
    MIN_RECOMMENDATION_N,
    validateRecommendation,
    type Recommendation,
    type ValidationResult,
    type Violation,
} from "./validate";

/**
 * How many recommendations to ask for.
 *
 * Six, not twenty. A communications manager acts on the top three and a list
 * long enough to include every defensible finding is a list nobody reads. The
 * cap is also a quality gate on the model: asked for six, it has to rank; asked
 * for twenty, it pads with the weakest gaps in the report and every padded item
 * still passes validation, because a weak finding is not an unverified one.
 */
export const MAX_RECOMMENDATIONS = 6;

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"] as const;
const DIMENSIONS = ["FORMAT", "HOUR", "DAY", "THEME", "CADENCE"] as const;

const RECOMMENDATION_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        action: {
            type: Type.STRING,
            description:
                "The instruction, concrete enough to put in a calendar. Names a format, a slot, a theme or a frequency.",
        },
        rationale: {
            type: Type.STRING,
            description:
                "Two or three sentences for a communications manager. Carries the multiple, what it is measured against, and the sample size.",
        },
        platform: { type: Type.STRING, enum: [...PLATFORMS] },
        dimension: { type: Type.STRING, enum: [...DIMENSIONS] },
        postIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Post ids from bestPosts/worstPosts that illustrate this. May be empty.",
        },
        figures: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            description: "Every computed figure this rests on, copied exactly from the report.",
        },
        sampleSize: { type: Type.INTEGER, description: "Posts behind the claim." },
        confidence: { type: Type.STRING, enum: ["HIGH", "MEDIUM", "LOW"] },
        priority: { type: Type.INTEGER, description: "1 is most important." },
    },
    required: [
        "action",
        "rationale",
        "platform",
        "dimension",
        "postIds",
        "figures",
        "sampleSize",
        "confidence",
        "priority",
    ],
    propertyOrdering: [
        "priority",
        "platform",
        "dimension",
        "action",
        "rationale",
        "figures",
        "sampleSize",
        "postIds",
        "confidence",
    ],
};

const RESPONSE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        recommendations: { type: Type.ARRAY, items: RECOMMENDATION_SCHEMA },
    },
    required: ["recommendations"],
};

const SYSTEM = `You are a social media strategist writing for the communications manager of an
Indian politician. She is not an analyst. She decides what gets posted next week.

You are given a COMPUTED ANALYTICS REPORT. It is the only thing you know. You have not
seen the posts, the accounts, or the internet.

HOW TO WRITE A RECOMMENDATION

Every one must carry all four of these, or it is not worth writing:
  - a MULTIPLE            the lift, exactly as the report writes it
  - the BASELINE it is measured against   "against his own median", "against the peer median"
  - a SAMPLE SIZE         "across <n> reels", using the report's own n
  - a CONCRETE ACTION     something that can be put in a calendar

  BAD   "Post more reels."
  GOOD  "Move two of the four weekly reels into the <window> slot. <k> peers earn <lift> their
         own median there across <n> posts, while he has never posted after <hour>."

The angle brackets above are placeholders. Fill them from the report and never carry a
number out of this instruction block into your answer — nothing here is data.

THE RULES ABOUT NUMBERS. These are checked mechanically after you answer, and a
recommendation that breaks one is discarded.

1. Every number you write must appear in the report you were given. Copy it exactly as the
   report writes it. Do not recompute, do not combine two figures into a third, do not
   convert a multiple into a percentage.
2. NEVER take a number from a post's caption. Captions are quoted in the report as
   captionExcerpt for recognition only. A caption reading "Rs 5,000 crore scheme" is a claim
   about the world that this system has not verified and cannot check. It is not evidence.
3. The report contains pre-written sentences (fields named "sentence" and
   "comparisonSentence"). They were composed by verified code from verified figures. Reusing
   their phrasing is the safest thing you can do and it is encouraged.
4. Put every figure you rely on in the "figures" array as well as in the prose.
5. sampleSize must be at least ${MIN_RECOMMENDATION_N}. If the only evidence you have for an idea is
   thinner than that, do not make the recommendation.
6. THE "nearMisses" ARRAY IS NOT EVIDENCE. Every basis carries one, and each entry is a
   bucket the analysis CONSIDERED AND REFUSED. Its figures are real, so rule 1 would let you
   quote them, and its "sentence" therefore begins "NOT REPORTED as a gap" to make the
   refusal impossible to miss. Never build a recommendation on one, never cite its numbers,
   and never describe one as something the peers "do well". Most entries mean the principal
   ALREADY MATCHES the peers there, so advising him to change it would be advice to fix
   something that is not broken. It exists so a human reader can see what was checked. Use
   "gaps". If "gaps" is empty for a platform, the honest answer is that this corpus supports
   no gap-based recommendation there — say that rather than reaching one row down.
7. WHERE A GAP RESTS ON ONE COMPETITOR, SAY SO IN THE RATIONALE. Read "peerAgreement": it
   reads like "1 of 3", meaning one of the three peers with enough posts in that bucket
   actually beat their own baseline there. A gap can be reported on a single peer. That is
   a real finding and you may use it — but one account's strong bucket can be that account's
   habit rather than a pattern, so name the peer it came from ("Rahul Gandhi earns 1.3x his
   own baseline here") instead of writing "peers do well here", which implies an agreement
   the number does not claim. Where peerAgreement shows two or more clearing, "the peer set"
   is fair.

WHERE EVIDENCE FOR EACH KIND OF ADVICE COMES FROM

  WHEN TO POST   Use the "gaps" entries with dimension HOUR or DAY, and the peerWindows.
                 DO NOT build a timing recommendation out of the principal's own bestHours.
                 He posts in a narrow daytime band, so his own data cannot show that a slot
                 he never uses is better — his best hours all sit near 1.0x his median for
                 that reason, and reading them as "his current timing is fine" is the single
                 easiest mistake to make with this report. Only the peers' corpora contain
                 evidence about slots he does not occupy.
  WHAT TO POST   "formats" for what works for him, "gaps" with dimension FORMAT for what
                 peers win with, and "overInvested" for what to stop doing.
  WHAT TO SAY    "gaps" with dimension THEME.
  HOW OFTEN      the platform's "cadence" block.

OTHER RULES

  - One platform per recommendation. Never blend platforms: their engagement rates have
    different denominators and are not comparable. The "denominator" field says which.
  - Where a gap carries a provenanceCaveat, either say so in the rationale or do not use
    that gap. Recommending a real action on generated evidence without saying so is the one
    failure this product cannot recover from.
  - Lead with the median, not the mean, wherever outlierDriven is true.
  - Rank by what will move the most engagement for the least change to how she already
    works. priority 1 is what she should do on Monday.
  - Read "notes" and "truncations". They say what the report could NOT establish.`;

export interface DroppedRecommendation {
    recommendation: Recommendation;
    violations: Violation[];
    /** Whether the retry was spent on it. False means it failed the schema, not the check. */
    retried: boolean;
}

export interface RecommendationRun {
    generatedAt: string;
    filter: CorpusFilter;
    model: string;
    /** Validated and ranked. Everything here has passed `validate.ts`. */
    recommendations: Recommendation[];
    /**
     * Failed twice and were discarded, with the reason.
     *
     * Returned rather than logged away. A drop rate is the honest measure of how
     * well the grounding is working, and a pipeline that silently discards half
     * its output looks identical from the outside to one that never generated it.
     */
    dropped: DroppedRecommendation[];
    /** Passed only on the second attempt. The retry earning its keep, or not. */
    repaired: number;
    /** How many the model returned before validation. */
    generated: number;
    /** The report posts behind every cited id, so the UI can render evidence chips. */
    citedPosts: Record<string, ReportPost>;
    /** Size of the verified-number set. A large jump here means validation has weakened. */
    evidence: { numbers: number; postIds: number };
    /** Carried through from the report — what could not be computed, and why. */
    notes: string[];
    usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
}

/** Every post the report exposes by id, so a cited id can be resolved for display. */
function indexReportPosts(report: AnalyticsReport): Record<string, ReportPost> {
    const index: Record<string, ReportPost> = {};
    for (const platform of report.platforms) {
        for (const basis of platform.bases) {
            for (const post of [...basis.bestPosts, ...basis.worstPosts]) index[post.id] = post;
        }
    }
    return index;
}

/**
 * Ask the model to fix one recommendation, naming exactly what was wrong.
 *
 * ONE retry, and it is per-recommendation rather than per-batch. Regenerating
 * the whole list to fix one bad number would put the five good ones back at
 * risk for no reason, and at temperature 0 it would most likely reproduce them
 * verbatim anyway — spending a call to re-derive work that already passed.
 */
async function repair(
    rec: Recommendation,
    result: ValidationResult,
    reportJson: string,
): Promise<{ value: Recommendation; usage: RecommendationRun["usage"] }> {
    const { value, usage } = await structured<Recommendation>({
        model: RECOMMEND_MODEL,
        system: SYSTEM,
        contents:
            `This recommendation you wrote FAILED the grounding check:\n\n` +
            `${JSON.stringify(rec, null, 2)}\n\n` +
            `WHAT WAS WRONG:\n${describeViolations(result.violations)}\n\n` +
            `Rewrite it so every number in it appears in the report below, exactly as the report ` +
            `writes it. Keep the same recommendation if the underlying finding is sound — change the ` +
            `numbers to the verified ones. If the finding cannot be supported by the report at all, ` +
            `replace it with one that can.\n\nTHE REPORT:\n\n${reportJson}`,
        schema: RECOMMENDATION_SCHEMA,
        thinking: ThinkingLevel.HIGH,
    });

    return { value, usage };
}

/**
 * Generate, validate and rank recommendations for one filter.
 *
 * The whole Module D pipeline. Deliberately returns a rich result rather than a
 * bare array: what was dropped and why is as much a part of the answer as what
 * survived.
 */
export async function generateRecommendations(filter: CorpusFilter = {}): Promise<RecommendationRun> {
    const report = await buildReport(filter);
    const evidence: Evidence = collectEvidence(report);

    const base: Omit<RecommendationRun, "recommendations" | "dropped" | "repaired" | "generated"> = {
        generatedAt: new Date().toISOString(),
        filter,
        model: RECOMMEND_MODEL,
        citedPosts: {},
        evidence: { numbers: evidence.numbers.size, postIds: evidence.postIds.size },
        notes: [...report.notes],
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0 },
    };

    // Nothing computable means nothing to recommend, and spending a call to be
    // told so is worse than saying so. The empty case is one a reviewer WILL
    // hit — an over-narrow filter — so it explains itself rather than rendering
    // as a blank panel.
    const hasAnalysis = report.platforms.some((p) => p.bases.length > 0);
    if (!hasAnalysis) {
        return {
            ...base,
            recommendations: [],
            dropped: [],
            repaired: 0,
            generated: 0,
            notes: [
                ...base.notes,
                "No recommendations: this filter produced no computable engagement rates, so there is " +
                    "nothing verified to base advice on. Widen the filter.",
            ],
        };
    }

    const reportJson = JSON.stringify(report, null, 2);

    const { value, usage } = await structured<{ recommendations: Recommendation[] }>({
        model: RECOMMEND_MODEL,
        system: SYSTEM,
        contents:
            `Here is the analytics report for ${report.principalName ?? "the principal"}` +
            `${report.peerNames.length > 0 ? `, measured against ${report.peerNames.join(", ")}` : ""}.\n\n` +
            `Write at most ${MAX_RECOMMENDATIONS} recommendations, ranked, answering: what should she post, ` +
            `when should she post it, and what should she stop doing? Cover more than one dimension — a list ` +
            `of six format recommendations is a worse answer than three covering format, timing and theme.\n\n` +
            `THE REPORT:\n\n${reportJson}`,
        schema: RESPONSE_SCHEMA,
        thinking: ThinkingLevel.HIGH,
    });

    const usageTotal = { ...usage };
    const generated = value.recommendations?.length ?? 0;

    const accepted: Recommendation[] = [];
    const dropped: DroppedRecommendation[] = [];
    let repaired = 0;

    for (const rec of value.recommendations ?? []) {
        const first = validateRecommendation(rec, evidence);
        if (first.ok) {
            accepted.push(rec);
            continue;
        }

        try {
            const attempt = await repair(rec, first, reportJson);
            usageTotal.promptTokens += attempt.usage.promptTokens;
            usageTotal.outputTokens += attempt.usage.outputTokens;
            usageTotal.thoughtTokens += attempt.usage.thoughtTokens;

            const second = validateRecommendation(attempt.value, evidence);
            if (second.ok) {
                accepted.push(attempt.value);
                repaired += 1;
            } else {
                dropped.push({ recommendation: attempt.value, violations: second.violations, retried: true });
            }
        } catch (error) {
            // A failed repair call must not lose the recommendations that
            // already passed. It is recorded as a drop with the transport
            // failure attached, so "the model was unreachable" does not read as
            // "the model fabricated".
            dropped.push({
                recommendation: rec,
                violations: [
                    ...first.violations,
                    {
                        code: "UNVERIFIED_NUMBER",
                        message: `The retry could not be completed: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                retried: true,
            });
        }
    }

    // Rank on the model's own priority. The numbers are not its judgement to
    // make; the ordering is exactly what it is for.
    accepted.sort((a, b) => a.priority - b.priority);

    if (dropped.length > 0) {
        // Visible in the server log as well as in the response. A drop rate that
        // climbs is the first sign the report and the validator have drifted
        // apart, and nobody reads a JSON field they are not looking for.
        console.warn(
            `[recommend] dropped ${dropped.length} of ${generated} recommendations after retry: ` +
                dropped.map((d) => describeViolations(d.violations)).join(" | "),
        );
    }

    const citedPosts: Record<string, ReportPost> = {};
    const allPosts = indexReportPosts(report);
    for (const rec of accepted) {
        for (const id of rec.postIds) {
            const post = allPosts[id];
            if (post) citedPosts[id] = post;
        }
    }

    const notes = [...base.notes];
    if (dropped.length > 0) {
        notes.push(
            `${dropped.length} of ${generated} generated recommendations cited figures that are not in the ` +
                `analytics and were discarded after one retry. A dropped recommendation is better than a ` +
                `fabricated one; the drop count is reported so the failure rate is visible rather than invisible.`,
        );
    }
    if (accepted.length === 0 && generated > 0) {
        notes.push("Every generated recommendation failed the grounding check. None are shown.");
    }

    return { ...base, recommendations: accepted, dropped, repaired, generated, citedPosts, notes, usage: usageTotal };
}
