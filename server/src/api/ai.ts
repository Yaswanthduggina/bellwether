// The AI routes.
//
// One thing this file gets right that is easy to get wrong: a missing API key
// is a 503 with instructions, not a 500. The analytics half of this product
// works fully without any key at all, so "no key" is a degraded-but-expected
// state rather than a fault, and the UI needs to be able to say so.

import { Router } from "express";
import { classificationStatus, classifyPosts, MIN_CONFIDENCE } from "../ai/classify";
import {
    CLASSIFY_MODEL,
    CLASSIFY_MODELS,
    hasApiKey,
    MissingApiKeyError,
    QuotaExhaustedError,
    RECOMMEND_MODELS,
} from "../ai/gemini";
import { MAX_RECOMMENDATIONS, recommendationsFor } from "../ai/recommend";
import { MIN_RECOMMENDATION_N } from "../ai/validate";
import { parseFilter } from "./filters";
import { ApiError, route } from "./http";

/** A spent quota is not a bug, so it is not a 500. 503 with what to do about it. */
function asApiError(error: unknown): ApiError | null {
    if (error instanceof MissingApiKeyError) return new ApiError(503, "NO_API_KEY", error.message);
    if (error instanceof QuotaExhaustedError) {
        return new ApiError(503, "QUOTA_EXHAUSTED", error.message, {
            note: "Every analytics route still works — only the AI layer is affected.",
        });
    }
    return null;
}

export const aiRouter: Router = Router();

/** What is classified, without running or costing anything. */
aiRouter.get(
    "/classify",
    route(async (_req, res) => {
        const status = await classificationStatus();
        res.json({
            ...status,
            model: CLASSIFY_MODEL,
            // The fallbacks as well as the primary: when the primary's daily
            // quota is spent the run continues on the next one, so "which model
            // is this" has more than one honest answer.
            models: CLASSIFY_MODELS,
            minConfidence: MIN_CONFIDENCE,
            apiKeyConfigured: hasApiKey(),
            complete: status.total > 0 && status.unclassified === 0,
        });
    }),
);

/**
 * FR11 — run or refresh classification.
 *
 * Synchronous, and the full corpus takes minutes. That is a real limitation of
 * a four-day build and is stated rather than disguised: a job queue is the right
 * answer at scale, and a fake-async endpoint returning a job id nothing polls
 * would be worse than an honest wait. The incremental default keeps the common
 * case — a re-run after ingesting a few posts — down to seconds.
 */
aiRouter.post(
    "/classify",
    route(async (req, res) => {
        const body = (req.body ?? {}) as {
            force?: unknown;
            limit?: unknown;
            accountId?: unknown;
            platform?: unknown;
        };

        if (!hasApiKey()) {
            throw new ApiError(
                503,
                "NO_API_KEY",
                "No Gemini API key is configured, so classification cannot run. Set GEMINI_API_KEY in server/.env.",
                { note: "Every analytics route works without a key — only the AI layer needs one." },
            );
        }

        const limit = body.limit === undefined ? undefined : Number(body.limit);
        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
            throw ApiError.badRequest("INVALID_FIELD", `"limit" must be a positive number.`);
        }

        try {
            const report = await classifyPosts({
                force: body.force === true,
                ...(limit ? { limit } : {}),
                ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {}),
                ...(typeof body.platform === "string" ? { platform: body.platform.toUpperCase() } : {}),
            });

            res.json({ report, status: await classificationStatus() });
        } catch (error) {
            throw asApiError(error) ?? error;
        }
    }),
);

/**
 * FR12 — the ranked, grounded, validated recommendations. Question 4.
 *
 * A GET that costs money and takes 40-70 seconds on a cold filter, which is a
 * fair objection. It is a GET anyway because it is idempotent in the sense that
 * matters — it writes nothing, and calling it twice leaves the system exactly as
 * it was.
 *
 * It IS cached, and the objection that once kept it uncached is answered rather
 * than dropped: the worry was that a filter-keyed cache needs invalidating on
 * every ingestion. So the key is not the filter alone — it is the filter plus a
 * fingerprint of the corpus, and anything that moves the corpus moves the key.
 * See `recommendationsFor`. The response says which it was.
 *
 * Takes the same filter block as every analytics route (FR16), so the panel can
 * be re-run for one platform.
 */
aiRouter.get(
    "/recommendations",
    route(async (req, res) => {
        const filter = parseFilter(req);

        if (!hasApiKey()) {
            throw new ApiError(
                503,
                "NO_API_KEY",
                "No Gemini API key is configured, so recommendations cannot be generated. Set GEMINI_API_KEY in server/.env.",
                {
                    note:
                        "Every analytics route works without a key. GET /api/analytics/report returns the exact " +
                        "document the recommendation model would have been given.",
                },
            );
        }

        try {
            const { run, cached } = await recommendationsFor(filter);
            res.json({
                ...run,
                // Stated, not implied. `generatedAt` on a cached run is the time
                // the MODEL ran, which is the honest value — but a reader
                // comparing it to the clock deserves to know why it is old.
                cached,
                limits: { maxRecommendations: MAX_RECOMMENDATIONS, minSampleSize: MIN_RECOMMENDATION_N },
                // `run.model` — the model that ANSWERED — is deliberately left
                // to stand. Overwriting it with the configured primary would
                // report the wrong model on any run that fell through to a
                // fallback after the primary's daily quota ran out.
                models: RECOMMEND_MODELS,
            });
        } catch (error) {
            throw asApiError(error) ?? error;
        }
    }),
);
