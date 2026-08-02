# Bellwether — Runbook

How to run this project end to end, and how to **swap the principal or the peer set** and rebuild the corpus around the new people.

`README.md` explains *what* the product does and *why* the numbers are the way they are. This file is the operational one: commands, order, cost, and what to do when something is out of quota.

---

## 0. The whole thing in eight commands

Everything below is expanded later. This is the sequence, assuming keys are in place.

```bash
# once
cd server && npm install && cd ../client && npm install

cd server
npx prisma migrate deploy         # create the schema
npx prisma generate               # generate the Prisma client

npm run ingest -- --check-handles # resolve every handle, write nothing, spend almost nothing
npm run ingest -- --roster        # load the roster + pull 90 days of posts
npm run classify                  # assign themes (needs Gemini quota)
npm run recommend                 # grounded recommendations, printed

# then, two terminals
cd server && npm run dev          # http://localhost:4000
cd client && npm run dev          # http://localhost:5173
```

**Order matters in exactly one place:** on a constrained Gemini key, run `npm run recommend` *before* `npm run classify`. Recommendations cost one or two requests; classification costs one request per 25 posts and will eat the daily allowance. See §6.

---

## 1. Keys — what each one unlocks, and what still works without it

All of these live in `server/.env` (copy `server/.env.example`). `.env` is gitignored and has been since the first commit.

| Variable | Required for | What breaks without it |
|---|---|---|
| `DATABASE_URL` | Everything | Nothing runs. This is the only hard requirement. |
| `YOUTUBE_API_KEY` | YouTube ingestion | YouTube accounts fail their ingest run. Existing YouTube posts in the DB are unaffected. |
| `APIFY_API_TOKEN` | Instagram **and** X ingestion | Both platforms fail their ingest runs. Existing rows unaffected. |
| `GEMINI_API_KEY` | Theme classification, recommendations | The AI routes return **503 with an explanation**, not a crash. Every analytics route, every chart, every comparison still works. |

Optional tuning knobs. `X_RESULTS_LIMIT` and `X_MAX_CHARGE_USD` are in `.env.example`; the rest are not, so they are easy to miss:

| Variable | Default | What it does |
|---|---|---|
| `APIFY_RESULTS_LIMIT` | `200` | Instagram posts fetched per account per run. |
| `X_RESULTS_LIMIT` | `150` | X posts per account per run. The actor bills per tweet, so this is the knob that decides what a refresh costs — **but 150 is too low to cover a 90-day window and distorts cadence. Set it to `1500`** (~$0.60 for all four accounts). §4.4. |
| `X_ACTOR` | `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` | Swap the X scraper actor. |
| `X_MAX_CHARGE_USD` | `0.5` | Hard spend guard on an X run. |
| `PORT` | `4000` | Server port. |

⚠️ **The result caps return NEWEST FIRST.** Hitting a cap drops the *oldest* posts in the window, not a random sample. On X this is why `compareCadence` narrows its window, or withholds cross-account cadence figures outright — see §4.4.

### Getting keys

- **Gemini** — <https://aistudio.google.com/apikey>. Free tier, daily quota, resets on a daily cycle.
- **YouTube Data API v3** — Google Cloud Console → enable the YouTube Data API → create an API key.
- **Apify** — Apify Console → Settings → API & Integrations. Free plan carries **$5/month** of actor credit, which is the real budget constraint on Instagram and X.

---

## 2. First-time setup

```bash
git clone https://github.com/Yaswanthduggina/bellwether
cd bellwether

cd server  && npm install
cd ../client && npm install

cd ../server
cp .env.example .env      # then fill it in
npx prisma migrate deploy
npx prisma generate
```

**Supabase gotcha, already documented in `.env.example` and worth repeating:** use the **Session pooler** connection string, not the direct one. Direct connections (`db.<ref>.supabase.co`) are IPv6-only, and on an IPv4 network Prisma fails with `P1001: Can't reach database server` and no useful hint. The pooler username is `postgres.<project-ref>`, not plain `postgres`.

Verify the wiring before spending anything:

```bash
npm run typecheck    # tsc --noEmit
npm test             # 348 tests, no network, no DB
```

---

## 3. Changing the principal or the peers

**This is the section to read before an interview.** There are two ways, and they answer different questions.

