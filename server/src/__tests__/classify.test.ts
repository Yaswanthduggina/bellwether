// Classification has one failure mode that matters far more than the others,
// and it is not "the model picked the wrong theme".
//
// `responseSchema` constrains SHAPE. It does not constrain COUNT or ORDER.
// Nothing stops the model returning 24 results for a 25-post batch, or
// returning them out of order. Zipping results to posts positionally — the
// obvious implementation — would then shift every subsequent label by one and
// write a whole batch of confidently wrong themes, with no error raised
// anywhere and no way to tell from the data that it happened.
//
// So the alignment logic is pure and tested here, away from the network. A
// misclassified post is a judgement this product can survive; a MISALIGNED
// batch is silent data corruption that every downstream theme figure inherits.

import { describe, expect, it } from "vitest";
import {
    indexResults,
    resolveLabel,
    CONTENT_PILLARS,
    MIN_CONFIDENCE,
    type RawLabel,
} from "../ai/classify";

const label = (index: number, theme: string, confidence = 0.9): RawLabel => ({ index, theme, confidence });

describe("indexResults — alignment, not position", () => {
    it("keys results by the index the model was given, not by arrival order", () => {
        // The model answered 2, 0, 1. A positional zip would label post 0 with
        // post 2's theme and be wrong about all three while looking fine.
        const { byIndex } = indexResults(
            [label(2, "MEDIA_APPEARANCE"), label(0, "POLICY_ANNOUNCEMENT"), label(1, "CONSTITUENCY_VISIT")],
            3,
        );

        expect(byIndex.get(0)!.theme).toBe("POLICY_ANNOUNCEMENT");
        expect(byIndex.get(1)!.theme).toBe("CONSTITUENCY_VISIT");
        expect(byIndex.get(2)!.theme).toBe("MEDIA_APPEARANCE");
    });

    it("leaves a skipped index absent rather than shifting the rest up", () => {
        // Index 1 is missing. Post 2 must still get post 2's theme.
        const { byIndex } = indexResults([label(0, "POLICY_ANNOUNCEMENT"), label(2, "ATTACK_REBUTTAL")], 3);

        expect(byIndex.has(1)).toBe(false);
        expect(byIndex.get(2)!.theme).toBe("ATTACK_REBUTTAL");
        expect(byIndex.size).toBe(2);
    });

    it("discards an index past the end of the batch", () => {
        // Writing this would either throw or, worse, silently label a post from
        // a different batch entirely.
        const { byIndex, discarded } = indexResults([label(0, "OTHER"), label(7, "POLICY_ANNOUNCEMENT")], 3);

        expect(byIndex.size).toBe(1);
        expect(discarded).toBe(1);
    });

    it("discards negative and non-integer indices", () => {
        const { byIndex, discarded } = indexResults(
            [label(-1, "OTHER"), label(1.5, "OTHER"), label(0, "PERSONAL_FAMILY")],
            3,
        );

        expect(byIndex.size).toBe(1);
        expect(byIndex.get(0)!.theme).toBe("PERSONAL_FAMILY");
        expect(discarded).toBe(2);
    });

    it("keeps the first opinion when the model contradicts itself", () => {
        // A second answer for index 0 is not a better answer. Taking the later
        // one is not more correct — but the duplicate IS counted, so systematic
        // duplication surfaces instead of hiding.
        const { byIndex, discarded } = indexResults([label(0, "POLICY_ANNOUNCEMENT"), label(0, "OTHER")], 2);

        expect(byIndex.get(0)!.theme).toBe("POLICY_ANNOUNCEMENT");
        expect(discarded).toBe(1);
    });

    it("survives a response with no results at all", () => {
        expect(indexResults(undefined, 5).byIndex.size).toBe(0);
        expect(indexResults([], 5).byIndex.size).toBe(0);
    });
});

describe("resolveLabel — what actually gets written", () => {
    it("keeps a confident label from the taxonomy", () => {
        expect(resolveLabel(label(0, "CONSTITUENCY_VISIT", 0.95))).toEqual({
            theme: "CONSTITUENCY_VISIT",
            confidence: 0.95,
            demoted: false,
        });
    });

    it(`demotes a label below ${MIN_CONFIDENCE} to OTHER but KEEPS the confidence`, () => {
        // The threshold is a display and analysis rule, not a destructive one.
        // Keeping the number means it can be re-tuned later without re-spending
        // the API budget on the whole corpus.
        const resolved = resolveLabel(label(0, "POLICY_ANNOUNCEMENT", 0.4));

        expect(resolved.theme).toBe("OTHER");
        expect(resolved.confidence).toBe(0.4);
        expect(resolved.demoted).toBe(true);
    });

    it("does not count a low-confidence OTHER as a demotion", () => {
        // It was already OTHER. Counting it would inflate the "we overrode the
        // model" figure with cases where we agreed with it.
        expect(resolveLabel(label(0, "OTHER", 0.2)).demoted).toBe(false);
    });

    it("treats the threshold as inclusive", () => {
        expect(resolveLabel(label(0, "ACHIEVEMENT_CLAIM", MIN_CONFIDENCE)).theme).toBe("ACHIEVEMENT_CLAIM");
        expect(resolveLabel(label(0, "ACHIEVEMENT_CLAIM", MIN_CONFIDENCE - 0.001)).theme).toBe("OTHER");
    });

    it("rejects a theme outside the taxonomy", () => {
        // The enum schema should make this impossible — "impossible" meaning
        // "unless someone edits the schema", which is exactly when a silent
        // invented category would slip into the gap analysis.
        expect(resolveLabel(label(0, "INFRASTRUCTURE_PROMISE", 0.99)).theme).toBe("OTHER");
    });

    it("clamps a confidence outside [0,1] instead of storing it", () => {
        expect(resolveLabel(label(0, "OTHER", 1.7)).confidence).toBe(1);
        expect(resolveLabel(label(0, "OTHER", -0.3)).confidence).toBe(0);
    });

    it("treats a non-numeric confidence as no confidence", () => {
        // NaN would compare false against every threshold and slip through as a
        // trusted label. Zero is the honest reading of "the model did not say".
        const resolved = resolveLabel({ index: 0, theme: "POLICY_ANNOUNCEMENT", confidence: Number.NaN });

        expect(resolved.confidence).toBe(0);
        expect(resolved.theme).toBe("OTHER");
    });
});

describe("the taxonomy is fixed", () => {
    it("contains exactly the eight pillars the schema and the database agree on", () => {
        // Prisma's ContentPillar enum, the responseSchema enum and the gap
        // analysis all have to name the same eight. This pins the list so
        // adding a ninth in one place fails here rather than in production.
        expect([...CONTENT_PILLARS].sort()).toEqual([
            "ACHIEVEMENT_CLAIM",
            "ATTACK_REBUTTAL",
            "CONSTITUENCY_VISIT",
            "FESTIVAL_GREETING",
            "MEDIA_APPEARANCE",
            "OTHER",
            "PERSONAL_FAMILY",
            "POLICY_ANNOUNCEMENT",
        ]);
    });

    it("includes OTHER, which the confidence floor depends on existing", () => {
        expect(CONTENT_PILLARS).toContain("OTHER");
    });
});
