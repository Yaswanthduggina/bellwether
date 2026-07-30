// Shared HTTP plumbing. Small on purpose — this layer should be thin enough
// that a reviewer can see the analytics modules through it.
//
// One decision worth stating: errors are translated into a stable JSON shape
// with a machine-readable `code`, rather than letting Express render a stack
// trace. The UI has to distinguish "you asked for an account that does not
// exist" from "the analytics layer refused to average two engagement bases" —
// the first is a 404 the user caused, the second is a 500 that means a bug, and
// a page that renders both as "something went wrong" hides the difference from
// the person best placed to report it.

import type { NextFunction, Request, Response } from "express";
import { MixedBasisError } from "../analytics/engagement";

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly detail?: unknown,
    ) {
        super(message);
        this.name = "ApiError";
    }

    static badRequest(code: string, message: string, detail?: unknown): ApiError {
        return new ApiError(400, code, message, detail);
    }

    static notFound(message: string): ApiError {
        return new ApiError(404, "NOT_FOUND", message);
    }

    static conflict(code: string, message: string): ApiError {
        return new ApiError(409, code, message);
    }
}

/**
 * Wrap an async route so a rejected promise reaches the error handler.
 *
 * Express 5 forwards rejections from async handlers on its own, but wrapping
 * explicitly keeps the behaviour independent of that — an unhandled rejection
 * here hangs the request rather than failing it, and a hung dashboard panel is
 * the hardest kind of failure to diagnose from the outside.
 */
export function route(
    handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (error instanceof ApiError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message, detail: error.detail } });
        return;
    }

    // The basis guard reaching the API means a route composed a comparison the
    // analytics layer considers meaningless. That is a bug in this code, not bad
    // input, so it is a 500 — but it gets its own code so it is not lost in the
    // noise of generic failures.
    if (error instanceof MixedBasisError) {
        res.status(500).json({
            error: {
                code: "MIXED_BASIS",
                message: error.message,
                detail: { context: error.context, bases: error.bases },
            },
        });
        return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[api] unhandled:", error);
    res.status(500).json({ error: { code: "INTERNAL", message } });
}
