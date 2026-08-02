// "How often do they post, and how reliably?" — the second dimension of the
// Module C comparison.
//
// A NOTE ON PRIORITY. ARCHITECTURE.md's cut list put cadence analysis first on
// the sacrifice pile, as though it were a Module B nice-to-have. It is not:
// cadence is named inside the Module C comparison MUST, so the first thing the
// plan proposed to drop would have broken a required deliverable. The cut list
// is corrected in the same commit as this file.
//
// THIS MODULE MEASURES BEHAVIOUR, NOT PERFORMANCE.
//
// Everything else under analytics/ divides by views or followers and therefore
// carries an engagement basis. Nothing here does. A post is a post: it has no
// denominator, so there is no basis to mix and `assertSingleBasis` is
// deliberately absent. That is also why cadence counts EVERY post rather than
// only the rated ones — a post whose like count the platform withheld still
// happened, and excluding it would report an account as quieter than it is.
//
// THE WINDOW IS THE WHOLE PROBLEM.
//
// "Posts per week" is a division, and the denominator is not the corpus. An
// account with two posts three days apart is not posting 4.7 times a week; it
// is an account with two posts. Deriving the window from each account's own
// first and last post would give every account a different denominator and make
// the comparison meaningless — the quietest account would score highest, because
// its span would collapse to the few days it happened to be active.
//
// So the window is explicit, and `compareCadence` forces every account in one
// comparison to share it.

import { describe as describeDistribution, type Distribution } from "./stats";
import { localDateKey } from "./timing";
import type { AccountRole } from "./compare";

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;

/** The period cadence is measured over. Shared by every account in a comparison. */
export interface CadenceWindow {
    from: Date;
    to: Date;
}

/** All this module needs from a post. Structural, so tests need no database. */
export interface CadencePost {
    postedAt: Date;
}

export interface CadenceCorpus<T extends CadencePost> {
    accountId: string;
    personName: string;
    role: AccountRole;
    handle: string;
    isSynthetic: boolean;
    /** Used for the per-day bucketing — "how many posts in one day" is a local question. */
    timezone: string;
    posts: readonly T[];
}

export interface CadenceStats {
    accountId: string;
    personName: string;
    role: AccountRole;
    handle: string;
    isSynthetic: boolean;
    /** Posts inside the window. The numerator behind every rate below. */
    posts: number;
    windowDays: number;
    postsPerWeek: number;
    /**
     * Distribution of hours between consecutive posts. Null below two posts,
     * where there is no interval to measure.
     *
     * The MEDIAN gap is the honest headline, not the mean: an account that posts
     * six times on polling day and then goes quiet for a fortnight has a
     * flattering mean gap, and the median says what a typical wait actually is.
     */
    gapHours: Distribution | null;
    /** 7-day blocks from the window start that contain at least one post. */
    activeBlocks: number;
    totalBlocks: number;
    /**
     * activeBlocks / totalBlocks. Regularity, deliberately separated from volume:
     * two accounts can post 20 times in 90 days, one every fourth day and one in
     * a single afternoon, and they are not running the same operation.
     */
    consistency: number;
    /** Longest interval between two consecutive posts, in days. Null below two posts. */
    longestSilenceDays: number | null;
    /** Window end minus the last post. How dark the account is right now. */
    daysSinceLastPost: number | null;
    /** Most posts in any single local calendar day — the burst detector. */
    maxPostsInOneDay: number;
    /**
     * This account's earliest post inside the window. Null with no posts.
     *
     * Exists to detect a corpus that was TRUNCATED rather than quiet — see
     * `historyStartsLate`.
     */
    observedFrom: Date | null;
    /**
     * True when this account's first post sits well after the window opens.
     *
     * Two very different things produce this, and cadence cannot tell them apart
     * from post rows alone: an account that genuinely posted nothing for the
     * first stretch of the window, or a source that returned only the most
     * recent N posts. Either way the account's rate over the FULL window is not
     * a rate anyone should compare — which is what `comparable` below is for.
     */
    historyStartsLate: boolean;
}

/**
 * How much of the window an account's history must cover before its rate is
 * treated as comparable.
 *
 * 0.9 — a tenth of the window is a generous allowance for an account that simply
 * started slowly, and well inside the distortion a result cap produces. The X
 * ingest that motivated this covered 23% of the window for the principal against
 * 100% for one peer.
 */
const MIN_WINDOW_COVERAGE = 0.9;