| | Path A — the UI | Path B — the config file |
|---|---|---|
| Speed | Seconds, no restart | A code edit + a command |
| Survives `--roster`? | **No** — gets pruned | Yes, it *is* the roster |
| Good for | A live demo: "change the person, watch it fetch" | The real, durable roster |

### 3.1 Path A — through the Accounts page (no code, no restart)

With both servers running, go to **http://localhost:5173 → Accounts**.

1. **Delete the outgoing account.** The confirm dialog names how many posts go with it — deletion cascades to posts and ingestion runs. Do this first if you are replacing the principal: the API refuses a second `PRINCIPAL` on the same platform with a `PRINCIPAL_EXISTS` error naming who currently holds the role.
2. **Add the new account.** Person name, role (`PRINCIPAL` / `COMPETITOR`), platform, handle, timezone (defaults `Asia/Kolkata`).
   - Tick **fetch now** to run the pipeline immediately on create.
   - On a platform with no live adapter (Facebook), the API refuses until you tick the **allow no source** acknowledgement — the account will exist and stay permanently empty, and you have to say you know that.
3. **Fetch** on any existing row re-pulls that one account.
4. **Classify** when the new posts are in — the button paces itself (see §6).

⚠️ **The one trap:** `npm run ingest -- --roster` prunes any account that is not in `config/accounts.ts`, and accounts added through the UI are not in that file. They get deleted along with their posts. After a UI change, refresh with plain **`npm run ingest`** (no `--roster`). The Accounts page says this at the bottom of the screen too.

### 3.2 Path B — through `server/src/config/accounts.ts` (the real roster)

Open `server/src/config/accounts.ts` and edit `DECLARED_ACCOUNTS`. Each person is one `forPerson(...)` block:

```ts
...forPerson("Narendra Modi", "PRINCIPAL", "Narendra Modi", {
    INSTAGRAM: "narendramodi",
    YOUTUBE:   "narendramodi",
    X:         "narendramodi",
    FACEBOOK:  "narendramodi",
}),
```

The arguments are `personName`, `role`, `displayName`, and a map of platform → handle.

**Five things to know before you edit it:**

1. **Declare every platform, including the ones with no adapter.** `TRACKED_ACCOUNTS` is derived by filtering `DECLARED_ACCOUNTS` through `hasLiveAdapter()` in `adapters/index.ts`. You never maintain the tracked/planned split by hand — declaring a Facebook handle today means it starts ingesting automatically the day `facebookAdapter.ts` ships, with no edit to this file. That is exactly how X went live.
2. **Exactly one `PRINCIPAL`.** Everything downstream — comparison, gap analysis, cadence, the report — finds the principal by `role === "PRINCIPAL"` on the account row, not by name.
3. **`PRINCIPAL_NAME` at the bottom of the file is currently unused by any code path.** Changing it alone changes nothing; changing the `role` is what matters. Update it anyway so the file does not lie about who the principal is.
4. **`forPerson` hardcodes `timezone: IST`.** Every tracked account is India-based, so this is correct today. A principal in another timezone needs `forPerson` to take a timezone argument — the timing heatmap is computed in account-local time, so getting this wrong silently rotates the entire heatmap.
5. **Correcting a handle creates a new account.** Accounts key on `(platform, handle)`, so an edited handle upserts a *new* row and orphans the old one with all its posts still attached — the same person then appears twice in every comparison. `--roster` prunes orphans automatically, which is why the next step uses it.

Then, in order:

```bash
cd server

# 1. Resolve every new handle against the live source. Writes nothing.
npm run ingest -- --check-handles

# 2. Load the new roster and pull 90 days for it.
npm run ingest -- --roster
```

**Do not skip step 1.** It prints the resolved display name and follower count for every handle, and it costs one cheap call each. It exists because a wrong handle is the one error the pipeline cannot catch for you — `@amitshah` on Instagram *resolves*, to a namesake with 322 followers, and ingesting it would have attached a private individual's posts to a Union Minister at a perfectly plausible-looking engagement rate. Read what comes back, don't just check it exited 0.

Step 2 prints what it pruned, so you can see the old roster leaving.

Finally, the new posts have no themes yet:

```bash
npm run classify
```

### 3.3 Starting completely clean

