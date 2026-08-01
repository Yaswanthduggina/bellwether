// Does the portal actually render the real API's output?
//
// The fixtures are CAPTURED FROM THE RUNNING SERVER against the real 940-post
// corpus, not hand-written. A hand-written fixture tests the component against
// the shape its author believed the API had, which is precisely the bug this
// file exists to catch — a renamed field, a null where an object was expected,
// a platform with no computable basis. `fixtures.json` is refreshed by hitting
// the endpoints; if the API's shape moves, these tests fail.
//
// The recommendations endpoint is fixtured as its 503 NO_API_KEY response,
// which is the state a reviewer cloning this repo without a Gemini key will
// actually see. That path has to degrade to a readable explanation rather than
// an empty panel, and it is asserted here for that reason.

import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import fixtures from "./fixtures.json";
// A second capture, from the current corpus — `fixtures.json` predates the route.
// See client/README.md for why the two vintages coexist.
import recentPosts from "./recentPostsLive.json";

const NO_KEY = {
    error: {
        code: "NO_API_KEY",
        message: "No Gemini API key is configured, so recommendations cannot be generated.",
    },
};

function mockFetch(overrides: Record<string, { status: number; body: unknown }> = {}) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const path = url.split("?")[0]!;

        for (const [fragment, response] of Object.entries(overrides)) {
            if (path.includes(fragment)) {
                return new Response(JSON.stringify(response.body), {
                    status: response.status,
                    headers: { "content-type": "application/json" },
                });
            }
        }

        const table: Record<string, unknown> = {
            "/api/health": fixtures.health,
            "/api/accounts": fixtures.accounts,
            "/api/analytics/overview": fixtures.overview,
            "/api/analytics/report": fixtures.report,
            "/api/analytics/timing": fixtures.timing,
            "/api/analytics/recent-posts": recentPosts,
            "/api/ai/recommendations": NO_KEY,
        };

        const body = table[path];
        if (body === undefined) throw new Error(`unmocked request: ${url}`);

        return new Response(JSON.stringify(body), {
            status: path === "/api/ai/recommendations" ? 503 : 200,
            headers: { "content-type": "application/json" },
        });
    });
}

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
    localStorage.clear();
});

