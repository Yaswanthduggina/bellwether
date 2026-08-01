// The heatmap against a REAL timing payload, captured from the running server
// after the drawing floor was lowered to n=2.
//
// It has its own capture rather than riding on `fixtures.json` because that file
// is deliberately pinned to the superseded 940-post corpus — it is what keeps the
// SEEDED badge and the mixed-provenance tab paths under test, and those rows no
// longer exist in live data. Recapturing it wholesale to pick up three new timing
// fields would have traded real coverage for this file's convenience.
//
// So `timingLive.json` is the current corpus and `fixtures.json` is the old one,
// and between them the component is exercised against both shapes it can receive.
// The stale-payload path below is not hypothetical politeness: App.test.tsx mounts
// the whole dashboard against exactly that older response.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimingHeatmap } from "../components/TimingHeatmap";
import type { TimingAnalysis } from "../api/client";
import live from "./timingLive.json";

const analysis = live.accounts[0]!.byBasis.VIEWS as unknown as TimingAnalysis;

/** The same payload as it arrived before the server located its suppressed cells. */
function asStalePayload(a: TimingAnalysis): TimingAnalysis {
    const { minCellN, minMarginalN, suppressedSlots, ...rest } = a;
    void minCellN;
    void minMarginalN;
    void suppressedSlots;
    return rest;
}

const hatched = () => document.querySelectorAll(".heatmap .heat-cell.empty").length;
const blank = () => document.querySelectorAll(".heatmap .heat-cell.unused").length;
const drawn = () => document.querySelectorAll(".heatmap .heat-cell:not(.empty):not(.unused)").length;

describe("TimingHeatmap — a real payload at the lowered drawing floor", () => {
    it("draws all 168 cells whatever the corpus does", () => {
        render(<TimingHeatmap analysis={analysis} />);
        expect(document.querySelectorAll(".heatmap .heat-cell").length).toBe(7 * 24);
    });

    it("hatches only the cells the server actually suppressed", () => {
        // The bug this replaces: with only the surviving cells in hand, the grid
        // hatched all 155 undrawn cells, so an account posting in a narrow band
        // looked like one posting everywhere and being suppressed everywhere.
        render(<TimingHeatmap analysis={analysis} />);

        expect(analysis.suppressedSlots!.length).toBe(analysis.suppressedCells);
        expect(hatched()).toBe(analysis.suppressedCells);
        expect(drawn()).toBe(analysis.grid.length);
        expect(blank()).toBe(168 - analysis.suppressedCells - analysis.grid.length);
    });

    it("says which of the two an undrawn cell is", () => {
        render(<TimingHeatmap analysis={analysis} />);

        const slot = analysis.suppressedSlots![0]!;
        const hour = String(slot.hour).padStart(2, "0");
        const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][slot.dayOfWeek];

        expect(screen.getByTitle(new RegExp(`^${day} ${hour}:00 — ${slot.n} post`))).toBeInTheDocument();
        expect(screen.getAllByTitle(/never posted/).length).toBe(blank());
    });

    it("takes the floor from the payload rather than hardcoding it", () => {
        // The legend read "n < 3" for as long as the server suppressed at 3. It
        // now reads whatever the server actually did, which is the only version
        // a reader has no way to check for themselves.
        render(<TimingHeatmap analysis={analysis} />);

        expect(analysis.minCellN).toBe(2);
        expect(screen.getByText(/suppressed \(n<2\)/)).toBeInTheDocument();
        expect(screen.getByText(/n≥3/)).toBeInTheDocument();
    });

    it("keeps the grid's lower floor out of the marginals", () => {
        // The client-side half of the constant split: cells are drawn at n=2, and
        // no hour or day bucket beneath the citing floor came along with them.
        expect(Math.min(...analysis.grid.map((c) => c.n))).toBeGreaterThanOrEqual(2);
        expect(Math.min(...analysis.byHour.map((h) => h.n))).toBeGreaterThanOrEqual(3);
        expect(Math.min(...analysis.byDay.map((d) => d.n))).toBeGreaterThanOrEqual(3);
    });
});

describe("TimingHeatmap — a payload from before the suppressed cells were located", () => {
    it("hatches every undrawn cell rather than claiming they were never used", () => {
        // Overstating suppression is the safe direction: it never tells someone
        // they have never posted at an hour they have posted at.
        render(<TimingHeatmap analysis={asStalePayload(analysis)} />);

        expect(hatched()).toBe(168 - analysis.grid.length);
        expect(screen.queryByText(/never posted/)).not.toBeInTheDocument();
        expect(screen.getAllByTitle(/no posts, or too few to draw/).length).toBeGreaterThan(0);
    });

    it("drops the threshold from the copy rather than printing undefined", () => {
        render(<TimingHeatmap analysis={asStalePayload(analysis)} />);

        expect(document.body.textContent).not.toMatch(/undefined/);
        expect(screen.getByText(/of 168 cells/)).toBeInTheDocument();
    });
});