```bash
npm run ingest -- --roster --reset
```

`--reset` deletes **every account** (posts and ingestion runs cascade) before rebuilding from config. It is refused without `--roster`, because wiping the database and then not reloading a roster is never what anyone meant.

---

## 4. Extraction (ingestion)

### 4.1 The commands

```bash
npm run ingest                          # refresh every tracked account, last 90 days
npm run ingest -- --days=30             # shorter window
npm run ingest -- --platform=INSTAGRAM  # one platform (INSTAGRAM | YOUTUBE | X)
npm run ingest -- --roster              # reconcile the roster from config first, then refresh
npm run ingest -- --roster --reset      # wipe and rebuild from scratch
npm run ingest -- --check-handles       # resolve handles, write nothing
```

Idempotent throughout. Posts upsert on `(platform, postId)` and accounts on `(platform, handle)`, so running it twice leaves the database exactly as running it once.

There is deliberately **no `npm run seed`**. Nothing in this product generates data; the generator was deleted rather than unwired.

### 4.2 Reading the output

Each account prints `<platform> @<handle> <n> posts <source>/<status>`. Then a summary: total posts in the DB, how many are real (should be all of them), and any failed rows.

A synthetic-post count above zero would be a leftover from the pre-Day-4 seeded era — `--roster` purges those.

### 4.3 What a failed run means — and why that is the good outcome

A source failure ingests **nothing** for that account and records a failed `IngestionRun` row. It does not write the partial page it managed to collect. That is deliberate: a partial scrape stored as a complete one shows a politician posting a fraction of their real volume, and every cadence and share-of-output figure involving them is then wrong with nothing on screen admitting it.

Same principle on YouTube: exhausting the page budget before reaching the edge of the requested window **throws and fails the run**, rather than quietly returning 48 days of a 90-day request.

Ingestion is synchronous and per-account isolated — one account's quota failure does not abort the other three.

### 4.4 Cost, and the caps that bite

- **YouTube** — Data API free quota. Generous for this workload.
- **Instagram / X** — Apify, billed per result, against a $5/month free plan. This is the real budget.
- `X_RESULTS_LIMIT` caps posts per **account**, and the accounts post at wildly different rates. At 160 posts, that bought 15 days of the principal's history and 65 days of a peer's.

That asymmetry produced a false finding once and the guard against it is now in the code: all four X accounts hit the same cap, came out at exactly 17.11 posts/week, and the dashboard reported "the principal posts exactly as often as his peers" — a number measuring the result cap rather than the accounts. `compareCadence` detects that an account's history does not cover the window and refuses to divide by it. What it does next depends on the data:

1. **It re-measures over the window every account does cover** — `windowCovered`, the latest first-post across accounts through to the end. That span is complete for everyone, so one denominator is a denominator in fact and not only in form. The panel states the shortened window and warns that consistency over few weeks is weak evidence.
2. **It withholds the whole comparison** when that span is under 14 days (two weekly blocks — below which consistency reads 100% for anyone who posted at all) or when an account is silent through the start of it too. The sentence says which.

**The cap is the real problem, and it is cheap to fix.** The earlier claim that this needs a paid plan was wrong. The actor bills $0.00025/tweet, so covering the full 90 days for all four X accounts is **~2,400 tweets ≈ $0.60** — inside the $5/month free credit, and inside the `X_MAX_CHARGE_USD` per-run guard at $0.24 for the busiest account:

```bash
# in server/.env
X_RESULTS_LIMIT=1500        # 150 is the code default and is not enough for a 90-day window

npm run ingest -- --platform=X
```

At 1500 the principal's history covers 94% of the 90-day window and X reports cadence over the full window like every other platform. **Watch this number when the roster changes:** the ceiling that matters is the busiest account's daily rate × 90, so a more prolific principal needs a higher cap, and the panel will tell you it narrowed the window before it tells you anything is wrong.

Engagement-rate analysis on X is unaffected — rate is per post, so a shorter history is a smaller sample, not a distorted one.

### 4.5 No API access at all? Import a file

```bash
npm run import -- --file=./export.csv
npm run import -- --file=./export.json --days=90
```

Routes a platform export through the identical pipeline the live adapters use — same normalise → upsert → log path, indistinguishable downstream. Column names are inferred; see `adapters/fileAdapter.ts`.