/**
 * The shortest window a narrowed comparison may be published over, in days.
 *
 * Two weekly blocks. Below this, `consistency` — share of 7-day blocks with a
 * post — has one or two blocks to work with and reads 100% for anyone who
 * posted at all, which is not a measurement. Narrowing that far buys a
 * posts-per-week figure at the cost of a meaningless regularity figure, so it is
 * refused and the comparison stays withheld.
 */
const MIN_NARROWED_DAYS = 14;

/**
 * The tightest window containing every post across every corpus.
 *
 * Used when the caller has not filtered to an explicit date range. It is derived
 * from the UNION rather than per account, which is the point: one denominator
 * for everyone. An account that posted nothing in the window scores 0 posts per
 * week, which is the truth about it.
 */
export function windowSpanning<T extends CadencePost>(corpora: readonly CadenceCorpus<T>[]): CadenceWindow | null {
    let earliest: number | null = null;
    let latest: number | null = null;

    for (const corpus of corpora) {
        for (const post of corpus.posts) {
            const time = post.postedAt.getTime();
            if (earliest === null || time < earliest) earliest = time;
            if (latest === null || time > latest) latest = time;
        }
    }

    if (earliest === null || latest === null) return null;
    return { from: new Date(earliest), to: new Date(latest) };
}

/**
 * The longest window EVERY account with posts actually has history for.
 *
 * The union window above is the honest default, but it is only usable when every
 * account's history reaches back to its start. A per-account result cap at
 * ingestion breaks that: the cap is on COUNT and it returns newest first, so a
 * prolific account's 160 rows buy a fortnight while a quiet one's buy two
 * months. `windowSpanning` then hands all of them the quiet account's
 * denominator.
 *
 * This is the fallback. `from` is the LATEST first-post across accounts — the
 * point from which everyone's history is complete — and `to` stays the union's
 * end, because a count cap truncates the beginning of a corpus and never the
 * end. Inside this window no account is missing posts it actually made, so one
 * denominator is a denominator in fact and not only in form.
 *
 * Accounts with no posts are ignored here. A silent account is not truncated: it
 * has nothing to be missing, and letting it collapse the window would let the
 * quietest account decide what everyone else is measured over.
 *
 * WHAT IS TRADED AWAY. The window gets shorter — sometimes much shorter — and a
 * short window is a worse window: fewer weekly blocks for `consistency`, less
 * chance of catching a long silence. `MIN_NARROWED_DAYS` is the floor below
 * which that trade stops being worth making.
 */
export function windowCovered<T extends CadencePost>(corpora: readonly CadenceCorpus<T>[]): CadenceWindow | null {
    let latestFirst: number | null = null;
    let latest: number | null = null;

    for (const corpus of corpora) {
        let first: number | null = null;
        for (const post of corpus.posts) {
            const time = post.postedAt.getTime();
            if (first === null || time < first) first = time;
            if (latest === null || time > latest) latest = time;
        }
        if (first === null) continue;
        if (latestFirst === null || first > latestFirst) latestFirst = first;
    }

    if (latestFirst === null || latest === null || latest <= latestFirst) return null;
    return { from: new Date(latestFirst), to: new Date(latest) };
}

/**
 * Cadence for one account over an explicit window.
 *
 * Posts outside the window are ignored rather than trusted, so a caller that
 * passes a narrower window than it queried gets an arithmetically consistent
 * answer instead of a rate above 100%.
 */
