// Theme classification — one of the two jobs the LLM does in this product.
//
// WHY A FIXED TAXONOMY, NOT AN INDUCED ONE
//
// Asking the model to discover categories produces better-fitting labels for
// any single corpus and destroys the only thing they are needed for. The
// principal and every competitor must land in the SAME categories or a theme
// gap is not a finding — it is two different vocabularies being subtracted from
// each other. An induced taxonomy drifts between corpora by construction.
//
// WHY CONFIDENCE IS STORED RATHER THAN THRESHOLDED AWAY
//
// A post the model is 51% sure about and a post it is 99% sure about are
// different evidence, and collapsing them at write time throws away the
// distinction permanently. The confidence is persisted; the OTHER fallback is
// applied on top of it. That also means the threshold can be re-tuned without
// re-spending the API budget on 940 posts.
//
// CLASSIFICATION IS CAPTION-ONLY. No image, video-frame or audio understanding,
// so a post whose meaning lives entirely in its visual lands in OTHER. That is
// a real limitation, it is in the README, and `unclassifiable` counts it rather
// than letting it hide inside the OTHER bucket alongside genuine judgements.

import { Type, type Schema } from "@google/genai";
import { prisma } from "../db";
import type { ContentPillar } from "../analytics/gaps";
import { CLASSIFY_MODELS, QuotaExhaustedError, structured, ThinkingLevel } from "./gemini";

/**
 * How many posts per call.
 *
 * 25 is a compromise with a failure mode on each side. Larger batches are
 * cheaper per post but a single malformed response costs more work, and the
 * model's index-tracking degrades as the list grows — which shows up as
 * MISALIGNED labels rather than as an error, the worst kind of failure here.
 * Smaller batches cost more calls and hit rate limits.
 */
export const BATCH_SIZE = 25;

/**
 * Below this the label is not trusted and the post falls to OTHER.
 *
 * 0.6, not 0.5: at a coin-flip the model has told us it cannot tell, and a
 * theme gap built on coin-flips would be a finding about noise. The original
 * confidence is still stored, so this is a display and analysis rule rather
 * than a destructive one.
 */
export const MIN_CONFIDENCE = 0.6;

export const CONTENT_PILLARS: readonly ContentPillar[] = [
    "POLICY_ANNOUNCEMENT",
    "CONSTITUENCY_VISIT",
    "PERSONAL_FAMILY",
    "ATTACK_REBUTTAL",
    "FESTIVAL_GREETING",
    "ACHIEVEMENT_CLAIM",
    "MEDIA_APPEARANCE",
    "OTHER",
];

/**
 * The taxonomy, defined for the model rather than merely named.
 *
 * The definitions carry the boundary cases, because the names alone are
 * ambiguous exactly where Indian political content actually sits: an MP
 * announcing a road for their own constituency is both a policy announcement
 * and a constituency visit, and without a stated tie-break the same post
 * classifies differently across accounts — which silently manufactures a theme
 * gap out of nothing.
 */
const TAXONOMY = `
POLICY_ANNOUNCEMENT  A position, bill, scheme or policy argument. National or legislative in scope.
                     Includes parliamentary activity: questions tabled, bills introduced, debates.

CONSTITUENCY_VISIT   Presence and work in a specific place: inaugurations, site visits, local
                     grievance redressal, meeting residents. The defining feature is a LOCATION
                     and the politician physically being there.

PERSONAL_FAMILY      Family, health, personal milestones, condolences, non-political friendship,
                     books read, personal reflection with no policy content.

ATTACK_REBUTTAL      Directed criticism of a named opponent or party, or a defence against one.
                     Adversarial framing is the defining feature, whatever the topic.

FESTIVAL_GREETING    Festival, religious, national-day or anniversary wishes. Ceremonial, no ask.

ACHIEVEMENT_CLAIM    Claiming credit for a delivered outcome — funds sanctioned, project completed,
                     award received, milestone reached.

MEDIA_APPEARANCE     Promoting or sharing the politician's own appearance elsewhere: an interview,
                     a TV debate, a column, a podcast, a speech recording.

OTHER                Anything else, anything genuinely ambiguous, and anything the caption is too
                     short or too content-free to judge.
`.trim();

