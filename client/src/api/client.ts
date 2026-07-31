// The REST client. Plain fetch, no data-fetching library.
//
// The whole surface is a dozen GETs and three writes against an API this repo
// also owns, so a cache layer would be configuration without a problem to
// solve. What DOES need care is error shape: the server distinguishes "you
// filtered too narrowly" (404) from "no API key is configured" (503) from "the
// analytics layer refused to average two engagement bases" (500), and a UI that
// renders all three as "something went wrong" hides the difference from the
// person best placed to act on it. So the code travels with the error.

/** Mirrors the server's `{ error: { code, message, detail } }` envelope. */
export class ApiError extends Error {
    // Declared as fields rather than constructor parameter properties: the
    // scaffold enables `erasableSyntaxOnly`, so the shorthand is a compile
    // error. Kept that way rather than relaxing the flag — type syntax that
    // emits runtime code is exactly what the flag is there to prevent.
    readonly status: number;
    readonly code: string;
    readonly detail: unknown;

    constructor(status: number, code: string, message: string, detail?: unknown) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.detail = detail;
    }

    /** The AI layer is unconfigured or out of quota — degraded, not broken. */
    get isAiUnavailable(): boolean {
        return this.code === "NO_API_KEY" || this.code === "QUOTA_EXHAUSTED";
    }
}

async function get<T>(path: string, filter?: Filter): Promise<T> {
    const query = filter ? toQuery(filter) : "";
    return request<T>(`${path}${query}`, { method: "GET" });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            ...init,
            headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        });
    } catch {
        // A dead server and a 500 look nothing alike to the person fixing it.
        throw new ApiError(
            0,
            "UNREACHABLE",
            "Cannot reach the API. Start it with `cd server && npm run dev` — it should be on http://localhost:4000.",
        );
    }

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
        const envelope = (body as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
        throw new ApiError(
            response.status,
            envelope?.code ?? "UNKNOWN",
            envelope?.message ?? `${response.status} ${response.statusText}`,
            envelope?.detail,
        );
    }

    return body as T;
}

// ── Filters (FR16) ───────────────────────────────────────────────────────

export interface Filter {
    platform?: string;
    mediaType?: string;
    theme?: string;
    personName?: string;
    accountId?: string;
    from?: string;
    to?: string;
    liveOnly?: boolean;
}

/**
 * Empty values are OMITTED, not sent blank.
 *
 * The server rejects unknown filters and validates every known one, so sending
 * `?platform=` would be a 400 the moment a select is cleared. Dropping empties
 * here means "no filter" and "all platforms" are the same request, which is
 * what a cleared dropdown means to the person who cleared it.
 */
export function toQuery(filter: Filter): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
        if (value === undefined || value === null || value === "" || value === false) continue;
        params.set(key, String(value));
    }
    const query = params.toString();
    return query === "" ? "" : `?${query}`;
}

// ── Types the UI consumes ────────────────────────────────────────────────
// Mirrors of the server's response shapes, narrowed to what is rendered.

export type Platform = "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";
export type Provenance = "LIVE" | "SEEDED" | "MIXED";

export interface Health {
    status: string;
    database: string;
    accounts?: number;
    posts?: number;
    message?: string;
}

export interface Account {
    id: string;
    personName: string;
    role: "PRINCIPAL" | "COMPETITOR";
    platform: Platform;
    handle: string;
    displayName: string | null;
    followerCount: number | null;
    timezone: string;
    isSynthetic: boolean;
    postCount: number;
    liveAdapterAvailable: boolean;
}

export interface Overview {
    accounts: number;
    people: number;
    principalName: string | null;
    totalPosts: number;
    principalPosts: number;
    ratedPosts: number;
    unratedPosts: number;
    provenance: { livePosts: number; seededPosts: number; seededPct: number; seededAccounts: string[] };
    classification: { classified: number; unclassified: number; complete: boolean };
    cadence: { principalPostsPerWeek: number; peerMedianPostsPerWeek: number | null; sentence: string } | null;
    platforms: Platform[];
}

export interface ReportFormat {
    mediaType: string;
    n: number;
    medianRatePct: number;
    multipleOfOverall: number;
    outlierDriven: boolean;
}

export interface ReportHour {
    hour: number;
    label: string;
    n: number;
    multipleOfOverall: number;
}

export interface ReportPost {
    id: string;
    postedAt: string;
    mediaType: string;
    ratePct: number;
    multipleOfMedian: number;
    permalink: string | null;
    isSynthetic: boolean;
    captionExcerpt: string | null;
}