export function analyseCadence<T extends CadencePost>(
    corpus: CadenceCorpus<T>,
    window: CadenceWindow,
): CadenceStats {
    const from = window.from.getTime();
    const to = window.to.getTime();

    // A zero-length window would divide by zero. One day is the smallest span
    // over which "posts per week" means anything at all.
    const windowDays = Math.max((to - from) / MS_PER_DAY, 1);
    const totalBlocks = Math.max(Math.ceil(windowDays / DAYS_PER_WEEK), 1);

    const times = corpus.posts
        .map((p) => p.postedAt.getTime())
        .filter((t) => t >= from && t <= to)
        .sort((a, b) => a - b);

    const base = {
        accountId: corpus.accountId,
        personName: corpus.personName,
        role: corpus.role,
        handle: corpus.handle,
        isSynthetic: corpus.isSynthetic,
        posts: times.length,
        windowDays,
        totalBlocks,
    };

    if (times.length === 0) {
        return {
            ...base,
            postsPerWeek: 0,
            gapHours: null,
            activeBlocks: 0,
            consistency: 0,
            longestSilenceDays: null,
            daysSinceLastPost: null,
            maxPostsInOneDay: 0,
            observedFrom: null,
            // An account with no posts in the window is not truncated, it is
            // silent — and that is a finding, not a data problem.
            historyStartsLate: false,
        };
    }

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) {
        gaps.push((times[i] - times[i - 1]) / MS_PER_HOUR);
    }

    // Fixed 7-day blocks from the window start rather than ISO weeks. ISO weeks
    // would split the window on an arbitrary Monday and make the first and last
    // buckets partial, which shows up as a consistency penalty that is an
    // artefact of the calendar rather than a fact about the account.
    const activeBlockIndices = new Set<number>();
    for (const time of times) {
        activeBlockIndices.add(Math.floor((time - from) / MS_PER_DAY / DAYS_PER_WEEK));
    }

    const postsPerLocalDay = new Map<string, number>();
    for (const post of corpus.posts) {
        const time = post.postedAt.getTime();
        if (time < from || time > to) continue;
        // Local calendar date, not a UTC-aligned bucket: an account posting at
        // 23:00 and 01:00 IST has posted on two days, and a UTC bucket — where
        // both instants land on the same date — would call it one burst of two.
        const dayKey = localDateKey(post.postedAt, corpus.timezone);
        postsPerLocalDay.set(dayKey, (postsPerLocalDay.get(dayKey) ?? 0) + 1);
    }

    return {
        ...base,
        postsPerWeek: times.length / (windowDays / DAYS_PER_WEEK),
        gapHours: describeDistribution(gaps),
        activeBlocks: activeBlockIndices.size,
        consistency: activeBlockIndices.size / totalBlocks,
        longestSilenceDays: gaps.length === 0 ? null : Math.max(...gaps) / HOURS_PER_DAY,
        daysSinceLastPost: (to - times[times.length - 1]) / MS_PER_DAY,
        maxPostsInOneDay: Math.max(...postsPerLocalDay.values()),
        observedFrom: new Date(times[0]),
        historyStartsLate: (to - times[0]) / MS_PER_DAY < windowDays * MIN_WINDOW_COVERAGE,
    };
}

export interface CadenceComparison {
    window: CadenceWindow;
    principal: CadenceStats | null;
    /** Peers, most prolific first. */
    peers: CadenceStats[];
    /** Median peer posts-per-week. Null with no peers, or where not comparable. */
    peerBenchmark: number | null;
    /** Principal ÷ benchmark. Below 1 means the principal posts less often. */
    principalVsPeers: number | null;
    /** Median peer consistency, for the regularity half of the picture. */
    peerConsistency: number | null;
    /**
     * False when at least one account's history does not cover the window, so
     * the cross-account figures are withheld rather than published.
     *
     * ── THE FAILURE THIS EXISTS TO PREVENT ───────────────────────────────
     *
     * Found the day X went live. The X adapter caps results per account for cost
     * reasons, and all four accounts hit the same 160-post cap. Because the cap
     * is on COUNT and the accounts post at wildly different rates, 160 posts
     * bought 15 days of the principal's history and 65 days of one peer's — but
     * `windowSpanning` takes the union, so all four were then divided by the same
     * 65-day denominator.
     *
     * Every account came out at exactly 17.11 posts/week, and the dashboard
     * reported `principalVsPeers = 1.00x` — "he posts exactly as often as his
     * peers". That is not a weak finding, it is a manufactured one: the number
     * measures the result cap, not the accounts. The consistency figure was worse
     * still, reporting the principal as posting in 30% of weeks when he posts
     * most days, because 7 of the 10 blocks predated anything we fetched.
     *
     * Nothing about the arithmetic was wrong. The inputs were not comparable and
     * the module had no way to say so, so it said something false instead.
     */
    comparable: boolean;
    /** Accounts whose history does not cover the window. Empty when comparable. */
    truncatedAccounts: string[];
    /**
     * Set when the default window was too wide for some account's history and
     * the comparison was re-run over the span every account does cover.
     *
     * Null in the ordinary case, and null again when narrowing was tried and did
     * not help — a comparison that is still not comparable is withheld over the
     * ORIGINAL window rather than a narrowed one, so the blanks are never
     * accompanied by a window nobody was measured over.
     *
     * `days` is what the figures above are computed over; `requestedDays` is what
     * they would have been computed over. Both are reported because the gap
     * between them is the size of the concession, and a reader who is told the
     * window moved but not how far cannot judge it.
     */
    narrowed: {
        requested: CadenceWindow;
        requestedDays: number;
        days: number;
        /** The accounts whose short history forced the narrowing. */
        accounts: string[];
    } | null;
    /**
     * Whether the narrowed window above was even considered.
     *
     * False when the caller named an explicit window — that is a question about
     * a period, and it is not this module's place to answer a different one. The
     * only consumer is the withheld sentence, which would otherwise tell a
     * reader that a fallback was tried when it was not.
     */
    narrowingTried: boolean;
}

