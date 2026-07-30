// The one place the analytics layer touches the database.
//
// Everything under analytics/ is deliberately pure — arithmetic over plain
// objects, testable without a database. That property is worth keeping, so the
// Prisma query lives here and here only, and every module downstream receives
// plain rated corpora it can be tested against with hand-built fixtures.
//
// It also means the FR16 filter block is implemented once. Six routes each
// writing their own `where` clause is six chances for the timing panel and the
// format panel to be filtering different corpora while showing the same header.
//
// One structural decision worth stating: an ACCOUNT is per-platform, but a
// PERSON is not. "Shashi Tharoor" is four Account rows. So a cross-platform view
// of one person is several corpora, not one — and merging them would merge
// engagement bases, which throws. The loader returns them separately and lets
// the caller decide how to present them.

import { prisma } from "../db";
import { rateAll, type EngagementGap, type MediaType, type Platform } from "./engagement";
import type { AccountRole } from "./compare";
import type { GapCorpus, GapPost, ContentPillar } from "./gaps";
import type { IdentifiedPost } from "./topPosts";

/** Everything every analytics module needs from a post, in one shape. */
export interface CorpusPost extends IdentifiedPost, GapPost {}

/** The FR16 filter block, parsed once and applied in SQL rather than in memory. */
export interface CorpusFilter {
    /** A single Account row (one person on one platform). */
    accountId?: string;
    /** A person across every platform they are tracked on. */
    personName?: string;
    platform?: Platform;
    mediaType?: MediaType;
    theme?: ContentPillar;
    /** Inclusive lower bound on `postedAt`, UTC. */
    from?: Date;
    /** Inclusive upper bound on `postedAt`, UTC. */
    to?: Date;
    /** Exclude seeded rows entirely — the "show me only what is real" toggle. */
    liveOnly?: boolean;
}

export interface LoadedCorpus extends GapCorpus<CorpusPost> {
    displayName: string;
    followerCount: number | null;
    /**
     * Every post the filter matched, rated or not.
     *
     * Distinct from `rated` on purpose. Cadence is a question about BEHAVIOUR —
     * a post whose like count the platform hid still happened, and dropping it
     * would report an account as posting less often than it does. Anything
     * measuring PERFORMANCE uses `rated`; anything counting activity uses this.
     */
    posts: CorpusPost[];
    /**
     * Posts that could not be rated, by reason. Carried per account because
     * "we could rate 40 of 90 posts" is something the reader of a dashboard is
     * entitled to know, and it differs by platform.
     */
    gaps: Record<EngagementGap, number>;
    /** Rows returned by the query, rated or not. `rated.length` is the subset. */
    fetchedPosts: number;
}

function whereFor(filter: CorpusFilter) {
    const where: Record<string, unknown> = {};

    if (filter.platform) where["platform"] = filter.platform;
    if (filter.mediaType) where["mediaType"] = filter.mediaType;
    if (filter.theme) where["theme"] = filter.theme;
    if (filter.liveOnly) where["isSynthetic"] = false;

    if (filter.from || filter.to) {
        where["postedAt"] = {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
        };
    }

    return where;
}

/**
 * Load one rated corpus per tracked account matching the filter.
 *
 * Accounts with no matching posts are returned with an empty `rated` array
 * rather than omitted. That distinction matters: an account that posted nothing
 * in the window is a finding about cadence, and dropping the row would make it
 * indistinguishable from an account nobody is tracking.
 */
export async function loadCorpora(filter: CorpusFilter = {}): Promise<LoadedCorpus[]> {
    const accounts = await prisma.account.findMany({
        where: {
            ...(filter.accountId ? { id: filter.accountId } : {}),
            ...(filter.personName ? { personName: filter.personName } : {}),
            ...(filter.platform ? { platform: filter.platform } : {}),
        },
        include: {
            posts: {
                where: whereFor(filter),
                orderBy: { postedAt: "desc" },
            },
        },
        orderBy: [{ role: "asc" }, { personName: "asc" }],
    });

    return accounts.map((account): LoadedCorpus => {
        const posts: CorpusPost[] = account.posts.map((post) => ({
            id: post.id,
            postId: post.postId,
            platform: post.platform as Platform,
            mediaType: post.mediaType as MediaType,
            postedAt: post.postedAt,
            caption: post.caption,
            permalink: post.permalink,
            isSynthetic: post.isSynthetic,
            theme: post.theme as ContentPillar | null,
            likes: post.likes,
            comments: post.comments,
            shares: post.shares,
            views: post.views,
            saves: post.saves,
        }));

        const { rated, gaps } = rateAll(posts, { followerCount: account.followerCount });

        return {
            accountId: account.id,
            personName: account.personName,
            displayName: account.displayName,
            role: account.role as AccountRole,
            platform: account.platform as Platform,
            handle: account.handle,
            followerCount: account.followerCount,
            isSynthetic: account.isSynthetic,
            timezone: account.timezone,
            posts,
            rated,
            gaps,
            fetchedPosts: posts.length,
        };
    });
}

/**
 * Merge every account belonging to one person into a single corpus.
 *
 * Used where the question is about the PERSON rather than the channel — "which
 * format works for Tharoor" spans his four accounts. Safe only because nothing
 * downstream aggregates without calling `assertSingleBasis` first: a merged
 * corpus legitimately holds both bases, and the `*ByBasis` entry points split it
 * back apart before any arithmetic happens.
 *
 * `platform` and `handle` on the result are the first account's and are not
 * meaningful for a merged corpus — the UI should key off `personName`.
 */
export function mergeByPerson(corpora: readonly LoadedCorpus[]): LoadedCorpus[] {
    const byPerson = new Map<string, LoadedCorpus[]>();
    for (const corpus of corpora) {
        const existing = byPerson.get(corpus.personName);
        if (existing) existing.push(corpus);
        else byPerson.set(corpus.personName, [corpus]);
    }

    return [...byPerson.values()].map((group) => {
        const [first] = group;
        return {
            ...first,
            // The merged view is synthetic only if EVERY channel behind it is.
            // Marking it synthetic because one platform is seeded would badge a
            // mostly-live corpus as generated; the per-account rows keep the detail.
            isSynthetic: group.every((c) => c.isSynthetic),
            posts: group.flatMap((c) => c.posts),
            rated: group.flatMap((c) => c.rated),
            gaps: group.reduce(
                (acc, c) => ({
                    NO_METRICS: acc.NO_METRICS + c.gaps.NO_METRICS,
                    NO_DENOMINATOR: acc.NO_DENOMINATOR + c.gaps.NO_DENOMINATOR,
                }),
                { NO_METRICS: 0, NO_DENOMINATOR: 0 },
            ),
            fetchedPosts: group.reduce((total, c) => total + c.fetchedPosts, 0),
        };
    });
}

/** The principal's corpora, or an empty array if none is configured. */
export function principalOf(corpora: readonly LoadedCorpus[]): LoadedCorpus[] {
    return corpora.filter((c) => c.role === "PRINCIPAL");
}

export function competitorsOf(corpora: readonly LoadedCorpus[]): LoadedCorpus[] {
    return corpora.filter((c) => c.role === "COMPETITOR");
}
