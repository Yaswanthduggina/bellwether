// The Express app.
//
// Kept deliberately boring. Everything interesting in this product is in
// analytics/ and ai/; this file's job is to expose it and get out of the way.

import "dotenv/config";
import cors from "cors";
import express, { type Express } from "express";
import { accountsRouter } from "./api/accounts";
import { analyticsRouter } from "./api/analytics";
import { errorHandler, route } from "./api/http";
import { ingestionRouter } from "./api/ingestion";
import { prisma } from "./db";

export function createApp(): Express {
    const app = express();

    app.use(cors());
    // An imported CSV is posted as a raw string in a JSON body, and a 90-day
    // export of four accounts is comfortably past Express's 100kb default.
    app.use(express.json({ limit: "10mb" }));

    /**
     * Liveness AND readiness in one, because they fail differently and a single
     * "ok" would hide the difference. The process can be up while Postgres is
     * unreachable, and that is precisely the state where every analytics route
     * returns a 500 and nobody knows why.
     */
    app.get(
        "/api/health",
        route(async (_req, res) => {
            try {
                const [accounts, posts] = await Promise.all([prisma.account.count(), prisma.post.count()]);
                res.json({ status: "ok", database: "reachable", accounts, posts });
            } catch (error) {
                res.status(503).json({
                    status: "degraded",
                    database: "unreachable",
                    message: error instanceof Error ? error.message : String(error),
                    hint: "Check DATABASE_URL in server/.env. Supabase direct connections are IPv6-only — use the session pooler URL.",
                });
            }
        }),
    );

    app.use("/api/accounts", accountsRouter);
    app.use("/api/analytics", analyticsRouter);
    app.use("/api", ingestionRouter);

    // A 404 that names the path beats Express's HTML default, which renders as
    // an unreadable blob when the caller is fetch() rather than a browser.
    app.use((req, res) => {
        res.status(404).json({ error: { code: "NO_ROUTE", message: `No route for ${req.method} ${req.path}.` } });
    });

    app.use(errorHandler);

    return app;
}

// Only listen when run directly, so tests can import `createApp` without
// binding a port.
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
    const port = Number(process.env["PORT"] ?? 4000);

    createApp().listen(port, () => {
        console.log(`\n  Bellwether API  →  http://localhost:${port}`);
        console.log(`  health          →  http://localhost:${port}/api/health\n`);
    });
}
