// The AI routes.
//
// `GET /api/ai/recommendations` lands here on Day 3's second half, alongside
// recommend.ts and validate.ts. Classification is complete.
//
// One thing this file gets right that is easy to get wrong: a missing API key
// is a 503 with instructions, not a 500. The analytics half of this product
// works fully without any key at all, so "no key" is a degraded-but-expected
// state rather than a fault, and the UI needs to be able to say so.

import { Router } from "express";
import { classificationStatus, classifyPosts, MIN_CONFIDENCE } from "../ai/classify";
import { CLASSIFY_MODEL, hasApiKey, MissingApiKeyError } from "../ai/gemini";
import { ApiError, route } from "./http";

export const aiRouter: Router = Router();

/** What is classified, without running or costing anything. */
aiRouter.get(
    "/classify",
    route(async (_req, res) => {
        const status = await classificationStatus();
        res.json({
            ...status,
            model: CLASSIFY_MODEL,
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
            if (error instanceof MissingApiKeyError) {
                throw new ApiError(503, "NO_API_KEY", error.message);
            }
            throw error;
        }
    }),
);