/**
 * Every account's cadence over ONE shared window.
 *
 * The shared window is the entire correctness argument for this function
 * existing rather than callers mapping `analyseCadence` themselves — it is the
 * only thing standing between a comparison and four different denominators.
 *
 * No sample-size gate. Cadence has no `n` problem: an account that posted twice
 * in 90 days has not given us a thin sample of its posting rate, it has told us
 * its posting rate exactly. Suppressing that would hide the most actionable
 * finding this module can produce.
 */
export function compareCadence<T extends CadencePost>(
    corpora: readonly CadenceCorpus<T>[],
    window?: CadenceWindow,
): CadenceComparison | null {
    const resolved = window ?? windowSpanning(corpora);
    if (resolved === null) return null;

    // An explicit window is a question about that period, and silently answering
    // a different one would be worse than answering nothing — so the fallback
    // below is offered only when the caller left the window to us.
    const mayNarrow = window === undefined;

    const overRequested = compareOverWindow(corpora, resolved, null, mayNarrow);
    if (overRequested === null || overRequested.comparable || !mayNarrow) return overRequested;

    // Not comparable over the requested window. Before withholding everything,
    // try the window every account does cover — see `windowCovered`.
    const covered = windowCovered(corpora);
    if (covered === null) return overRequested;

    const days = (covered.to.getTime() - covered.from.getTime()) / MS_PER_DAY;
    if (days < MIN_NARROWED_DAYS) return overRequested;

    const narrowed = compareOverWindow(
        corpora,
        covered,
        {
            requested: resolved,
            requestedDays: (resolved.to.getTime() - resolved.from.getTime()) / MS_PER_DAY,
            days,
            accounts: overRequested.truncatedAccounts,
        },
        true,
    );

    // Narrowing does not always rescue the comparison: an account can be silent
    // through the start of the covered window too, and that is a real finding
    // rather than a coverage artefact. When it does not, the original withheld
    // result stands — over the window that was actually asked for.
    return narrowed !== null && narrowed.comparable ? narrowed : overRequested;
}

/** One pass of the comparison over a fixed window. The window choice is above. */
function compareOverWindow<T extends CadencePost>(
    corpora: readonly CadenceCorpus<T>[],
    resolved: CadenceWindow,
    narrowed: CadenceComparison["narrowed"],
    narrowingTried: boolean,
): CadenceComparison | null {
    const stats = corpora.map((corpus) => analyseCadence(corpus, resolved));

    const principal = stats.find((s) => s.role === "PRINCIPAL") ?? null;
    const peers = stats.filter((s) => s.role === "COMPETITOR").sort((a, b) => b.postsPerWeek - a.postsPerWeek);

    const medianOf = (values: number[]): number | null => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    // An account with no posts at all is silent, not truncated — it belongs in
    // the comparison at 0 posts/week, which is the truth about it.
    const truncatedAccounts = stats.filter((s) => s.posts > 0 && s.historyStartsLate).map((s) => s.personName);
    const comparable = truncatedAccounts.length === 0;

    const peerBenchmark = comparable ? medianOf(peers.map((p) => p.postsPerWeek)) : null;

    return {
        window: resolved,
        principal,
        peers,
        peerBenchmark,
        // Withheld rather than computed when the denominators are not shared in
        // fact, only in form. See `comparable`.
        principalVsPeers:
            !comparable || principal === null || peerBenchmark === null || peerBenchmark === 0
                ? null
                : principal.postsPerWeek / peerBenchmark,
        peerConsistency: comparable ? medianOf(peers.map((p) => p.consistency)) : null,
        comparable,
        truncatedAccounts,
        narrowed,
        narrowingTried,
    };
}

