// Integration: the pipeline against a real Postgres.
//
// FR15 (re-ingesting must update, not duplicate) is enforced by a unique
// constraint in the database, so it cannot be proven with a mock — a fake would
// only test that the mock was written correctly. These write real rows under a
// throwaway handle and delete them afterwards.
//
// The adapter is injected rather than looked up, which is why ingestAccount takes
// an override: the test controls exactly what the "source" returns, including the
// malformed rows a real API would occasionally hand back.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RawAccountMeta, RawPost, SocialAdapter } from "../adapters/types";
import { prisma } from "../db";
import { ingestAccount } from "../ingestion/pipeline";

// Namespaced so a failed run cannot collide with the demo roster or a later run.
const TEST_HANDLE = "__vitest_pipeline__";

function post(overrides: Partial<RawPost> = {}): RawPost {
    return {
        platform: "INSTAGRAM",
        accountHandle: TEST_HANDLE,
        postId: "t1",
        postedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        mediaType: "CAROUSEL",
        caption: "test caption",
        permalink: null,
        metrics: { likes: 100, comments: 10, shares: null, views: null, saves: 4 },
        isSynthetic: true,
        ...overrides,
    };
}

/** An adapter whose output the test dictates exactly. */
function fakeAdapter(posts: RawPost[], followerCount: number | null = 50_000): SocialAdapter {
    return {
        platform: "INSTAGRAM",
        source: "test_fake",
        async fetchAccountMeta(handle: string): Promise<RawAccountMeta> {
            return { platform: "INSTAGRAM", accountHandle: handle, displayName: "fake", followerCount, isSynthetic: true };
        },
        async fetchPosts(): Promise<RawPost[]> {
            return posts;
        },
    };
}

let accountId: string;

async function freshAccount(): Promise<string> {
    await prisma.account.deleteMany({ where: { handle: TEST_HANDLE } });
    const account = await prisma.account.create({
        data: {
            personName: "Vitest Subject",
            role: "COMPETITOR",
            platform: "INSTAGRAM",
            handle: TEST_HANDLE,
            displayName: "Vitest Subject",
            isSynthetic: true,
        },
    });
    return account.id;
}

beforeAll(async () => {
    accountId = await freshAccount();
});

afterAll(async () => {
    // Cascade removes posts and runs with the account.
    await prisma.account.deleteMany({ where: { handle: TEST_HANDLE } });
    await prisma.$disconnect();
});

describe("ingestAccount", () => {
    it("writes normalised rows and closes out a run", async () => {
        const result = await ingestAccount(accountId, {
            adapter: fakeAdapter([post({ postId: "a" }), post({ postId: "b" })]),
        });

        expect(result.rowsFetched).toBe(2);
        expect(result.rowsFailed).toBe(0);
        expect(result.status).toBe("success");
        expect(result.source).toBe("test_fake");

        const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: result.runId } });
        expect(run.finishedAt).not.toBeNull();
        expect(run.source).toBe("test_fake");
    });

    it("refreshes the follower count but leaves displayName alone", async () => {
        // followerCount is the engagement-rate denominator and belongs to the source.
        // displayName is a label the user set in the UI, and a source should not
        // overwrite a person's name with whatever an API happens to call them.
        await ingestAccount(accountId, { adapter: fakeAdapter([post()], 987_654) });

        const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.followerCount).toBe(987_654);
        expect(account.displayName).toBe("Vitest Subject");
    });

    it("leaves a stored follower count untouched when the source reports none", async () => {
        await ingestAccount(accountId, { adapter: fakeAdapter([post()], null) });

        const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.followerCount).toBe(987_654);
    });

    it("counts malformed rows as failed without losing the good ones", async () => {
        const result = await ingestAccount(accountId, {
            adapter: fakeAdapter([
                post({ postId: "ok-1" }),
                post({ postId: "" }), // no idempotency key
                post({ postId: "bad-date", postedAt: "not a date" }),
                post({ postId: "ok-2" }),
            ]),
        });

        expect(result.rowsFetched).toBe(2);
        expect(result.rowsFailed).toBe(2);
        expect(result.status).toBe("partial"); // not "success" — the run lost rows

        const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: result.runId } });
        expect(run.errorNote).toMatch(/unparseable|empty/);
    });

    it("records a failed run rather than leaving it open when a source throws", async () => {
        const exploding: SocialAdapter = {
            platform: "INSTAGRAM",
            source: "test_exploding",
            async fetchAccountMeta() {
                throw new Error("upstream is on fire");
            },
            async fetchPosts() {
                return [];
            },
        };

        await expect(ingestAccount(accountId, { adapter: exploding })).rejects.toThrow(/on fire/);

        const run = await prisma.ingestionRun.findFirstOrThrow({
            where: { accountId, source: "test_exploding" },
            orderBy: { startedAt: "desc" },
        });
        expect(run.status).toBe("failed");
        expect(run.finishedAt).not.toBeNull();
        expect(run.errorNote).toMatch(/on fire/);
    });

    it("rejects rows belonging to another platform", async () => {
        // The unique key is (platform, postId), so a mislabelled row would collide
        // with a genuine post from the platform it claims and overwrite it.
        const wrong = fakeAdapter([post({ platform: "YOUTUBE", postId: "intruder" })]);
        await expect(ingestAccount(accountId, { adapter: wrong })).rejects.toThrow(/platform other than/);
    });
});

