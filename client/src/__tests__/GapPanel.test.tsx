// The gap panel, against the report fixture.
//
// The assertions here are mostly about a distinction that is easy to render away
// and expensive to get wrong: a GAP is a finding, a NEAR MISS is the evidence
// behind a refusal, and the second must never read as the first. The analysis
// layer already refuses to promote one to the other; this file pins that the UI
// does not undo it by giving them the same affordances.
//
// The rest covers the thing this panel used to do badly. On a real corpus the
// gates reject nearly everything, and the panel's previous behaviour was a single
// grey line above a table about a different question — indistinguishable, to a
// reader, from the analysis not having run.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GapPanel } from "../components/GapPanel";
import type { ReportBasis } from "../api/client";
import fixtures from "./fixtures.json";

const platforms = fixtures.report.platforms as unknown as { platform: string; bases: ReportBasis[] }[];

const basisFor = (platform: string, basis: string): ReportBasis =>
    platforms.find((p) => p.platform === platform)!.bases.find((b) => b.basis === basis)!;

/** Has gaps AND per-peer evidence, with a mix of clearing and non-clearing peers. */
const withGaps = basisFor("YOUTUBE", "VIEWS");
/** No gaps at all — the case the near-miss section exists for. */
const withoutGaps = basisFor("INSTAGRAM", "FOLLOWERS");
/** A gap resting on exactly one clearing peer. */
const soloPeerGap = basisFor("INSTAGRAM", "VIEWS");

describe("GapPanel — findings", () => {
    it("names the peers a finding rests on, not just the count that agreed", () => {
        // "2 of 3 peers agree" was previously unverifiable in the UI: the analysis
        // computed the per-peer lifts and the projection dropped them. A reader
        // deciding whether to move a posting slot is entitled to the names.
        render(<GapPanel basis={withGaps} />);

        const gap = withGaps.gaps[0]!;
        expect(gap.peers.length).toBeGreaterThan(1);

        for (const peer of gap.peers) {
            expect(screen.getByText(new RegExp(`${peer.personName}\\s+${peer.lift.toFixed(2)}`))).toBeInTheDocument();
        }
    });

    it("marks which peers cleared the bar on their own and which did not", () => {
        // The agreement gate is about individual peers clearing 1.2×, not about
        // the median. A row that showed every peer identically would hide the
        // distinction the gate is built on.
        render(<GapPanel basis={withGaps} />);

        const gap = withGaps.gaps[0]!;
        const clearing = gap.peers.filter((p) => p.clears);
        const notClearing = gap.peers.filter((p) => !p.clears);

        expect(clearing.length).toBeGreaterThan(0);
        expect(notClearing.length).toBeGreaterThan(0);

        expect(screen.getByTitle(new RegExp(`${clearing[0]!.personName} clears the bar`))).toBeInTheDocument();
        expect(
            screen.getByTitle(new RegExp(`${notClearing[0]!.personName} does not clear the bar`)),
        ).toBeInTheDocument();
    });

    it("keeps the provenance caveat attached to the finding it qualifies", () => {
        render(<GapPanel basis={withGaps} />);
        expect(screen.getByText(/Mixes live and seeded peers/)).toBeInTheDocument();
    });

    it("flags a gap that rests on a single competitor", () => {
        // The peer floor is 1, so this is now a reportable finding where it used
        // to be refused — on the argument that one account's strong bucket can be
        // that account's habit rather than a pattern. The argument still holds;
        // it is carried by a visible flag instead of by suppression, and a reader
        // must not have to open the evidence row to notice.
        render(<GapPanel basis={soloPeerGap} />);

        const gap = soloPeerGap.gaps[0]!;
        expect(gap.peers.filter((p) => p.clears)).toHaveLength(1);
        expect(screen.getByText("ONE PEER")).toBeInTheDocument();
    });

    it("does not flag a gap that two competitors independently back", () => {
        // The flag has to distinguish, or it is decoration.
        render(<GapPanel basis={withGaps} />);

        expect(withGaps.gaps[0]!.peers.filter((p) => p.clears).length).toBeGreaterThan(1);
        expect(screen.queryByText("ONE PEER")).toBeNull();
    });
});

describe("GapPanel — near misses", () => {
    it("does not leave the panel blank when nothing clears the bar", () => {
        // The whole reason this section exists.
        render(<GapPanel basis={withoutGaps} />);

        expect(withoutGaps.gaps).toHaveLength(0);
        expect(screen.getByText(/Considered, did not clear the bar/)).toBeInTheDocument();

        for (const miss of withoutGaps.nearMisses) {
            expect(screen.getByText(miss.whatWouldChangeIt)).toBeInTheDocument();
        }
    });

    it("says how many candidates came close, rather than only that none passed", () => {
        render(<GapPanel basis={withoutGaps} />);
        expect(screen.getByText(/3 buckets came close enough to name/)).toBeInTheDocument();
    });

    it("labels each rejection with the gate that stopped it", () => {
        // Naming the gate is what makes a rejection legible. "Rejected" is not
        // something a reader can reason about; "only one peer has data" is.
        render(<GapPanel basis={withoutGaps} />);

        expect(screen.getByText("Peers disagree")).toBeInTheDocument();
        expect(screen.getByText("Only one peer has data")).toBeInTheDocument();
        expect(screen.getByText("He already matches them")).toBeInTheDocument();
    });

    it("states in the copy that near misses are not findings", () => {
        // The one guardrail that cannot be expressed as layout. A reader
        // skim-reading this section must not come away with three extra findings.
        render(<GapPanel basis={withoutGaps} />);
        expect(screen.getByText(/These are not findings/)).toBeInTheDocument();
    });

    it("does not render a near miss into the findings table", () => {
        // The structural half of the same guarantee: gaps are a table, near
        // misses are not, so a near miss cannot be read off as a ranked finding.
        render(<GapPanel basis={withoutGaps} />);

        expect(document.querySelectorAll("tbody tr").length).toBe(withoutGaps.overInvested.length);
        // And no opportunity multiple — the affordance that makes a gap look
        // actionable is deliberately withheld.
        const section = screen.getByText(/Considered, did not clear the bar/).parentElement!;
        expect(within(section).queryByText(/opportunity/i)).toBeNull();
    });

    it("still carries the timing caveat when only near misses are about timing", () => {
        // A reader who sees an hour bucket named here must get the same warning
        // they would get for an hour GAP: his own corpus cannot produce it.
        render(<GapPanel basis={withoutGaps} />);

        expect(withoutGaps.nearMisses.some((m) => m.dimension === "HOUR")).toBe(true);
        expect(screen.getByText(/Timing findings can only come from here/)).toBeInTheDocument();
    });
});

describe("GapPanel — search coverage", () => {
    it("separates a dimension that found nothing from one that could test nothing", () => {
        // Without this, THEME before classification completes looks exactly like
        // THEME after it ran and found nothing — opposite meanings.
        render(<GapPanel basis={withoutGaps} />);

        const theme = withoutGaps.gapCoverage.find((c) => c.dimension === "THEME")!;
        expect(theme.bucketsTestable).toBe(0);

        const row = screen.getByText("THEME").parentElement!;
        expect(within(row).getByText(`${theme.bucketsTestable}/${theme.bucketsConsidered}`)).toBeInTheDocument();
        expect(screen.getByText(/not findings of absence/)).toBeInTheDocument();
    });
});
