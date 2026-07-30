// FR1 — add and remove tracked accounts, an "arbitrary number" of them.
//
// Until this file existed the roster was `config/accounts.ts`, a TypeScript
// literal, and "add a competitor" meant editing code and re-running the seed.
// That is a hardcoded roster wearing a configuration file's clothes, and it does
// not satisfy a MUST that says the user chooses who to track.
//
// TWO THINGS THIS ROUTE REFUSES TO DO, both deliberate:
//
// 1. It will not create an account on a platform with no live adapter unless the
//    caller acknowledges the result will be seeded. Silently generating a
//    synthetic corpus for a real person the user just typed in, and rendering it
//    beside live data, is how a demo becomes a lie.
//
// 2. It will not ingest during creation by default. A YouTube backfill takes
//    seconds and a request that blocks on it looks broken; worse, a failure
//    halfway through would leave an account created but empty with no obvious
//    way to tell that apart from "this person posts nothing".

import { Router } from "express";
import { hasLiveAdapter } from "../adapters";
import { prisma } from "../db";
import { ingestAccount } from "../ingestion/pipeline";
import { PLATFORMS } from "./filters";
import { ApiError, route } from "./http";

export const accountsRouter: Router = Router();

const ROLES = ["PRINCIPAL", "COMPETITOR"] as const;

interface CreateBody {
    personName?: unknown;
    role?: unknown;
    platform?: unknown;
    handle?: unknown;
    displayName?: unknown;
    timezone?: unknown;
    /** Caller's acknowledgement that this account's data will be generated. */
    allowSeeded?: unknown;
    /** Run the ingestion pipeline before responding. Off by default — see above. */
    ingestNow?: unknown;
}

function readString(body: CreateBody, key: keyof CreateBody, required: boolean): string | undefined {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
        if (required) throw ApiError.badRequest("MISSING_FIELD", `"${key}" is required.`);
        return undefined;
    }
    if (typeof value !== "string") {
        throw ApiError.badRequest("INVALID_FIELD", `"${key}" must be a string.`);
    }
    return value.trim();
}

/**
 * Require a real IANA zone identifier, not a timezone ABBREVIATION.
 *
 * Asking `Intl` whether it accepts the string is not enough, and the reason is
 * a genuine silent-corruption bug rather than pedantry. ICU resolves legacy
 * abbreviations, and it resolves them to the wrong thing:
 *
 *     "IST" → Asia/Calcutta     (right here, but only by luck)
 *     "EST" → America/Panama    ← a FIXED-OFFSET zone with no daylight saving
 *     "GMT" → UTC
 *
 * Someone typing "EST" means America/New_York, which observes DST. Panama does
 * not. The account would be accepted, every conversion would succeed, and its
 * timing heatmap would sit an hour off for eight months of the year with
 * nothing anywhere reporting a problem. `timing.ts` cannot catch it either —
 * the zone is valid, just not the one that was meant.
 *
 * So the rule is structural: an IANA identifier is `Area/Location`. Requiring
 * the slash rejects every abbreviation while still accepting aliases like
 * Asia/Kolkata — which matters, because this ICU build lists the zone
 * canonically as Asia/Calcutta and a membership check against
 * `Intl.supportedValuesOf` would reject the project's own default.
 *
 * Checked at write time: the alternative surfaces days later as a 500 from the
 * timing route, with nothing pointing back at the moment someone typed it.
 */
function assertValidTimezone(timezone: string): void {
    const reject = (reason: string) => {
        throw ApiError.badRequest("INVALID_TIMEZONE", reason, {
            expected: 'an IANA zone identifier such as "Asia/Kolkata", "Europe/London" or "America/New_York"',
        });
    };

    if (timezone === "UTC") return; // the one legitimate identifier with no slash

    if (!timezone.includes("/")) {
        reject(
            `"${timezone}" is a timezone abbreviation, not an IANA zone identifier. Abbreviations resolve ` +
                `unpredictably — "EST" resolves to America/Panama, which does not observe daylight saving — so ` +
                `the timing heatmap would be silently wrong. Use the "Area/Location" form.`,
        );
    }

    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
        reject(`"${timezone}" is not a recognised IANA timezone.`);
    }
}

accountsRouter.get(
    "/",
    route(async (_req, res) => {
        const accounts = await prisma.account.findMany({
            orderBy: [{ role: "asc" }, { personName: "asc" }, { platform: "asc" }],
            include: { _count: { select: { posts: true } } },
        });

        res.json({
            accounts: accounts.map((account) => ({
                id: account.id,
                personName: account.personName,
                role: account.role,
                platform: account.platform,
                handle: account.handle,
                displayName: account.displayName,
                followerCount: account.followerCount,
                timezone: account.timezone,
                isSynthetic: account.isSynthetic,
                postCount: account._count.posts,
                /** Whether a live pull is even possible for this platform. */
                liveAdapterAvailable: hasLiveAdapter(account.platform),
            })),
        });
    }),
);