export interface ReportGap {
    dimension: string;
    label: string;
    kind: string;
    peerLift: number;
    peerAgreement: string;
    principalN: number;
    opportunity: number;
    sentence: string;
    provenanceCaveat: string | null;
}

export interface ReportBasis {
    basis: "VIEWS" | "FOLLOWERS";
    denominator: string;
    principalRatedPosts: number;
    principalMedianRatePct: number;
    formats: ReportFormat[];
    bestHours: ReportHour[];
    timezone: string;
    suppressedCells: number;
    rank: { position: number; outOf: number } | null;
    peerBenchmarkRatePct: number | null;
    principalVsPeers: number | null;
    comparisonSentence: string;
    peerWindows: { personName: string; label: string; n: number; multipleOfOverall: number }[];
    gaps: ReportGap[];
    overInvested: { label: string; n: number; shareOfOutputPct: number; lift: number; sentence: string }[];
    bestPosts: ReportPost[];
    worstPosts: ReportPost[];
}

export interface ReportPlatform {
    platform: Platform;
    totalPosts: number;
    provenance: Provenance;
    seededAccounts: string[];
    cadence: {
        principalPostsPerWeek: number | null;
        peerMedianPostsPerWeek: number | null;
        principalVsPeers: number | null;
        principalConsistencyPct: number | null;
        peerConsistencyPct: number | null;
        principalLongestSilenceDays: number | null;
        sentence: string;
    } | null;
    formatMixDivergences: { mediaType: string; principalSharePct: number; peerSharePct: number }[];
    bases: ReportBasis[];
}

export interface Report {
    generatedAt: string;
    principalName: string | null;
    peerNames: string[];
    window: { from: string; to: string; days: number } | null;
    corpusProvenance: { totalPosts: number; livePosts: number; seededPosts: number; seededPct: number };
    platforms: ReportPlatform[];
    notes: string[];
    truncations: string[];
}

export interface TimingBucket {
    n: number;
    confidence: "OK" | "LOW";
    headline: number;
    multipleOfOverall: number;
}

export interface TimingAnalysis {
    basis: "VIEWS" | "FOLLOWERS";
    timezone: string;
    grid: (TimingBucket & { dayOfWeek: number; hour: number })[];
    byHour: (TimingBucket & { hour: number })[];
    byDay: (TimingBucket & { dayOfWeek: number })[];
    ratedPosts: number;
    suppressedCells: number;
    suppressedPosts: number;
}

export interface TimingResponse {
    accounts: {
        accountId: string;
        personName: string;
        platform: Platform;
        timezone: string;
        isSynthetic: boolean;
        byBasis: Record<string, TimingAnalysis | null>;
    }[];
}

export interface Recommendation {
    action: string;
    rationale: string;
    platform: string;
    dimension: string;
    postIds: string[];
    figures: number[];
    sampleSize: number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    priority: number;
}

export interface RecommendationRun {
    generatedAt: string;
    model: string;
    recommendations: Recommendation[];
    dropped: { recommendation: Recommendation; violations: { code: string; message: string }[]; retried: boolean }[];
    repaired: number;
    generated: number;
    citedPosts: Record<string, ReportPost>;
    evidence: { numbers: number; postIds: number };
    notes: string[];
    usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
    limits: { maxRecommendations: number; minSampleSize: number };
}

export interface ClassificationStatus {
    total: number;
    classified: number;
    unclassified: number;
    lowConfidence: number;
    distribution: Record<string, number>;
    model: string;
    apiKeyConfigured: boolean;
    complete: boolean;
}

export interface NewAccount {
    personName: string;
    role: string;
    platform: string;
    handle: string;
    displayName?: string;
    timezone?: string;
    allowNoSource?: boolean;
    ingestNow?: boolean;
}

// ── The calls ────────────────────────────────────────────────────────────

export const api = {
    health: () => get<Health>("/api/health"),

    accounts: () => get<{ accounts: Account[] }>("/api/accounts"),
    createAccount: (body: NewAccount) =>
        request<{ account: Account; note: string | null }>("/api/accounts", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    deleteAccount: (id: string) =>
        request<{ deleted: { personName: string; platform: string; postsRemoved: number } }>(
            `/api/accounts/${encodeURIComponent(id)}`,
            { method: "DELETE" },
        ),

    overview: (filter: Filter) => get<Overview>("/api/analytics/overview", filter),
    report: (filter: Filter) => get<Report>("/api/analytics/report", filter),
    timing: (filter: Filter) => get<TimingResponse>("/api/analytics/timing", filter),

    recommendations: (filter: Filter) => get<RecommendationRun>("/api/ai/recommendations", filter),
    classification: () => get<ClassificationStatus>("/api/ai/classify"),
};