**The account must already exist.** Import refreshes a corpus, it does not define the roster — a typo'd handle would otherwise create a ghost account that quietly accumulates data nobody asked for. It also resolves every account before writing anything, so a bad file is rejected whole rather than half-applied.

---

## 5. Running the app

```bash
# terminal 1
cd server && npm run dev     # http://localhost:4000

# terminal 2
cd client && npm run dev     # http://localhost:5173
```

Open <http://localhost:5173>.

Useful endpoints when demoing without a UI:

| Endpoint | Notes |
|---|---|
| `GET /api/health` | Liveness |
| `GET /api/analytics/overview` | KPIs |
| `GET /api/analytics/cadence` | Posts/week for every account, person × platform, one window per platform |
| `GET /api/analytics/formats` · `/timing` · `/top-posts` · `/recent-posts` | Per-dimension |
| `GET /api/analytics/compare` · `/gaps` | Principal vs peers |
| `GET /api/analytics/report` | **The whole analytics document — the exact JSON the recommendation model is given.** Costs nothing, needs no Gemini key. |
| `GET /api/ai/classify` | Classification status without running anything |
| `POST /api/ai/classify` | Run classification |
| `GET /api/ai/recommendations` | Generate recommendations |
| `POST /api/ingest` | `{ accountId }` \| `{ platform }` \| `{}` for everything |
| `GET /api/accounts` · `POST` · `DELETE /:id` | Roster CRUD |

Every analytics route takes the same filter block (`platform`, `accountId`, `personName`, `mediaType`, `theme`, `from`, `to`).

---

## 6. Classification when your Gemini quota is gone

**Short answer: you almost certainly do not need to re-run it.** Themes are stored in Postgres on the `Post` row. If the corpus was classified yesterday, it is still classified today — the dashboard, comparison, gap analysis and every chart read the database, not the API. A demo on an already-classified corpus needs **zero** Gemini quota.

You only need quota for posts that have **no theme yet** — i.e. newly ingested ones, which is exactly what happens after you swap the roster.

### 6.1 What still works on a dead key

Everything except two things. With no key or a spent one:

- ✅ All ingestion, all analytics, all charts, comparison, cadence, top/bottom posts, timing heatmap
- ✅ Gap analysis on the `FORMAT`, `HOUR` and `DAY` dimensions
- ✅ `GET /api/analytics/report` — the full evidence document
- ❌ Gap analysis on the `THEME` dimension (needs themes)
- ❌ Recommendations

Both AI routes return **503 with a message explaining what to do**, not a stack trace and not a 500. A spent quota is a degraded-but-expected state in this design, not a fault.

### 6.2 Getting classification running again

**Option 1 — wait for the reset.** The free-tier daily quota resets on a daily cycle. Classification is **incremental and resumable**: it only selects posts where `theme IS NULL`, so a run that died at a quota wall kept everything it wrote and the next run continues from there. Nothing is lost and nothing is redone.

```bash
npm run classify -- --limit=50   # cheap smoke test first — 2 requests
npm run classify                 # then the rest
```

**Option 2 — switch the model, which is the fastest fix and needs no new key.** The free tier meters `GenerateRequestsPerDayPerProjectPerModel`, and the last segment is the one to exploit: **each model has its own daily bucket.** A spent `gemini-3.6-flash` says nothing about `gemini-3.5-flash` on the same key.

This is now automatic. `CLASSIFY_MODELS` / `RECOMMEND_MODELS` in `server/src/ai/gemini.ts` are a **chain**, and a model that returns a daily-quota 429 is skipped for the next one mid-run — logged as `[gemini] <model> is out of daily quota — falling back to <next>`. `QuotaExhaustedError` now fires only when *every* model in the chain is spent. To pin a different chain without touching code:

```bash
# server/.env — comma-separated, primary first
GEMINI_CLASSIFY_MODEL="gemini-3.5-flash,gemini-3.1-flash-lite"
GEMINI_RECOMMEND_MODEL="gemini-3.5-flash"
```

The report says which model actually answered: `modelsUsed` on the classify report, `model` on the recommendations response. More than one entry means the chain fell through.

