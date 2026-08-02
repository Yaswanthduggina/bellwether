// The activity list — what the principal has actually put out lately.
//
// Ordered by RECENCY, and that is the whole point of it existing next to a page
// of rankings. Every other post list here is sorted by engagement rate, which
// answers "what worked"; none of them answer "what did we post on Tuesday", and
// that is the question a comms manager opens a dashboard with.
//
// Two things this table does that the ranked ones do not:
//
//   - It shows posts with no computable rate, and prints the REASON in the rate
//     column. A blank there would read as "this post earned nothing", which is a
//     different and much worse claim than "the platform did not report metrics".
//   - It shows raw counts. Everywhere else raw likes are deliberately withheld
//     because ranking on them is the trap the product exists to avoid — but this
//     list does not rank, so the counts are just facts about a post, and hiding
//     them from someone who wants to open the post is pointless.
//
// A count column the platform never fills is dropped rather than printed as a
// column of em dashes. Instagram and YouTube publish no share count at all, and
// a full column of dashes there says "nothing was shared" to anyone reading at
// a glance — the same absent-vs-zero confusion the em dash exists to prevent,
// just moved up a level. The reason is stated under the table instead.
//
// The rate column still carries its basis, because the same number means
// different things over views and over followers, and this table can legitimately
// contain both at once — an Instagram reel is rated on views and the carousel
// posted an hour later is rated on followers.

import type { RecentPost } from "../api/client";
import { Badge, humanise } from "./ui";

const UNRATED_REASON: Record<string, { short: string; long: string }> = {
    NO_METRICS: {
        short: "no metrics",
        long: "The platform reported none of likes, comments, shares or saves for this post — so there is no numerator. This is missing data, not zero engagement.",
    },
    NO_DENOMINATOR: {
        short: "no denominator",
        long: "Neither a usable view count nor a follower count was available, so there is nothing to normalise against.",
    },
};

/**
 * Formats that carry a view count wherever they appear. Mirrors
 * `VIEW_BEARING_FORMATS` in server/src/analytics/engagement.ts — an Instagram
 * reel reports plays, a carousel on the same account never will, and those two
 * blanks mean different things.
 */
const VIEW_BEARING_FORMATS = new Set(["REEL_SHORT_VIDEO", "LONG_FORM_VIDEO", "LIVE"]);

const ABSENT_DEFAULT = "Not reported by the platform. Absent, not zero.";

/** Raw counts, right-aligned. An em dash means absent, which is not zero. */
function Count({ value, absentTitle }: { value: number | null; absentTitle?: string }) {
    if (value === null) {
        return (
            <td className="n muted" title={absentTitle ?? ABSENT_DEFAULT}>
                —
            </td>
        );
    }
    return <td className="n">{value.toLocaleString()}</td>;
}

function Row({ post, timezone, showShares }: { post: RecentPost; timezone: string; showShares: boolean }) {
    const reason = post.unratedReason === null ? null : UNRATED_REASON[post.unratedReason];

    return (
        <tr>
            <td>
                <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span className="num" style={{ fontSize: 12.5 }}>
                        {new Date(post.postedAt).toLocaleString(undefined, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: timezone,
                        })}
                    </span>
                    {post.isSynthetic && <Badge kind="seeded">Seeded</Badge>}
                </div>
                {post.captionExcerpt !== null && (
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2, maxWidth: "46ch" }}>
                        {post.captionExcerpt}
                    </div>
                )}
            </td>
            <td>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span>{humanise(post.mediaType)}</span>
                    {post.theme !== null && (
                        <span className="muted" style={{ fontSize: 11.5 }}>
                            {humanise(post.theme)}
                        </span>
                    )}
                </div>
            </td>
            <Count value={post.likes} />
            <Count value={post.comments} />
            {showShares && <Count value={post.shares} />}
            <Count
                value={post.views}
                absentTitle={
                    VIEW_BEARING_FORMATS.has(post.mediaType)
                        ? ABSENT_DEFAULT
                        : `${humanise(post.mediaType)} posts do not carry a view count on this platform — there is nothing to report, rather than something withheld.`
                }
            />
            <td className="n">
                {post.ratePct === null ? (
                    <span className="muted" style={{ fontSize: 12 }} title={reason?.long}>
                        {reason?.short ?? "—"}
                    </span>
                ) : (
                    <span title={`Normalised on ${post.basis === "VIEWS" ? "views" : "followers"}.`}>
                        {post.ratePct.toFixed(2)}%
                        <span className="muted" style={{ fontSize: 10.5, marginLeft: 4 }}>
                            {post.basis === "VIEWS" ? "v" : "f"}
                        </span>
                    </span>
                )}
            </td>
            <td>
                {post.permalink === null ? (
                    <span className="muted" style={{ fontSize: 12 }} title="Seeded posts have nothing real to link to.">
                        —
                    </span>
                ) : (
                    <a href={post.permalink} target="_blank" rel="noreferrer">
                        open ↗
                    </a>
                )}
            </td>
        </tr>
    );
}

export function RecentPosts({
    posts,
    timezone,
    matchedPosts,
}: {
    posts: RecentPost[];
    timezone: string;
    matchedPosts: number;
}) {
    if (posts.length === 0) {
        return <p className="muted">No posts on this platform under the current filter.</p>;
    }

    // Instagram and YouTube expose no share count on public data at all — see the
    // `shares: null` in apifyAdapter.ts and youtubeAdapter.ts. On those platforms
    // the column was ten em dashes wide, which reads as "nobody shared any of
    // this" rather than "this number does not exist here". Dropped entirely, and
    // explained below, so the absence is a stated fact rather than an empty
    // column the reader has to interpret.
    //
    // Driven off the data rather than a platform allowlist: X reports reposts and
    // keeps its column, and a CSV import that DOES carry shares for Instagram
    // (fileAdapter.ts maps `shares`/`reposts`) gets it back without a code change.
    const showShares = posts.some((post) => post.shares !== null);
    const platform = posts[0]!.platform;

    return (
        <div>
            <div className="table-scroll">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Posted</th>
                            <th>Format</th>
                            <th className="n">Likes</th>
                            <th className="n">Comments</th>
                            {showShares && <th className="n">Shares</th>}
                            <th className="n">Views</th>
                            <th className="n" title="Weighted interactions ÷ views (v) or followers (f).">
                                Rate
                            </th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {posts.map((post) => (
                            <Row key={post.id} post={post} timezone={timezone} showShares={showShares} />
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
                The {posts.length} most recent of {matchedPosts.toLocaleString()} posts matching the filter, newest
                first, in {timezone} — the account's own zone, the same clock the timing heatmap uses. Unlike every
                other post list here this one is not ranked, so raw counts are shown; a rate of "no metrics" means the
                platform withheld them, not that the post earned nothing.
            </p>

            {!showShares && (
                <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                    No share column: {platform} publishes no share count on public data, so there is no figure
                    to show for any post here. Shares still count toward the rate wherever a platform does report them.
                </p>
            )}
        </div>
    );
}