const SYSTEM = `You classify social media posts by Indian politicians into a FIXED taxonomy.

${TAXONOMY}

RULES

1. Use ONLY the categories above. Never invent one.
2. Return exactly one result per input index, using the index you were given. Do not
   renumber, reorder, skip, or merge posts.
3. Tie-breaks, so the same post classifies identically across every account:
   - Announcing work for a named place while being there    -> CONSTITUENCY_VISIT
   - Announcing a policy without being anywhere specific    -> POLICY_ANNOUNCEMENT
   - Claiming a COMPLETED outcome                            -> ACHIEVEMENT_CLAIM
   - Sharing your own interview ABOUT a policy               -> MEDIA_APPEARANCE
   - A festival greeting that also attacks an opponent       -> ATTACK_REBUTTAL
4. confidence is your genuine certainty, 0 to 1. Report low confidence honestly — a
   post you cannot judge is worth more to us as an admitted OTHER than as a guess.
   Do not inflate confidence to appear decisive.
5. Captions may be in English, Hindi, Malayalam, or a mix, and may be transliterated.
   Classify on meaning. If you cannot read it, that is OTHER with low confidence.
6. You are shown the caption and media type only. Judge only what is there — do not
   infer content from the media type alone.`;

const RESPONSE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        results: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    index: { type: Type.INTEGER, description: "The index of the post, exactly as given." },
                    theme: { type: Type.STRING, enum: [...CONTENT_PILLARS] },
                    confidence: { type: Type.NUMBER, description: "0 to 1." },
                },
                required: ["index", "theme", "confidence"],
                propertyOrdering: ["index", "theme", "confidence"],
            },
        },
    },
    required: ["results"],
};

interface ClassifyResponse {
    results: { index: number; theme: string; confidence: number }[];
}

interface ClassifiablePost {
    id: string;
    caption: string | null;
    mediaType: string;
}

// ── The two decisions worth testing without a network ────────────────────

export interface RawLabel {
    index: number;
    theme: string;
    confidence: number;
}

/**
 * Index the model's results by the index it was GIVEN, discarding anything out
 * of range or duplicated.
 *
 * The alternative — zipping results to the batch positionally — is the most
 * dangerous line this module could contain. `responseSchema` constrains SHAPE,
 * not COUNT or ORDER: nothing stops the model returning 24 results for 25 posts,
 * or returning them out of order. A positional zip would then shift every
 * subsequent label by one and write a full batch of confidently wrong themes
 * with no error anywhere. Keying by index makes that failure a `missing` count
 * instead of silent corruption.
 *
 * First occurrence wins on a duplicate: a second opinion about index 3 is the
 * model contradicting itself, and picking the later one is not more correct —
 * but it IS reported, so a systematic duplication shows up rather than hiding.
 */
export function indexResults(
    results: readonly RawLabel[] | undefined,
    batchSize: number,
): { byIndex: Map<number, RawLabel>; discarded: number } {
    const byIndex = new Map<number, RawLabel>();
    let discarded = 0;

    for (const result of results ?? []) {
        const inRange = Number.isInteger(result?.index) && result.index >= 0 && result.index < batchSize;
        if (!inRange || byIndex.has(result.index)) {
            discarded += 1;
            continue;
        }
        byIndex.set(result.index, result);
    }

    return { byIndex, discarded };
}

export interface ResolvedLabel {
    theme: ContentPillar;
    /** The model's own confidence, clamped to [0,1]. Stored even when the label is not. */
    confidence: number;
    /** True when a real category was demoted to OTHER by the threshold. */
    demoted: boolean;
}

/**
 * Turn one raw label into what gets written.
 *
 * Two demotions to OTHER, and the confidence survives both — the threshold is a
 * display and analysis rule, not a destructive one, so it can be re-tuned later
 * without re-spending the API budget on the whole corpus.
 */
