// Single Prisma client for the whole server.
//
// Prisma 7 removed the bundled query engine for SQL databases — a driver adapter
// is now required rather than optional, which is why @prisma/adapter-pg wraps the
// native `pg` pool here instead of Prisma opening its own connection.
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
    // Fail loudly at startup rather than with a confusing error on the first query.
    throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

const adapter = new PrismaPg({ connectionString });

// Reused across hot reloads so `tsx watch` doesn't leak a new pool on every save.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env["NODE_ENV"] !== "production") {
    globalForPrisma.prisma = prisma;
}
