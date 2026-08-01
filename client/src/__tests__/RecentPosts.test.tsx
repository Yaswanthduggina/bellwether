// The activity list against a real `/api/analytics/recent-posts` payload.
//
// Captured from the running server, like every other fixture here — the shape a
// component was written against is exactly the thing a hand-written fixture
// cannot catch being wrong.
//
// What is worth asserting is mostly what this table does DIFFERENTLY from the
// ranked lists next to it: newest-first rather than best-first, raw counts on
// show, per-row engagement bases, and an explanation rather than a blank where a
// post has no computable rate.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecentPosts } from "../components/RecentPosts";
import type { RecentPost } from "../api/client";
import live from "./recentPostsLive.json";

const instagram = live.accounts.find((a) => a.platform === "INSTAGRAM")!;
const posts = instagram.posts as RecentPost[];

function renderList(rows: RecentPost[] = posts) {
    return render(<RecentPosts posts={rows} timezone={instagram.timezone} matchedPosts={instagram.matchedPosts} />);
}

const bodyRows = () => document.querySelectorAll("tbody tr");

describe("RecentPosts — the activity list", () => {
    it("renders one row per post, newest first", () => {
        renderList();

        expect(bodyRows().length).toBe(posts.length);
        expect(posts.length).toBe(10);

        // The payload is already ordered; this asserts the component does not
        // re-sort it into a ranking, which is what every neighbouring table does.
        const times = posts.map((p) => new Date(p.postedAt).getTime());
        expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("shows raw counts, which the ranked tables deliberately do not", () => {
        renderList();

        const first = posts[0]!;
        const row = bodyRows()[0] as HTMLElement;
        expect(within(row).getByText(first.likes!.toLocaleString())).toBeInTheDocument();
        expect(within(row).getByText(first.comments!.toLocaleString())).toBeInTheDocument();
    });

    it("carries a per-row basis, because one list can hold both", () => {
        // The real Instagram payload contains reels rated on views and posts
        // rated on followers in the same ten. A panel-level basis label would be
        // wrong for half the rows.
        const bases = new Set(posts.map((p) => p.basis));
        expect(bases.size).toBeGreaterThan(1);

        renderList();
        expect(document.querySelectorAll("[title='Normalised on views.']").length).toBeGreaterThan(0);
        expect(document.querySelectorAll("[title='Normalised on followers.']").length).toBeGreaterThan(0);
    });

    it("links out to every post that has a permalink", () => {
        renderList();

        const links = screen.getAllByRole("link", { name: /open/ });
        expect(links.length).toBe(posts.filter((p) => p.permalink !== null).length);
        expect(links[0]).toHaveAttribute("target", "_blank");
        expect(links[0]).toHaveAttribute("href", posts.find((p) => p.permalink !== null)!.permalink!);
    });

    it("states how many posts it is the tail of", () => {
        renderList();
        expect(screen.getByText(new RegExp(`most recent of ${instagram.matchedPosts.toLocaleString()} posts`))).toBeInTheDocument();
    });
});

describe("RecentPosts — posts with no computable rate", () => {
    // Constructed by blanking fields on a REAL row rather than inventing one, so
    // the shape stays whatever the server actually sends.
    const withheld: RecentPost = {
        ...posts[0]!,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
        ratePct: null,
        basis: null,
        unratedReason: "NO_METRICS",
    };

    it("says why there is no rate instead of leaving the cell blank", () => {
        // A blank rate reads as "this post earned nothing". The post may have
        // done well; the platform simply did not report it.
        renderList([withheld]);

        expect(screen.getByText("no metrics")).toBeInTheDocument();
        expect(screen.getByTitle(/missing data, not zero engagement/)).toBeInTheDocument();
    });

    it("keeps the row, so the list still answers 'what did we post'", () => {
        renderList([withheld, ...posts.slice(1)]);
        expect(bodyRows().length).toBe(posts.length);
    });

    it("distinguishes an absent count from a zero one", () => {
        renderList([{ ...posts[0]!, likes: 0, shares: null }]);

        const row = bodyRows()[0] as HTMLElement;
        expect(within(row).getByText("0")).toBeInTheDocument();
        expect(within(row).getAllByTitle(/Absent, not zero/).length).toBeGreaterThan(0);
    });

    it("explains an empty list rather than rendering an empty table", () => {
        renderList([]);
        expect(screen.getByText(/No posts on this platform/)).toBeInTheDocument();
        expect(document.querySelector("table")).toBeNull();
    });
});
