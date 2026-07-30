// Ingestion routes: run the pipeline, import a file, read the audit trail.
//
// The audit trail (FR14) is the one people underrate. When a number on the
// dashboard looks wrong, IngestionRun is the first place to check — it records
// every fetch attempt, including the ones that half-worked. The distinction
// between "success" and "partial" exists so a run that dropped half its rows
// cannot read as clean, and this route surfaces that rather than flattening it
// into a green tick.

import { Router } from "express";
import { createFileAdapterFromContents } from "../adapters/fileAdapter";
import { prisma } from "../db";
import { ingestAccount, ingestAll } from "../ingestion/pipeline";
import { PLATFORMS } from "./filters";
import { ApiError, route } from "./http";

export const ingestionRouter: Router = Router();

/**
 * Run the pipeline over one account or all of them.
 *
 * Synchronous by design for a four-day build: a job queue would be the right
 * answer at scale, and saying so plainly is better than a fake-async endpoint
 * that returns a job id nothing ever polls. The response carries the per-account
 * result including failures, so a partial run is visible rather than implied.
 */
ingestionRouter.post(
    "/ingest",
    route(async (req, res) => {
        const body = (req.body ?? {}) as { accountId?: unknown; platform?: unknown; sinceDays?: unknown };

        const sinceDays = body.sinceDays === undefined ? undefined : Number(body.sinceDays);
        if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0)) {
            throw ApiError.badRequest("INVALID_FIELD", `"sinceDays" must be a positive number.`);
        }

        if (typeof body.accountId === "string") {
            const account = await prisma.account.findUnique({ where: { id: body.accountId } });
            if (!account) throw ApiError.notFound(`No account with id ${body.accountId}.`);

            const result = await ingestAccount(account.id, sinceDays === undefined ? {} : { sinceDays });
            res.json({ results: [result] });
            return;
        }

        if (body.platform !== undefined) {
            const platform = String(body.platform).toUpperCase();
            if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
                throw ApiError.badRequest("INVALID_FIELD", `"platform" must be one of ${PLATFORMS.join(", ")}.`);
            }

            const accounts = await prisma.account.findMany({
                where: { platform: platform as (typeof PLATFORMS)[number] },
            });

            const results = [];
            for (const account of accounts) {
                // Per-account isolation: one channel's quota failure must not
                // abort the other three. The pipeline records the failure on its
                // own IngestionRun row either way.
                try {
                    results.push(await ingestAccount(account.id, sinceDays === undefined ? {} : { sinceDays }));
                } catch (error) {
                    results.push({
                        accountId: account.id,
                        handle: account.handle,
                        platform: account.platform,
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            res.json({ results });
            return;
        }

        res.json({ results: await ingestAll(sinceDays === undefined ? {} : { sinceDays }) });
    }),
);

/**
 * FR3 — CSV/JSON import.
 *
 * The payload is posted as a raw string rather than a multipart upload: it keeps
 * the dependency list shorter and the browser can read a local file and POST its
 * text in three lines. The column inference and its failure modes live in
 * `fileAdapter.ts`, which is tested; this route only routes.
 */
ingestionRouter.post(
    "/import",
    route(async (req, res) => {
        const body = (req.body ?? {}) as { accountId?: unknown; content?: unknown; filename?: unknown };

        if (typeof body.accountId !== "string") {
            throw ApiError.badRequest("MISSING_FIELD", `"accountId" is required — an import targets one account.`);
        }
        if (typeof body.content !== "string" || body.content.trim() === "") {
            throw ApiError.badRequest("MISSING_FIELD", `"content" must be the file's text.`);
        }

        const account = await prisma.account.findUnique({ where: { id: body.accountId } });
        if (!account) throw ApiError.notFound(`No account with id ${body.accountId}.`);

        const filename = typeof body.filename === "string" ? body.filename : "upload.csv";
        const extension = filename.toLowerCase().endsWith(".json") ? ".json" : ".csv";

        try {
            const content = body.content;
            const adapter = createFileAdapterFromContents(account.platform, () => content, extension);

            res.json({ result: await ingestAccount(account.id, { adapter }) });
        } catch (error) {
            // A malformed file is the user's problem to fix, not a server fault,
            // and the message from fileAdapter names the column it could not
            // resolve — which is the only thing that makes it fixable.
            throw ApiError.badRequest(
                "IMPORT_FAILED",
                error instanceof Error ? error.message : String(error),
                { filename },
            );
        }
    }),
);

/** FR14 — the audit trail behind every number on the dashboard. */
ingestionRouter.get(
    "/ingestion-runs",
    route(async (req, res) => {
        const limit = Math.min(Number(req.query["limit"] ?? 50) || 50, 200);
        const accountId = req.query["accountId"];

        const runs = await prisma.ingestionRun.findMany({
            where: typeof accountId === "string" ? { accountId } : {},
            orderBy: { startedAt: "desc" },
            take: limit,
            include: { account: { select: { personName: true, platform: true, handle: true, isSynthetic: true } } },
        });

        res.json({
            runs: runs.map((run) => ({
                id: run.id,
                accountId: run.accountId,
                personName: run.account.personName,
                platform: run.account.platform,
                handle: run.account.handle,
                isSynthetic: run.account.isSynthetic,
                source: run.source,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                rowsFetched: run.rowsFetched,
                rowsFailed: run.rowsFailed,
                status: run.status,
                errorNote: run.errorNote,
            })),
            // "partial" is a distinct status precisely so it cannot be read as
            // success. Surfaced as its own count so the UI can act on it.
            summary: {
                total: runs.length,
                partial: runs.filter((r) => r.status === "partial").length,
                failed: runs.filter((r) => r.status === "failed").length,
            },
        });
    }),
);