**Option 3 — a fresh key, with the catch that matters.** The bucket is **per Google Cloud project, not per key.** Minting a second API key inside the same project draws on the same spent allowance and fails with a byte-identical 429 — which reads exactly like "the new key wasn't picked up" and is the single most misleading failure in this system. A fresh allowance means a key from a **new project**, or a different Google account. Reaching 100% coverage on the 1,725-post corpus originally took four across one day.

Paste it into `server/.env` as `GEMINI_API_KEY` and re-run. **No restart is needed, for the scripts or the server**: `readKey()` in `gemini.ts` re-reads `.env` on every call and the SDK client is memoised on the key's *value*, so a swapped key takes effect on the next request. (`tsx watch` would not have helped — it watches imported TypeScript, not `.env`.)

**Option 4 — classify only what you need.** The API route accepts `accountId` and `platform`, so you can classify one account or one platform rather than the whole corpus:

```bash
curl -X POST http://localhost:4000/api/ai/classify \
  -H 'Content-Type: application/json' \
  -d '{"platform":"INSTAGRAM","limit":100}'
```

**Option 5 — the UI button, which is the best one for a demo.** Accounts page → **Classify N posts**. It chunks at 25 posts per request and backs off exponentially (15s → 90s) on rate limits, giving up after 8 consecutive backoffs. That pacing exists for a specific reason: **Gemini's per-minute limit and its per-day limit return an identical error.** Firing batches back to back trips the per-minute one after about eight of them, which reads as "quota exhausted" when fifteen seconds of patience would have cleared it. Every chunk commits as it goes, and **Stop** keeps everything already written.

### 6.3 Budgeting a constrained key

Roughly **one request per 25 posts**. A 1,725-post corpus is ~70 requests; a 2,365-post corpus is ~95. Recommendations cost **one or two requests total**.

So on a nearly-spent key, the order is:

```bash
npm run recommend    # 1–2 requests — do this FIRST
npm run classify     # ~n/25 requests — do this with what remains
```

Classification degrades gracefully; recommendations either happen or don't.

### 6.4 Reading the classification report

| Line | Means |
|---|---|
| `classified` | Written with a model-assigned theme |
| `low confidence` | Model confidence below 0.6 → written as `OTHER`, **original confidence kept** so the threshold can be re-tuned later without re-spending quota |
| `no caption` | Never sent to the model — nothing to read. Costs nothing. |
| `missing` | Sent, but the model skipped that index. Left **unclassified**, not defaulted to `OTHER` — a skipped post is not an `OTHER` post, and the next run picks it up. |
| `STOPPED EARLY` | Quota wall. Everything written is kept; re-run to continue. |

`npm run classify -- --force` re-classifies posts that already have a theme. It costs the whole corpus again. Rarely what you want.

---

## 7. Recommendations

```bash
npm run recommend
npm run recommend -- --platform=YOUTUBE
npm run recommend -- --platform=X --json
```

Prints each accepted recommendation with its priority, confidence, sample size, cited figures and post IDs — then every **dropped** one with the specific validator violation that killed it.

The drop count is the number worth watching. Each recommendation's numeric literals and post IDs are checked against the analytics JSON that was passed in; anything unverifiable is rejected, retried once with the violation named, and dropped if it fails twice. The model never sees raw post data — only the pre-computed analytics document — so structurally it can misread a verified number but cannot invent an unverified one.

### 7.1 How long it takes, and why the panel is not stuck

**A cold run takes 40–70 seconds.** Measured, not estimated: 51s on the unfiltered corpus, 65s on `?platform=X`. The model is handed the entire ~20k-token analytics report and reasons at high thinking — `thoughtTokens` on a typical run is around 11,000. There is no client timeout, so the panel is waiting, not failing; it shows a live elapsed counter so that is visible rather than inferred.

**Repeat views are instant.** The result is cached on the filter **plus a fingerprint of the corpus** — post count, account count, the latest post write, and the summed follower counts. Anything that moves the corpus moves the key: ingesting, classifying, editing the roster, or a refresh that changed only follower counts (engagement rates divide by those, and such a refresh touches no post row — hence their presence in the key). There is no path that serves advice derived from a corpus that has since changed.

```
GET /api/ai/recommendations            51.4s   "cached":false
GET /api/ai/recommendations             0.4s   "cached":true
GET /api/ai/recommendations?platform=X 65.0s   "cached":false   # different filter, correctly a miss
```

