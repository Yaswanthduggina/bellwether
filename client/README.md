# client — the Bellwether portal

React + Vite + Recharts. See the root [`README.md`](../README.md) for the product,
and [`ARCHITECTURE.md`](../ARCHITECTURE.md) for how it fits together.

```bash
npm install
npm run dev        # http://localhost:5173
```

The API must be running first (`cd ../server && npm run dev`). `/api` is proxied
to `http://localhost:4000` by `vite.config.ts`, so there is no base URL to
configure — override the target with `VITE_API_URL` if the API is elsewhere.

| Script | |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build |
| `npm test` | mounts the app against payloads captured from the real API |
| `npm run typecheck` | `tsc -b --noEmit` |

`src/__tests__/fixtures.json` is **captured from the running server**, not
hand-written — a hand-written fixture tests a component against the shape its
author believed the API had, which is exactly the bug those tests exist to catch.
Refresh it by re-running the capture against a live API.

It was captured against the 940-post corpus that preceded the Day 4 source change,
so it still contains rows flagged `isSynthetic` and posts on X and Facebook. That
is deliberate for now: the fixture's job is to pin **response shape and component
behaviour**, and it exercises the SEEDED badge and the mixed-provenance paths that
no longer occur in live data but are still reachable via CSV import. A wholesale
recapture would delete that coverage — the live roster has no seeded rows and only
two platforms, which turns those assertions vacuous or breaks them outright.

`src/__tests__/timingLive.json`, `src/__tests__/recentPostsLive.json` and
`src/__tests__/cadenceLive.json` are second captures — of `/api/analytics/timing`,
`/api/analytics/recent-posts` and `/api/analytics/cadence` alone — taken from the
**current** corpus. They exist because those payloads carry things the older
capture cannot: timing gained `minCellN`, `minMarginalN` and `suppressedSlots`,
and neither the recent-posts nor the cadence route existed when `fixtures.json`
was taken. `TimingHeatmap.test.tsx`, `RecentPosts.test.tsx` and the cadence
assertions in `App.test.tsx` need real responses carrying them.

The cadence capture is also the only fixture where a *stale* one would be
actively misleading rather than merely thin: the figure it pins is a rate, and a
rate captured against a different roster looks exactly as plausible as a correct
one.

The vintages are not interchangeable, and the difference is visible in the tests
rather than papered over: the old report still has a FACEBOOK tab that the live
roster no longer has, so mounting the dashboard puts the recent-posts panel on its
"no account on this platform" branch. That branch is asserted in `App.test.tsx`;
the populated table is asserted in `RecentPosts.test.tsx` against the live capture.