// ── The matrix: every account, every platform ────────────────────────────
//
// One row per person, one column per platform, and — the entire point — ONE
// COMPARISON PER COLUMN, each over its own window.
//
// THE FAILURE THIS REPLACES. The overview KPI used to pass every corpus into a
// single `compareCadence` call and print the result as one number. That looks
// like it answers "how often does the principal post" and does not.
// `compareOverWindow` takes the FIRST principal row it finds (`stats.find`), so
// a principal tracked on three platforms contributed one of them and the other
// two vanished silently. The peer median was then taken across every platform
// at once, so on the roster this was found with, a YouTube numerator (839 posts,
// 64.4/wk) was divided by a median that landed on a peer's INSTAGRAM row
// (14.1/wk) and the strip reported "4.56× more often than peers". Every step of
// that arithmetic is correct and the claim is meaningless.
//
// Per platform, therefore, exactly as `buildReport` already does it. Two
// consequences worth stating rather than hiding:
//
//   - COLUMNS ARE NOT STRICTLY COMMENSURABLE. Each is measured over its own
//     window — the platforms are ingested on different days, so their spans
//     differ by a day or two — and more importantly a tweet and a 20-minute
//     upload are not the same unit of work. The window is reported per column
//     so a reader can see the first part; the second part is judgement and the
//     UI says so.
//   - A WITHHELD COLUMN IS WITHHELD WHOLE. If one account's history does not
//     cover a platform's window, every cell in that column is null, not just
//     the cross-account figures. They are all divided by the same window, so
//     they are all wrong in the same way — the rule `buildReport` applies to
//     the principal's own rate, applied to the rest of the column.

export interface PlatformCadenceCorpus<T extends CadencePost> extends CadenceCorpus<T> {
    platform: string;
}

export interface CadenceCell {
    handle: string;
    /** Posts inside this platform's window. A fact about the account either way. */
    posts: number;
    /** Null when this column was withheld — see `CadenceMatrixWindow.comparable`. */
    postsPerWeek: number | null;
    consistencyPct: number | null;
    isSynthetic: boolean;
}

/** The denominator behind one column, stated rather than assumed. */
export interface CadenceMatrixWindow {
    from: Date;
    to: Date;
    days: number;
    comparable: boolean;
    truncatedAccounts: string[];
    narrowedFromDays: number | null;
    narrowedBy: string[];
}

export interface CadenceMatrixRow {
    personName: string;
    role: AccountRole;
    /** Keyed by platform. Absent where the person is not tracked on that one. */
    cells: Record<string, CadenceCell>;
}

export interface CadenceMatrix {
    /** Columns, in order. A platform with no posts at all is not a column. */
    platforms: string[];
    rows: CadenceMatrixRow[];
    windows: Record<string, CadenceMatrixWindow>;
}

/**
 * Posts-per-week for every tracked account, grouped person × platform.
 *
 * No sample-size gate and no basis, for the reasons at the top of this file:
 * cadence measures behaviour, and an account that posted twice has told us its
 * posting rate exactly rather than given us a thin sample of it.
 */
export function cadenceMatrix<T extends CadencePost>(
    corpora: readonly PlatformCadenceCorpus<T>[],
): CadenceMatrix {
    const platforms = [...new Set(corpora.map((c) => c.platform))].sort();

    const columns: string[] = [];
    const windows: Record<string, CadenceMatrixWindow> = {};
    const statsByAccount = new Map<string, CadenceStats>();

    for (const platform of platforms) {
        const onPlatform = corpora.filter((c) => c.platform === platform);
        const comparison = compareCadence(onPlatform);

        // Nothing posted anywhere on this platform, so there is no window to
        // divide by. Dropped rather than rendered as a column of dashes —
        // `buildReport` skips such a platform for the same reason.
        if (comparison === null) continue;

        columns.push(platform);
        windows[platform] = {
            from: comparison.window.from,
            to: comparison.window.to,
            days: (comparison.window.to.getTime() - comparison.window.from.getTime()) / MS_PER_DAY,
            comparable: comparison.comparable,
            truncatedAccounts: comparison.truncatedAccounts,
            narrowedFromDays: comparison.narrowed?.requestedDays ?? null,
            narrowedBy: comparison.narrowed?.accounts ?? [],
        };

        // `principal` and `peers` between them are every account on the
        // platform, already measured over the window resolved above.
        const stats = comparison.principal === null ? comparison.peers : [comparison.principal, ...comparison.peers];
        for (const entry of stats) statsByAccount.set(entry.accountId, entry);
    }

    // Principal first — the row the reader came for — then peers by name, so the
    // order cannot shift between two identical requests.
    const people = [...new Map(corpora.map((c) => [c.personName, c])).values()].sort((a, b) =>
        a.role === b.role ? a.personName.localeCompare(b.personName) : a.role === "PRINCIPAL" ? -1 : 1,
    );

    const rows = people.map((person) => {
        const cells: Record<string, CadenceCell> = {};

        for (const platform of columns) {
            const corpus = corpora.find((c) => c.personName === person.personName && c.platform === platform);
            if (corpus === undefined) continue;

            const entry = statsByAccount.get(corpus.accountId);
            if (entry === undefined) continue;

            const withheld = !windows[platform]!.comparable;
            cells[platform] = {
                handle: corpus.handle,
                posts: entry.posts,
                postsPerWeek: withheld ? null : entry.postsPerWeek,
                consistencyPct: withheld ? null : Math.round(entry.consistency * 100),
                isSynthetic: corpus.isSynthetic,
            };
        }

        return { personName: person.personName, role: person.role, cells };
    });

    return { platforms: columns, rows, windows };
}