accountsRouter.post(
    "/",
    route(async (req, res) => {
        const body = (req.body ?? {}) as CreateBody;

        const personName = readString(body, "personName", true)!;
        const handle = readString(body, "handle", true)!.replace(/^@/, "");
        const displayName = readString(body, "displayName", false) ?? personName;
        const timezone = readString(body, "timezone", false) ?? "Asia/Kolkata";

        const roleRaw = readString(body, "role", true)!.toUpperCase();
        if (!ROLES.includes(roleRaw as (typeof ROLES)[number])) {
            throw ApiError.badRequest("INVALID_FIELD", `"role" must be one of ${ROLES.join(", ")}.`);
        }
        const role = roleRaw as (typeof ROLES)[number];

        const platformRaw = readString(body, "platform", true)!.toUpperCase();
        if (!PLATFORMS.includes(platformRaw as (typeof PLATFORMS)[number])) {
            throw ApiError.badRequest("INVALID_FIELD", `"platform" must be one of ${PLATFORMS.join(", ")}.`);
        }
        const platform = platformRaw as (typeof PLATFORMS)[number];

        assertValidTimezone(timezone);

        const isSynthetic = !hasLiveAdapter(platform);

        // The acknowledgement gate. The caller is told exactly what they are
        // about to get and has to say yes, rather than discovering later that a
        // panel labelled with a real person's name is generated data.
        if (isSynthetic && body.allowSeeded !== true) {
            throw ApiError.badRequest(
                "SEEDED_NOT_ACKNOWLEDGED",
                `${platform} has no live adapter, so this account's posts would be GENERATED, not fetched. ` +
                    `Re-send with "allowSeeded": true to create it as a seeded account.`,
                { platform, livePlatforms: PLATFORMS.filter(hasLiveAdapter) },
            );
        }

        const existing = await prisma.account.findUnique({
            where: { platform_handle: { platform, handle } },
        });
        if (existing) {
            throw ApiError.conflict(
                "ACCOUNT_EXISTS",
                `@${handle} is already tracked on ${platform} (as ${existing.personName}).`,
            );
        }

        // A second principal would make every comparison ambiguous about who it
        // is comparing. Refused with the existing one named, so the caller can
        // demote it if the change is intentional.
        if (role === "PRINCIPAL") {
            const currentPrincipal = await prisma.account.findFirst({
                where: { role: "PRINCIPAL", platform },
            });
            if (currentPrincipal) {
                throw ApiError.conflict(
                    "PRINCIPAL_EXISTS",
                    `${currentPrincipal.personName} is already the principal on ${platform}. ` +
                        `Remove them first, or add this account as a COMPETITOR.`,
                );
            }
        }

        const account = await prisma.account.create({
            data: { personName, role, platform, handle, displayName, timezone, isSynthetic },
        });

        let ingestion: unknown = null;
        if (body.ingestNow === true) {
            try {
                ingestion = await ingestAccount(account.id);
            } catch (error) {
                // The account exists and the fetch failed — two separate facts,
                // and collapsing them into one error would leave the caller
                // thinking nothing was created. 201 with the failure attached.
                ingestion = { status: "failed", error: error instanceof Error ? error.message : String(error) };
            }
        }

        res.status(201).json({
            account: { ...account, liveAdapterAvailable: hasLiveAdapter(platform) },
            ingestion,
            note: isSynthetic
                ? `${platform} has no live adapter — this account's posts are generated and flagged isSynthetic.`
                : null,
        });
    }),
);

accountsRouter.delete(
    "/:id",
    route(async (req, res) => {
        const id = String(req.params["id"]);

        const account = await prisma.account.findUnique({ where: { id } });
        if (!account) throw ApiError.notFound(`No account with id ${id}.`);

        // Counted BEFORE the delete: posts and ingestion runs cascade (see the
        // schema), so afterwards there is nothing left to count. The number is
        // returned rather than swallowed because "deleted" over a silent loss of
        // 263 posts is not an honest confirmation.
        const postsRemoved = await prisma.post.count({ where: { accountId: id } });

        await prisma.account.delete({ where: { id } });

        res.json({
            deleted: {
                id: account.id,
                personName: account.personName,
                platform: account.platform,
                handle: account.handle,
                postsRemoved,
            },
        });
    }),
);
