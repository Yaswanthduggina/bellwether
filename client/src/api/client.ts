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

async function get<T>(path: string, query?: Query): Promise<T> {
    return request<T>(`${path}${query ? toQuery(query) : ""}`, { method: "GET" });
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
/**
 * The filter block, plus the one parameter that is not a filter.
 *
 * `count` does not change WHICH posts a route considers, only how many come
 * back, but it travels in the same query string — so it is typed here rather
 * than concatenated onto a path by a caller, where it would collide with the
 * leading "?" that `toQuery` owns.
 */
export type Query = Filter & { count?: number };

export function toQuery(filter: Query): string {
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
    platforms: Platform[];
}

/**
 * Cadence for every account, person × platform.
 *
 * A separate route rather than a field on the overview because it needs a
 * column per platform: one posts-per-week number spanning every platform at
 * once is not a quantity, which is the bug this replaced. See the note above
 * `cadenceMatrix` in server/src/analytics/cadence.ts.
 */
export interface CadenceCell {
    handle: string;
    posts: number;
    /** Null when the whole column was withheld — read `windows[platform]` for why. */
    postsPerWeek: number | null;
    consistencyPct: number | null;
    isSynthetic: boolean;
}

export interface CadenceWindow {
    from: string;
    to: string;
    days: number;
    comparable: boolean;
    truncatedAccounts: string[];
    narrowedFromDays: number | null;
    narrowedBy: string[];
}

export interface CadenceMatrix {
    platforms: Platform[];
    rows: {
        personName: string;
        role: "PRINCIPAL" | "COMPETITOR";
        /** Keyed by platform; absent where the person is not tracked on it. */
        cells: Record<string, CadenceCell>;
    }[];
    windows: Record<string, CadenceWindow>;
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

/** One peer's contribution to a gap or a near miss. */
export interface ReportPeerEvidence {
    personName: string;
    n: number;
    lift: number;
    /** True where this peer on its own cleared the lift bar. */
    clears: boolean;
    isSynthetic: boolean;
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
    peers: ReportPeerEvidence[];
}

/**
 * A bucket that was considered and rejected, with the gate that stopped it.
 * Never a finding — see the reason copy in GapPanel.
 */
export interface ReportNearMiss {
    dimension: string;
    label: string;
    reason: string;
    peerLift: number;
    peerAgreement: string;
    principalN: number;
    principalLift: number | null;
    whatWouldChangeIt: string;
    sentence: string;
    peers: ReportPeerEvidence[];
}

export interface ReportDimensionCoverage {
    dimension: string;
    bucketsConsidered: number;
    bucketsTestable: number;
    gaps: number;
    nearMisses: number;
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
    nearMisses: ReportNearMiss[];
    gapCoverage: ReportDimensionCoverage[];
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
        windowDays: number;
        narrowedFromDays: number | null;
        narrowedBy: string[];
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
    /** The grid's drawing floor and the marginals' citing floor — see server timing.ts. */
    minCellN?: number;
    minMarginalN?: number;
    suppressedCells: number;
    suppressedPosts: number;
    /**
     * Slots holding posts but too few to draw. Lets the grid tell thin from unused.
     *
     * Optional, with the two floors above, because these three arrived together
     * and captured payloads predating them are still in the test suite. The
     * server always sends them; the heatmap degrades rather than crashing when
     * something older does not. See `TimingHeatmap`.
     */
    suppressedSlots?: { dayOfWeek: number; hour: number; n: number }[];
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

/**
 * One row of the activity list — ordered by recency, not ranked.
 *
 * `ratePct` and `unratedReason` are exactly one of null each: a post either has
 * a computable rate or a reason it does not. The UI must render the reason
 * rather than an empty cell, because "the platform withheld the metrics" and
 * "this post earned nothing" are opposite findings.
 */
export interface RecentPost {
    id: string;
    postId: string;
    platform: Platform;
    mediaType: string;
    postedAt: string;
    captionExcerpt: string | null;
    permalink: string | null;
    isSynthetic: boolean;
    theme: string | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
    saves: number | null;
    ratePct: number | null;
    basis: "VIEWS" | "FOLLOWERS" | null;
    unratedReason: "NO_METRICS" | "NO_DENOMINATOR" | null;
}

export interface RecentPostsResponse {
    count: number;
    accounts: {
        accountId: string;
        personName: string;
        platform: Platform;
        handle: string;
        timezone: string;
        isSynthetic: boolean;
        followerCount: number | null;
        matchedPosts: number;
        unratedPosts: number;
        posts: RecentPost[];
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
    /**
     * True when the server returned a run it had already computed for this exact
     * corpus and filter, rather than calling the model again. `generatedAt` is
     * then the time of that earlier run — which is why this needs saying.
     */
    cached: boolean;
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

/**
 * One account's fetch, as the run log recorded it.
 *
 * `partial` is a distinct status from `success` on purpose — a run that dropped
 * half its rows must not read as clean. The optional fields are not laziness:
 * when the per-platform route catches a throw it has no run to report, so it
 * returns `{status: "failed", error}` and nothing else. Modelling that honestly
 * is better than defaulting `rowsFetched` to 0 and implying a run happened.
 */
export interface IngestResult {
    accountId: string;
    handle: string;
    platform: string;
    status: "success" | "partial" | "failed";
    source?: string;
    runId?: string;
    rowsFetched?: number;
    rowsFailed?: number;
    error?: string;
}

export interface ClassifyReport {
    candidates: number;
    classified: number;
    /** Written as OTHER because the model's confidence was below the threshold. */
    lowConfidence: number;
    /** No caption to read — written as OTHER without spending a call. */
    unclassifiable: number;
    /**
     * Sent but not returned by the model. Left UNCLASSIFIED rather than
     * defaulted, so these posts stay in the pool and a later pass retries them.
     * The reason a progress loop must terminate on lack of progress rather than
     * on `unclassified === 0`, which these can prevent from ever being reached.
     */
    missing: number;
    discardedResults: number;
    batches: number;
    /** A failed batch leaves its posts unclassified for the next pass. */
    failedBatches: { batch: number; error: string }[];
    distribution: Record<string, number>;
    usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
    /** Quota is a wall, not weather: every remaining batch would fail the same way. */
    stoppedEarly?: { reason: string; message: string; remaining: number };
}

export interface ClassifyRun {
    report: ClassifyReport;
    status: {
        total: number;
        classified: number;
        unclassified: number;
        lowConfidence: number;
        distribution: Record<string, number>;
    };
}

// ── The calls ────────────────────────────────────────────────────────────

export const api = {
    health: () => get<Health>("/api/health"),

    accounts: () => get<{ accounts: Account[] }>("/api/accounts"),
    createAccount: (body: NewAccount) =>
        // `ingestion` is present only when `ingestNow` was sent, and is the
        // failure shape rather than a result when the fetch threw — the account
        // is still created in that case, which is why the server reports the two
        // outcomes separately instead of collapsing them into one error.
        request<{
            account: Account;
            note: string | null;
            ingestion: IngestResult | { status: string; error?: string } | null;
        }>("/api/accounts", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    deleteAccount: (id: string) =>
        request<{ deleted: { personName: string; platform: string; postsRemoved: number } }>(
            `/api/accounts/${encodeURIComponent(id)}`,
            { method: "DELETE" },
        ),

    overview: (filter: Filter) => get<Overview>("/api/analytics/overview", filter),
    cadence: (filter: Filter) => get<CadenceMatrix>("/api/analytics/cadence", filter),
    report: (filter: Filter) => get<Report>("/api/analytics/report", filter),
    timing: (filter: Filter) => get<TimingResponse>("/api/analytics/timing", filter),

    /**
     * The principal's latest posts per platform. `count` is clamped server-side.
     *
     * Not part of the report: the report is the document the recommendation
     * model is grounded against, and this list exists for a human to eyeball.
     */
    recentPosts: (filter: Filter, count = 10) =>
        // `count` rides in the same query string as the filter rather than being
        // appended to the path — `toQuery` owns the leading "?", so a hand-built
        // one here would produce `?count=10?platform=…`.
        get<RecentPostsResponse>("/api/analytics/recent-posts", { ...filter, count }),

    // ── The writes that used to be terminal-only ─────────────────────────
    // These three routes existed on the server from the start; nothing in the
    // client called them, so refreshing a corpus meant `npm run ingest` at a
    // prompt. For anyone who is not the person who wrote the repo, a capability
    // reachable only from a checkout is not a capability.
    //
    // All three are slow and synchronous — a fetch can take tens of seconds, a
    // full classification pass minutes. `fetch` has no default timeout, so these
    // wait rather than aborting; the callers are responsible for saying so.

    /** Refresh one account (`accountId`), one platform, or everything (`{}`). */
    ingest: (body: { accountId?: string; platform?: string; sinceDays?: number }) =>
        request<{ results: IngestResult[] }>("/api/ingest", {
            method: "POST",
            body: JSON.stringify(body),
        }),

    /** FR3 — push a CSV/JSON export's text at one account. */
    importFile: (body: { accountId: string; content: string; filename: string }) =>
        request<{ result: IngestResult }>("/api/import", {
            method: "POST",
            body: JSON.stringify(body),
        }),

    /** FR11 — assign themes. Incremental unless `force`; `limit` caps one pass. */
    classify: (body: { force?: boolean; limit?: number; accountId?: string; platform?: string }) =>
        request<ClassifyRun>("/api/ai/classify", {
            method: "POST",
            body: JSON.stringify(body),
        }),

    recommendations: (filter: Filter) => get<RecommendationRun>("/api/ai/recommendations", filter),
    classification: () => get<ClassificationStatus>("/api/ai/classify"),
};