/**
 * One sentence for a comms manager.
 *
 * Volume and regularity are reported together and never collapsed into one
 * number, because the advice they imply is different: "post more" and "post on
 * a schedule" are separate instructions, and an account can need either, both
 * or neither.
 */
export function describeCadence(comparison: CadenceComparison): string {
    const { principal, peerBenchmark, principalVsPeers, peerConsistency } = comparison;

    if (principal === null) return "No principal in this comparison.";

    // Says what is missing and why, rather than quoting a rate computed over a
    // window the account's data does not cover. The per-account posts-per-week
    // figure is deliberately NOT restated here either: it is the same wrong
    // number the comparison was withheld for.
    if (!comparison.comparable) {
        return (
            `Cadence comparison withheld on this platform: ${comparison.truncatedAccounts.join(", ")} ` +
            `${comparison.truncatedAccounts.length === 1 ? "has" : "have"} no posts in the earlier part of the ` +
            `window, so ${comparison.truncatedAccounts.length === 1 ? "that account is" : "those accounts are"} ` +
            `measured over a shorter history than the rest. Dividing every account by the same window would ` +
            `report a posting rate that measures the gap in coverage rather than the account. The usual cause ` +
            `is a per-account result cap at ingestion (see X_RESULTS_LIMIT); the other is an account that was ` +
            `genuinely silent, and post rows alone cannot tell the two apart.` +
            (comparison.narrowingTried
                ? ` Narrowing to the span every account covers was tried and did not rescue it — that span is ` +
                  `either under two weeks or still has an account silent through its start.`
                : "")
        );
    }
    // Leads rather than trails. Every figure below is a rate, and a reader who
    // learns the denominator afterwards has already read the numbers as if they
    // covered the full period.
    const narrowedNote =
        comparison.narrowed === null
            ? ""
            : `Measured over the last ${comparison.narrowed.days.toFixed(0)} days rather than ` +
              `${comparison.narrowed.requestedDays.toFixed(0)}: ${comparison.narrowed.accounts.join(", ")} ` +
              `${comparison.narrowed.accounts.length === 1 ? "has" : "have"} no history before that, so the longer ` +
              `window would have measured the gap in coverage rather than the accounts. ` +
              `A ${comparison.narrowed.days.toFixed(0)}-day window is few enough weeks that the consistency ` +
              `figure is weak evidence. `;

    if (peerBenchmark === null || principalVsPeers === null) {
        return (
            narrowedNote +
            `${principal.personName} posts ${principal.postsPerWeek.toFixed(1)}×/week. No peers to compare against.`
        );
    }

    const direction = principalVsPeers >= 1 ? "more often than" : "less often than";
    const multiple = principalVsPeers >= 1 ? principalVsPeers : 1 / principalVsPeers;

    const consistencyNote =
        peerConsistency === null
            ? ""
            : ` He posts in ${(principal.consistency * 100).toFixed(0)}% of weeks against a peer median of ` +
              `${(peerConsistency * 100).toFixed(0)}%.`;

    const silenceNote =
        principal.longestSilenceDays === null || principal.longestSilenceDays < 7
            ? ""
            : ` Longest silence: ${principal.longestSilenceDays.toFixed(0)} days.`;

    return (
        narrowedNote +
        `${principal.personName} posts ${principal.postsPerWeek.toFixed(1)}×/week across ${principal.posts} posts, ` +
        `${multiple.toFixed(2)}× ${direction} the peer median of ${peerBenchmark.toFixed(1)}×/week.` +
        consistencyNote +
        silenceNote
    );
}