The response carries `cached`, and the UI shows a **served from** chip with the original run's time when it is true. The cache lives in the server process only — `npm run recommend` is a fresh process and always calls the model, which is what a hand-invoked command should do.

This matters for more than speed. The panel refetches on every filter change; without the cache a reviewer clicking between platforms spends a model call each time, against a free tier metered at **20 requests per day per model**. And a second call would return the same advice regardless — these run at temperature 0.

---

## 8. Tests

```bash
cd server && npm test        # 348 tests, 20 files
cd client && npm test        #  39 tests,  4 files

cd server && npm run typecheck
cd client && npm run build
```

No network and no database — everything runs against fixtures.

---

## 9. Interview cheat-sheet: "change the person" in three minutes

If you are asked to swap in a different politician live:

```bash
# 1. Edit the roster — one forPerson block in server/src/config/accounts.ts
#    (or do it in the Accounts UI and skip to step 3 with plain `npm run ingest`)

cd server

# 2. Prove the handles are real before spending anything (~15 seconds)
npm run ingest -- --check-handles

# 3. Load the roster and pull the corpus
npm run ingest -- --roster

# 4. Themes for the new posts
npm run classify

# 5. The answer
npm run recommend
```

Three things worth saying out loud while it runs:

- **Step 2 is not ceremony.** `@amitshah` on Instagram resolves to a stranger with 322 followers. Resolving a handle and *reading what came back* is the only thing between a typo and a chart about the wrong person.
- **Nothing above the adapter layer moves when the roster changes.** Same `RawPost` contract, same pipeline, same analytics, same UI. The roster is data.
- **If a source fails, that account ends up empty rather than partial.** A partial pull is not a smaller answer, it is a wrong one — the truncated-window cadence bug in §4.4 is the demonstration.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `P1001: Can't reach database server` | Supabase direct URL is IPv6-only | Use the **Session pooler** string; username is `postgres.<ref>` |
| `No Gemini API key configured` (503) | `GEMINI_API_KEY` empty | Set it in `server/.env`. Both `GEMINI_API_KEY` and lowercase `gemini_api_key` are read — Windows env-var case handling made that necessary |
| Recommendations panel spins for ~a minute | Working as designed — a cold run is 40–70s | §7.1. The panel shows elapsed seconds; there is no client timeout, so it is waiting rather than failed. Don't reload — that restarts the clock and abandons nothing server-side |
| `Gemini quota exhausted` (503) | Every model in the chain has spent its daily allowance | §6.2. Work already done is saved; re-run continues from there |
| A **new key** gives the identical quota 429 | The free-tier bucket is per **project**, not per key — a second key in the same project shares the spent allowance | Use a key from a new project or another Google account, or set `GEMINI_CLASSIFY_MODEL` to a model with its own untouched bucket. §6.2, Options 2 and 3 |
| `Monthly usage hard limit exceeded` | Apify credit gone | Top up, or lower `APIFY_RESULTS_LIMIT` / `X_RESULTS_LIMIT`. The run failed cleanly and wrote nothing |
| `FACEBOOK has no live adapter yet` | Working as designed | Facebook is declared, not ingested. Import a CSV/JSON export instead |
| `Account is flagged isSynthetic` | Leftover from the seeded era | `npm run ingest -- --roster` — purges its generated posts and re-points it at the live adapter |
| `PRINCIPAL_EXISTS` on create | Two principals on one platform | Delete the existing principal first, or add the new one as `COMPETITOR` |
| Cadence panel is all dashes, "comparison withheld" | An account's history does not cover the window, and the covered span is under 14 days | Raise `X_RESULTS_LIMIT` to 1500 and re-ingest X (~$0.60). §4.4 |
| Cadence says "Measured over the last N days rather than 90" | Working as designed — the window was narrowed to the span every account covers | Same fix as above. The figures shown are honest; they just cover less history. §4.4 |
| Accounts I added in the UI vanished | `npm run ingest -- --roster` pruned them | Use plain `npm run ingest`, or add them to `config/accounts.ts` |
| Ingest reports 0 posts for an account | Genuinely nothing in the window, or a wrong handle | `npm run ingest -- --check-handles` and read the resolved name |