describe("the dashboard renders the real corpus", () => {
    it("shows the KPI row with figures from the API", async () => {
        render(<App />);

        // 940 posts, 16 accounts — the actual database, not a guess. Queried
        // within the KPI tile so a matching figure elsewhere on the page cannot
        // make this pass by accident.
        const posts = await screen.findByText("Posts");
        const tile = posts.parentElement!;
        expect(within(tile).getByText(fixtures.overview.totalPosts.toLocaleString())).toBeInTheDocument();

        const accounts = screen.getByText("Accounts", { selector: ".label" }).parentElement!;
        expect(within(accounts).getByText(String(fixtures.overview.accounts))).toBeInTheDocument();
    });

    it("puts recommendations above the analytics, not below", async () => {
        // The brief is explicit that question 4 is the product. Asserted as
        // document order so a later layout change cannot quietly demote it.
        render(<App />);
        await screen.findByText(/Format performance/);

        const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
        expect(headings.indexOf("Recommendations")).toBeGreaterThanOrEqual(0);
        expect(headings.indexOf("Recommendations")).toBeLessThan(headings.indexOf("Format performance"));
    });

    it("renders one tab per platform, each carrying its provenance", async () => {
        render(<App />);

        const tabs = await screen.findAllByRole("tab");
        expect(tabs.map((t) => t.textContent)).toEqual(
            expect.arrayContaining(fixtures.report.platforms.map((p) => expect.stringContaining(p.platform))),
        );

        // YouTube is mixed provenance — three tracked people have a live channel
        // and the fourth does not. A platform-level "live" rollup would be a lie
        // about a quarter of its rows.
        const youtube = tabs.find((t) => t.textContent?.includes("YOUTUBE"));
        expect(youtube?.textContent).toMatch(/Mixed/);
    });

    it("renders the format table with the API's own medians", async () => {
        render(<App />);
        await screen.findByText(/Format performance/);

        const first = fixtures.report.platforms[0]!.bases[0]!.formats[0]!;
        // The rate appears in the table and again as a bar label, so both are
        // acceptable — what matters is that the API's own figure reached the DOM.
        expect((await screen.findAllByText(`${first.medianRatePct.toFixed(2)}%`)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(`${first.n}`).length).toBeGreaterThan(0);
    });

    it("draws the timing heatmap and states what it suppressed", async () => {
        render(<App />);
        await screen.findByRole("heading", { name: "Timing", level: 2 });

        // 168 cells minus the ones with too few posts. The count is on screen
        // because a heatmap with two visible cells is itself a finding.
        expect(await screen.findByText(/of 168 cells/)).toBeInTheDocument();
        // The grid itself is drawn, suppressed cells included as hatching.
        expect(document.querySelectorAll(".heatmap .heat-cell").length).toBe(7 * 24);
    });

    it("shows the recent-posts panel, and degrades to a sentence off-platform", async () => {
        render(<App />);

        expect(await screen.findByRole("heading", { name: "Recent posts", level: 2 })).toBeInTheDocument();

        // The two fixtures are different vintages on purpose: the report still
        // carries FACEBOOK, which the current corpus no longer has, so the
        // default tab exercises the "no account on this platform" branch. That
        // it renders a sentence rather than an empty table or a crash is the
        // property worth pinning — the populated table is covered against a real
        // payload in RecentPosts.test.tsx.
        const tab = fixtures.report.platforms[0]!.platform;
        const served = recentPosts.accounts.some((a) => a.platform === tab);
        expect(served).toBe(false);
        expect(await screen.findByText(new RegExp(`no ${tab} account`))).toBeInTheDocument();
    });

    it("shows the comparison sentence the server composed", async () => {
        render(<App />);

        const sentence = fixtures.report.platforms[0]!.bases[0]!.comparisonSentence;
        expect(await screen.findByText(sentence)).toBeInTheDocument();
    });
});

describe("degraded states are explained, not blank", () => {
    it("explains a missing API key instead of showing an empty panel", async () => {
        render(<App />);

        expect(await screen.findByText(/The AI layer is unavailable/)).toBeInTheDocument();
        // The important half: the analytics still work and the user is told so.
        expect(screen.getByText(/analytics below are unaffected/)).toBeInTheDocument();
        // And the panel is still there rather than being dropped.
        expect(screen.getByRole("heading", { name: "Recommendations", level: 2 })).toBeInTheDocument();
    });

    it("says the API is unreachable rather than rendering an empty dashboard", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );

        render(<App />);
        // Both the health banner and the analytics panel say so — either is
        // fine, silence is not.
        expect((await screen.findAllByText(/Cannot reach the API/)).length).toBeGreaterThan(0);
        expect(screen.getByText(/The API is not reachable/)).toBeInTheDocument();
    });

    it("renders validated recommendations when the key is present", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                "/api/ai/recommendations": {
                    status: 200,
                    body: {
                        generatedAt: "2026-07-31T06:00:00.000Z",
                        model: "gemini-3.6-flash",
                        recommendations: [
                            {
                                action: "Move two weekly reels into the 20:00 slot.",
                                rationale: "Peers earn 1.72× their own median at 20:00 across 41 posts.",
                                platform: "YOUTUBE",
                                dimension: "HOUR",
                                postIds: [],
                                figures: [1.72, 41],
                                sampleSize: 41,
                                confidence: "HIGH",
                                priority: 1,
                            },
                        ],
                        dropped: [
                            {
                                recommendation: { action: "Post more carousels." },
                                violations: [{ code: "UNVERIFIED_NUMBER", message: "The number 9.9 is not in the report." }],
                                retried: true,
                            },
                        ],
                        repaired: 1,
                        generated: 2,
                        citedPosts: {},
                        evidence: { numbers: 215, postIds: 37 },
                        notes: [],
                        usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 1 },
                        limits: { maxRecommendations: 6, minSampleSize: 5 },
                    },
                },
            }),
        );

        render(<App />);

        expect(await screen.findByText("Move two weekly reels into the 20:00 slot.")).toBeInTheDocument();

        // The drop count is on screen. A pipeline that silently discards half its
        // output looks identical from outside to one that never generated it.
        const footer = screen.getByText("dropped").closest(".chip") as HTMLElement;
        expect(within(footer).getByText("1")).toBeInTheDocument();
    });
});

describe("the accounts page", () => {
    it("lists tracked accounts and flags the seeded ones", async () => {
        const user = (await import("@testing-library/user-event")).default;
        render(<App />);

        await user.click(await screen.findByRole("button", { name: "Accounts" }));

        await waitFor(() => expect(screen.getByText("Tracked accounts")).toBeInTheDocument());

        // The same person appears once per platform they are tracked on, which
        // is the point of the model — so this counts rows rather than asserting
        // a unique match.
        const seeded = fixtures.accounts.accounts.filter((a) => a.isSynthetic);
        expect(screen.getAllByText("Seeded").length).toBe(seeded.length);

        const rows = screen.getAllByText(fixtures.accounts.accounts[0]!.personName);
        expect(rows.length).toBe(
            fixtures.accounts.accounts.filter((a) => a.personName === fixtures.accounts.accounts[0]!.personName).length,
        );
    });
});
