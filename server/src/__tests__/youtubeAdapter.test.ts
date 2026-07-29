// Pure helpers only — no network. The API call path is exercised for real by the
// seed script; what is worth pinning here is the classification logic, because a
// Short misfiled as long-form silently corrupts the format analysis that Question 1
// depends on.

import { describe, expect, it } from "vitest";
import { classifyVideo, parseDuration } from "../adapters/youtubeAdapter";

describe("parseDuration", () => {
    it("parses the ISO 8601 shapes YouTube actually returns", () => {
        expect(parseDuration("PT45S")).toBe(45);
        expect(parseDuration("PT4M13S")).toBe(253);
        expect(parseDuration("PT1H2M3S")).toBe(3723);
        expect(parseDuration("PT2M")).toBe(120);
        expect(parseDuration("PT1H")).toBe(3600);
    });

    it("handles multi-day livestream durations", () => {
        expect(parseDuration("P1DT2H")).toBe(93_600);
    });

    it("returns null rather than 0 for absent or malformed input", () => {
        // 0 would classify as a Short. Null keeps the caller's fallback in charge.
        expect(parseDuration(undefined)).toBeNull();
        expect(parseDuration("")).toBeNull();
        expect(parseDuration("4 minutes")).toBeNull();
    });
});

describe("classifyVideo", () => {
    const video = (duration?: string, live = false) => ({
        id: "v",
        contentDetails: duration ? { duration } : undefined,
        ...(live ? { liveStreamingDetails: {} } : {}),
    });

    it("treats 3 minutes or less as a Short", () => {
        expect(classifyVideo(video("PT30S"))).toBe("REEL_SHORT_VIDEO");
        expect(classifyVideo(video("PT3M"))).toBe("REEL_SHORT_VIDEO");
    });

    it("treats anything longer as long-form", () => {
        expect(classifyVideo(video("PT3M1S"))).toBe("LONG_FORM_VIDEO");
        expect(classifyVideo(video("PT22M"))).toBe("LONG_FORM_VIDEO");
    });

    it("classifies a livestream as LIVE regardless of length", () => {
        // A stream is a different format with different engagement dynamics, so the
        // live signal wins over the duration heuristic.
        expect(classifyVideo(video("PT45S", true))).toBe("LIVE");
        expect(classifyVideo(video("PT3H", true))).toBe("LIVE");
    });

    it("falls back to long-form when duration is missing", () => {
        // Safer than the alternative: mislabelling an unknown as a Short would
        // inflate the Shorts bucket, which is the one the recommendations lean on.
        expect(classifyVideo(video())).toBe("LONG_FORM_VIDEO");
    });
});
