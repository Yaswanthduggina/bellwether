// The audit trail (Module A, SHOULD).
//
// Every ingestion attempt gets a row, including the ones that fail. When a number
// on the dashboard looks wrong, this table is the first thing anyone opens — and
// it is only useful if failures are recorded as loudly as successes, which is why
// failRun() exists and why the pipeline wraps its work in try/finally.

import { prisma } from "../db";

export type RunStatus = "running" | "success" | "partial" | "failed";

export async function startRun(accountId: string, source: string): Promise<string> {
    const run = await prisma.ingestionRun.create({
        data: { accountId, source, status: "running" satisfies RunStatus },
        select: { id: true },
    });
    return run.id;
}

export async function finishRun(
    runId: string,
    counts: { rowsFetched: number; rowsFailed: number; errorNote?: string | null },
): Promise<RunStatus> {
    // "partial" rather than "success" whenever anything failed. Collapsing the two
    // would let a run that dropped half its rows read as clean in the audit trail.
    const status: RunStatus = counts.rowsFailed > 0 ? "partial" : "success";

    await prisma.ingestionRun.update({
        where: { id: runId },
        data: {
            finishedAt: new Date(),
            rowsFetched: counts.rowsFetched,
            rowsFailed: counts.rowsFailed,
            status,
            errorNote: counts.errorNote ?? null,
        },
    });

    return status;
}

export async function failRun(runId: string, error: unknown, rowsFetched = 0, rowsFailed = 0): Promise<void> {
    await prisma.ingestionRun.update({
        where: { id: runId },
        data: {
            finishedAt: new Date(),
            rowsFetched,
            rowsFailed,
            status: "failed" satisfies RunStatus,
            errorNote: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        },
    });
}

/**
 * Truncated so a batch of 90 identical failures does not put a wall of text in the
 * audit row. The count is what matters; a few examples are enough to diagnose.
 */
export function summariseErrors(errors: { postId: string; reason: string }[], keep = 3): string | null {
    if (errors.length === 0) return null;
    const shown = errors.slice(0, keep).map((e) => `${e.postId}: ${e.reason}`);
    const rest = errors.length - shown.length;
    return shown.join(" | ") + (rest > 0 ? ` | ...and ${rest} more` : "");
}
