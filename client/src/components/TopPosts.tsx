// FR8 — best and worst posts, with permalinks.
//
// Ranked on engagement RATE, never on raw likes. Sorting by raw counts is the
// first trap the brief names: it ranks reach rather than resonance, and on a
// mixed corpus it would simply rank the accounts with the most followers.
//
// A synthetic post has no permalink because there is nothing real to link to,
// and this renders the seeded badge in that slot rather than a dead link.

import type { ReportPost } from "../api/client";
import { Badge, humanise } from "./ui";

function Row({ post }: { post: ReportPost }) {
    return (
        <tr>
            <td>
                <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span>{humanise(post.mediaType)}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                        {new Date(post.postedAt).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                        })}
                    </span>
                    {post.isSynthetic && <Badge kind="seeded">Seeded</Badge>}
                </div>
                {post.captionExcerpt !== null && (
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2, maxWidth: "52ch" }}>
                        {post.captionExcerpt}
                    </div>
                )}
            </td>
            <td className="n">{post.ratePct.toFixed(2)}%</td>
            <td className="n">{post.multipleOfMedian.toFixed(2)}×</td>
            <td>
                {post.permalink === null ? (
                    <span className="muted" style={{ fontSize: 12 }}>
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

function Table({ title, posts }: { title: string; posts: ReportPost[] }) {
    if (posts.length === 0) return null;

    return (
        <div>
            <span className="eyebrow">{title}</span>
            <div className="table-scroll">
                <table className="table" style={{ marginTop: 6 }}>
                    <thead>
                        <tr>
                            <th>Post</th>
                            <th className="n">Rate</th>
                            <th className="n">vs median</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {posts.map((post) => (
                            <Row key={post.id} post={post} />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export function TopPosts({ best, worst }: { best: ReportPost[]; worst: ReportPost[] }) {
    if (best.length === 0 && worst.length === 0) {
        return <p className="muted">No rated posts on this basis.</p>;
    }

    return (
        <div className="split">
            <Table title="Best" posts={best} />
            <Table title="Worst" posts={worst} />
        </div>
    );
}