export function resolveLabel(raw: RawLabel): ResolvedLabel {
    const confidence = Number.isFinite(raw.confidence) ? Math.min(Math.max(raw.confidence, 0), 1) : 0;

    // A theme outside the taxonomy should be impossible under the enum schema.
    // Checked anyway: "impossible" here means "impossible unless the schema is
    // edited", and the cost of the check is one array lookup.
    const known = CONTENT_PILLARS.includes(raw.theme as ContentPillar);
    const belowBar = confidence < MIN_CONFIDENCE;

    if (!known) return { theme: "OTHER", confidence, demoted: false };
    if (belowBar) return { theme: "OTHER", confidence, demoted: raw.theme !== "OTHER" };

    return { theme: raw.theme as ContentPillar, confidence, demoted: false };
}

export interface ClassifyReport {
    /** Posts considered — those with no theme yet, after the filter. */
    candidates: number;
    /** Posts written with a model-assigned theme. */
    classified: number;
    /** Written as OTHER because the model's confidence was below the threshold. */
    lowConfidence: number;
    /** Never sent: no caption to read. Counted apart from genuine OTHER judgements. */
    unclassifiable: number;
    /**
     * Sent but not returned — the model skipped the index. Left UNCLASSIFIED
     * rather than defaulted, so a silent gap cannot masquerade as an OTHER.
     */
    missing: number;
    /** Results the model returned for an index outside the batch, or twice. */
    discardedResults: number;
    batches: number;
    /**
     * Every model that actually produced labels in this run, in the order first
     * used. Usually one entry; more than one means the primary ran out of daily
     * quota mid-run and the chain fell through, which is worth knowing when
     * comparing label quality across runs.
     */
    modelsUsed: string[];
    failedBatches: { batch: number; error: string }[];
    /**
     * Set when the run abandoned work it had not attempted. Present rather than
     * implied, because a report showing 400 of 940 classified and no explanation
     * reads as "the model declined 540 posts" rather than "we ran out of quota".
     */
    stoppedEarly?: { reason: "QUOTA_EXHAUSTED"; message: string; remaining: number };
    distribution: Record<string, number>;
    usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
}