describe("FR15 — incremental refresh", () => {
    it("updates existing posts instead of duplicating them", async () => {
        const id = await freshAccount();
        const batch = [post({ postId: "x1" }), post({ postId: "x2" }), post({ postId: "x3" })];

        await ingestAccount(id, { adapter: fakeAdapter(batch) });
        const afterFirst = await prisma.post.count({ where: { accountId: id } });

        await ingestAccount(id, { adapter: fakeAdapter(batch) });
        const afterSecond = await prisma.post.count({ where: { accountId: id } });

        expect(afterFirst).toBe(3);
        expect(afterSecond).toBe(3);
    });

    it("refreshes changed metrics on re-ingest", async () => {
        const id = await freshAccount();

        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "m1", metrics: { likes: 10, comments: 1, shares: null, views: null, saves: null } })]) });
        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "m1", metrics: { likes: 999, comments: 42, shares: null, views: null, saves: null } })]) });

        const stored = await prisma.post.findFirstOrThrow({ where: { accountId: id, postId: "m1" } });
        expect(stored.likes).toBe(999);
        expect(stored.comments).toBe(42);
    });

    it("preserves AI classification across a re-ingest", async () => {
        // theme and themeConfidence are owned by Module D, not by the source. If a
        // refresh wiped them, every re-ingest would force the whole corpus to be
        // re-classified — and re-paid for.
        const id = await freshAccount();
        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "c1" })]) });

        await prisma.post.updateMany({
            where: { accountId: id, postId: "c1" },
            data: { theme: "POLICY_ANNOUNCEMENT", themeConfidence: 0.87 },
        });

        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "c1" })]) });

        const stored = await prisma.post.findFirstOrThrow({ where: { accountId: id, postId: "c1" } });
        expect(stored.theme).toBe("POLICY_ANNOUNCEMENT");
        expect(stored.themeConfidence).toBe(0.87);
    });

    it("writes one audit row per attempt", async () => {
        const id = await freshAccount();
        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "r1" })]) });
        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "r1" })]) });

        expect(await prisma.ingestionRun.count({ where: { accountId: id } })).toBe(2);
    });
});

describe("FR1 — removing an account", () => {
    it("cascades to posts and ingestion runs", async () => {
        // Prisma's default is onDelete: Restrict, which would make "remove this
        // account" fail with a foreign-key error the moment it had any posts.
        const id = await freshAccount();
        await ingestAccount(id, { adapter: fakeAdapter([post({ postId: "d1" }), post({ postId: "d2" })]) });

        await prisma.account.delete({ where: { id } });

        expect(await prisma.post.count({ where: { accountId: id } })).toBe(0);
        expect(await prisma.ingestionRun.count({ where: { accountId: id } })).toBe(0);
    });
});
