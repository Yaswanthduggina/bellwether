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
no longer occur in live data but are still reachable via CSV import. Recapture it
after the first live ingest if you want the tests reading current data.