function renderBatch(posts: ClassifiablePost[]): string {
    return posts
        .map((post, index) => {
            // Truncated: the first 400 characters carry the theme in essentially
            // every case, and a 3,000-character thread would crowd out the other
            // 24 posts in the batch for no gain in accuracy.
            const caption = (post.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
            return `${index}: [${post.mediaType}] ${caption}`;
        })
        .join("\n");
}

export interface ClassifyOptions {
    /** Re-classify posts that already have a theme. Off by default: re-runs are free. */
    force?: boolean;
    /** Cap the number of posts processed. Useful for a cheap smoke test. */
    limit?: number;
    accountId?: string;
    platform?: string;
    /** Progress callback, so a long run is not silent. */
    onProgress?: (done: number, total: number) => void;
}

/**
 * Classify every unclassified post.
 *
 * INCREMENTAL BY DEFAULT. Only posts with `theme = null` are considered, so
 * re-running after ingesting 40 new posts costs 2 calls rather than 38. This is
 * why the endpoint is safe to expose in a UI a reviewer will click more than
 * once.
 */
export async function classifyPosts(options: ClassifyOptions = {}): Promise<ClassifyReport> {
    const posts = await prisma.post.findMany({
        where: {
            ...(options.force ? {} : { theme: null }),
            ...(options.accountId ? { accountId: options.accountId } : {}),
            ...(options.platform ? { platform: options.platform as never } : {}),
        },
        select: { id: true, caption: true, mediaType: true },
        orderBy: { postedAt: "desc" },
        ...(options.limit ? { take: options.limit } : {}),
    });

    const report: ClassifyReport = {
        candidates: posts.length,
        classified: 0,
        lowConfidence: 0,
        unclassifiable: 0,
        missing: 0,
        discardedResults: 0,
        batches: 0,
        modelsUsed: [],
        failedBatches: [],
        distribution: {},
        usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0 },
    };

    // A post with no caption has nothing to classify. Writing it as OTHER
    // without spending a call is both cheaper and more honest than asking the
    // model to guess from a media type.
    const readable: ClassifiablePost[] = [];
    const empty: ClassifiablePost[] = [];
    for (const post of posts) {
        if ((post.caption ?? "").trim() === "") empty.push(post);
        else readable.push(post);
    }

    if (empty.length > 0) {
        await prisma.post.updateMany({
            where: { id: { in: empty.map((p) => p.id) } },
            data: { theme: "OTHER", themeConfidence: 0 },
        });
        report.unclassifiable = empty.length;
        report.distribution["OTHER"] = empty.length;
    }

    for (let start = 0; start < readable.length; start += BATCH_SIZE) {
        const batch = readable.slice(start, start + BATCH_SIZE);
        const batchNumber = Math.floor(start / BATCH_SIZE) + 1;
        report.batches += 1;

        try {
            const { value, usage, model } = await structured<ClassifyResponse>({
                model: CLASSIFY_MODELS,
                system: SYSTEM,
                contents: `Classify these ${batch.length} posts. Return one result per index, 0 to ${batch.length - 1}.\n\n${renderBatch(batch)}`,
                schema: RESPONSE_SCHEMA,
                thinking: ThinkingLevel.MINIMAL,
            });

            if (!report.modelsUsed.includes(model)) report.modelsUsed.push(model);

            report.usage.promptTokens += usage.promptTokens;
            report.usage.outputTokens += usage.outputTokens;
            report.usage.thoughtTokens += usage.thoughtTokens;

            // Keyed by the index the model was GIVEN, never zipped positionally
            // — see `indexResults` for why that distinction is load-bearing.
            const { byIndex, discarded } = indexResults(value.results, batch.length);
            report.discardedResults += discarded;

            for (const [index, post] of batch.entries()) {
                const raw = byIndex.get(index);

                if (raw === undefined) {
                    // Left null. A skipped post is not an OTHER post, and
                    // recording it as one would hide a model failure inside a
                    // legitimate category. The next run picks it up.
                    report.missing += 1;
                    continue;
                }

                const { theme, confidence, demoted } = resolveLabel(raw);
                if (demoted) report.lowConfidence += 1;

                await prisma.post.update({
                    where: { id: post.id },
                    data: { theme, themeConfidence: confidence },
                });

                report.classified += 1;
                report.distribution[theme] = (report.distribution[theme] ?? 0) + 1;
            }
        } catch (error) {
            // One bad batch must not lose the other 37. The posts stay
            // unclassified and the next run picks them up, because the query
            // filters on theme = null.
            report.failedBatches.push({
                batch: batchNumber,
                error: error instanceof Error ? error.message : String(error),
            });

            // Quota exhaustion is a wall, not weather. By the time this fires,
            // `structured` has already walked the whole model chain — so it
            // means every model's daily allowance is gone, not just one. Every
            // remaining batch would fail identically, so the run stops and says
            // so rather than spending minutes proving it: the first real pass
            // burned 20 batches × 3 retries after the quota was already gone.
            if (error instanceof QuotaExhaustedError) {
                report.stoppedEarly = {
                    reason: "QUOTA_EXHAUSTED",
                    message: error.message,
                    remaining: readable.length - Math.min(start + BATCH_SIZE, readable.length),
                };
                break;
            }
        }

        options.onProgress?.(Math.min(start + BATCH_SIZE, readable.length), readable.length);
    }

    return report;
}

/** What is classified and what is not, without running anything. */
export async function classificationStatus(): Promise<{
    total: number;
    classified: number;
    unclassified: number;
    lowConfidence: number;
    distribution: Record<string, number>;
}> {
    const [total, unclassified, lowConfidence, grouped] = await Promise.all([
        prisma.post.count(),
        prisma.post.count({ where: { theme: null } }),
        prisma.post.count({ where: { themeConfidence: { lt: MIN_CONFIDENCE, gt: 0 } } }),
        prisma.post.groupBy({ by: ["theme"], _count: true }),
    ]);

    const distribution: Record<string, number> = {};
    for (const row of grouped) {
        if (row.theme !== null) distribution[row.theme] = row._count;
    }

    return { total, classified: total - unclassified, unclassified, lowConfidence, distribution };
}
