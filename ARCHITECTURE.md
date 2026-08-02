# Bellwether — Architecture & Build Plan

Companion to `README.md`. This file covers **how the system is put together** and **the order it gets built in**.

---

## Part 1 — Architecture

### 1.1 The governing idea

Four things flow one direction and never backwards:

```
   SOURCES            INGESTION           ANALYSIS            PRESENTATION
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│  YouTube   │     │            │     │            │     │            │
│  API       │────▶│ normalize  │────▶│ engagement │────▶│  Express   │
│            │     │     ↓      │     │ format     │     │  REST API  │
│  Instagram │────▶│  upsert    │────▶│ timing     │     │     ↓      │
│  via Apify │     │     ↓      │     │ compare    │     │  React SPA │
│            │     │  run log   │     │ gaps       │     │            │
│  CSV/JSON  │────▶│            │     │            │     │            │
│  import    │     └────────────┘     └─────┬──────┘     └────────────┘
└────────────┘            │                 │                   ▲
       │                  ▼                 ▼                   │
       │           ┌────────────┐    ┌────────────┐             │
       └──────────▶│  Postgres  │    │  AI LAYER  │─────────────┘
   all speak the   │  (Prisma)  │    │  classify  │
   SAME interface  └────────────┘    │  recommend │
                                     │  validate  │
      ┌ ─ ─ ─ ─ ─ ┐                  └────────────┘
        Facebook   │              receives analytics JSON only —
      │ PLANNED                     never raw posts
      └ ─ ─ ─ ─ ─ ┘
   declared in the registry with
   its blocker; no adapter yet,
   and no generated stand-in either
```

Three boundaries are deliberate and load-bearing:

1. **Every source implements one interface.** Nothing downstream of `SocialAdapter` knows or cares whether a post came from the YouTube API, an Apify actor, or a CSV upload. Adding a platform means adding one file and flipping one registry entry from `PLANNED` to `LIVE`.
2. **Analysis reads the database, never a source.** All analytics run over normalised, persisted rows. Nothing is recomputed from raw JSON on page load.
3. **The AI layer sits *downstream* of analysis, not beside it.** The recommendation model consumes verified computed output. This is the anti-fabrication mechanism, expressed as an architectural constraint rather than a prompt instruction.

### 1.2 Directory layout

```
server/src/
├── adapters/               # ← ONE interface, many sources
│   ├── types.ts            #   RawPost + SocialAdapter contract          ✅ done
│   ├── youtubeAdapter.ts   #   YouTube Data API v3                       ✅ done — 108 live posts
│   ├── apifyAdapter.ts     #   Instagram via Apify actors                ✅ done
│   ├── fileAdapter.ts      #   CSV/JSON import — a MUST, not a nicety    ✅ done
│   ├── xAdapter.ts         #   X via Apify actor                          ✅ done — 640 live posts
│   ├── facebookAdapter.ts  #   Facebook                                  🟡 planned — blocker in the registry
│   └── index.ts            #   registry: platform → LIVE | PLANNED       ✅ done
│
├── ingestion/                                                            # ✅ all done
│   ├── normalize.ts        #   RawPost → Prisma Post input
│   ├── upsert.ts           #   idempotent write on (platform, postId)
│   ├── runLog.ts           #   opens/closes IngestionRun rows
│   └── pipeline.ts         #   orchestrates: fetch → normalize → upsert → log
│
├── analytics/              # ← deterministic. tested. no LLM anywhere near this.  🔨 Day 2
│   ├── engagement.ts       #   THE formula. weights + per-platform denominator + erBasis
│   ├── format.ts           #   mean/median/stdev/IQR/n by media type
│   ├── timing.ts           #   day×hour in account-local tz, sample-size gated
│   ├── topPosts.ts         #   best/worst per platform and per format
│   ├── compare.ts          #   principal vs peer set, same metrics
│   ├── gaps.ts             #   formats/slots/themes competitors own — plus the
│   │                       #   near misses, i.e. what was rejected and by which gate
│   ├── cadence.ts          #   posting frequency vs performance   (SHOULD)
│   │                       #   when a history does not span the window: narrows to
│   │                       #   the span every account covers, or withholds the
│   │                       #   figures — see DECISIONS §2.8 and §2.8a
│   └── buildReport.ts      #   assembles the ONE analytics JSON the AI layer consumes
│
├── ai/
│   ├── client.ts           #   Gemini client + model choice
│   ├── taxonomy.ts         #   the 8 content pillars, as a shared constant
│   ├── classify.ts         #   batched: caption + mediaType → {theme, confidence}
│   ├── recommend.ts        #   analytics JSON → ranked recommendations w/ evidence
│   └── validate.ts         #   pure code. every number & post_id must exist. no LLM.
│
├── api/routes/
│   ├── accounts.ts · ingest.ts · analytics.ts · ai.ts · export.ts
│
├── __tests__/              # Vitest — concentrated on analytics/
├── db.ts                   # PrismaClient + adapter-pg, single instance
└── server.ts               # Express bootstrap

client/src/
├── pages/       Dashboard · Accounts · Compare
├── components/  KpiRow · FormatChart · TimingHeatmap · RecommendationList
│                GapPanel · TopPostsTable · Filters · SeededBadge
└── api/client.ts
```

**The rule that keeps files small:** a file does one job. `engagement.ts` computes rates and nothing else. `timing.ts` buckets and nothing else. No 800-line module doing six jobs.

### 1.3 Data model

Three tables, already migrated. The design principle in one line: **provenance is a column, not a code path**, so analytics, AI and UI never branch on where a row came from — they read a flag. Every row is now live, which makes the flag a guard rather than a switch: nothing writes `isSynthetic: true` any more, and the registry refuses to ingest an account still carrying it.

| Table | Holds | Notable |
|---|---|---|
| `Account` | one row per **account per platform** | `personName` links the same human across platforms — which is what lets one person be compared across YouTube and Instagram, and lets a person present on one and absent from the other say so. `@@unique([platform, handle])` |
| `Post` | normalised posts | metrics individually nullable (platforms disagree on what they expose). `@@unique([platform, postId])` is the idempotency guard — FR15 falls out of the schema for free |
| `IngestionRun` | one row per fetch attempt | source, rows fetched/failed, status, error note. First thing anyone opens when a number looks wrong |

**Derived metrics are not stored.** Engagement rate is computed in `analytics/engagement.ts` at query time, not written to `Post`. Follower counts change, so a stored rate goes stale silently — and a single computation path is a single thing to test. If it ever gets slow, the fix is a cache with an explicit TTL, not a denormalised column.

**Two schema properties worth calling out**, both added in the Day 0 hardening migration:

- `Account.timezone String @default("Asia/Kolkata")` — FR7 requires the heatmap in account-local time, and the conversion needs a column to read from rather than a constant buried in the timing code.
- `onDelete: Cascade` on both relations to `Account`. FR1 is a MUST — the user removes tracked accounts from the UI — and Prisma's default (`Restrict`) makes that fail with a foreign-key error the moment an account has posts. Cascade over soft-delete because the audit value of orphaned rows doesn't justify the query complexity in a four-day build.

### 1.4 API surface

```
GET    /api/health                        liveness AND database readiness

GET    /api/accounts                      list tracked accounts
POST   /api/accounts                      add principal or competitor        (FR1)
DELETE /api/accounts/:id                  remove                             (FR1)

POST   /api/ingest                        run pipeline (optionally one account/platform)
POST   /api/import                        CSV/JSON upload                    (FR3)
GET    /api/ingestion-runs                audit trail                        (FR14)

GET    /api/analytics/overview            KPI row
GET    /api/analytics/formats             format × platform stats            (FR6)
GET    /api/analytics/timing              day×hour heatmap + n per cell      (FR7)
GET    /api/analytics/top-posts           best/worst + permalinks            (FR8)
GET    /api/analytics/recent-posts        the principal's last n, by date    (?count=, max 50)
GET    /api/analytics/compare             principal vs peers                 (FR9)
GET    /api/analytics/gaps                gap analysis                       (FR10)
GET    /api/analytics/report              the whole analytics document

POST   /api/ai/classify                   run/refresh theme classification   (FR11)
GET    /api/ai/recommendations            grounded, validated, ranked        (FR12)

GET    /api/export/report.md              sample output deliverable          (FR17)
```

All analytics routes accept the same filter block — `accountId`, `platform`, `from`, `to`, `mediaType`, `theme` (FR16) — parsed once in shared middleware so filters are not reimplemented six times.

### 1.5 The AI layer, precisely

| Step | Runs | Input | Output |
|---|---|---|---|
| Classify | LLM, batched ~20 posts/call | `caption` + `mediaType` only | `{post_id, theme, confidence}[]` |
| Recommend | LLM, one call per report | **`buildReport.ts` output only** — never raw posts | `{recommendation, action, evidence[], priority}[]` |
| Validate | **pure code, no LLM** | LLM output + the analytics JSON that produced it | pass / reject-with-reason |

`validate.ts` in three rules:

1. Extract every numeric literal from the model's output. Each must match a value present in the input analytics JSON, within a rounding tolerance.
2. Every cited `post_id` must exist in the database.
3. Every recommendation must carry a sample size, and any recommendation resting on `n < 5` is dropped.

On failure: retry once, naming the specific violation. On second failure: drop the recommendation and log the drop. **A dropped recommendation is better than a fabricated one**, and a visible drop count is better than a silent one.

The quality bar for output — the difference between a rendered chart and a usable product:

> ❌ "Post more reels."
> ✅ "Reels posted 7–9pm IST earn **3.1×** the engagement rate of your static images and **2.4×** your own daytime reels, across **34 reels in 90 days**. Move the Tuesday and Thursday slots to evening."

Every recommendation must carry: **a multiple, a baseline it's measured against, a sample size, and a concrete action.**

---

## Part 2 — Build plan

**Clock:** Thu Jul 30 → Sun Aug 2 night. Four working days, ~6 hrs each.

**Win condition:** every MUST done cleanly, 2–3 SHOULDs, at most one STRETCH. Two platforms done properly beats four half-wired.

### Day 0 — Wed Jul 29 ✅ complete

Prisma schema designed and migrated to Supabase · adapter interface (`SocialAdapter` / `RawPost`) written before any adapter · seed adapter working · principal and peer set chosen · stack finalised.

### Day 1 — Thu Jul 30 · ingestion works end to end ✅ complete

Goal by end of day: **posts are in the database, from more than one source, and re-running doesn't duplicate them.** Met — 940 posts, four platforms, three sources, 69 tests green.

- [x] ~~Clear the blockers in §3.2~~ — done in the Day 0 hardening commit
- [x] ~~`db.ts` — PrismaClient wired with `@prisma/adapter-pg`~~ — done, verified against Supabase
- [x] ~~Fix the seed generator so the data actually contains signal (§3.3)~~ — reach-first model, every multiplier a documented constant
- [x] ~~`normalize.ts` + `upsert.ts` + `runLog.ts` + `pipeline.ts`~~
- [x] ~~Account seeding: Tharoor + 3 peers × 4 platforms, with follower counts and timezone~~ — 16 accounts
- [x] ~~`csvAdapter.ts` — CSV/JSON import~~ — shipped as `fileAdapter.ts`; it handles both formats behind one entry point, so naming it for CSV alone would have been misleading
- [x] ~~`youtubeAdapter.ts` — real API, same interface~~ — 108 live posts from 3 verified channels
- [x] ~~Tests: normalisation mapping, idempotent re-ingestion~~ — 69 tests, 5 files
- [x] ~~Commit at each step, not once at the end~~ — 5 commits, one per working piece

### Day 2 — Fri Jul 31 · the analytics engine

Goal: **every number the product will ever show is computed and tested.**

- [ ] `engagement.ts` **first** — write the formula, document it, test it, before anything consumes it
- [ ] Basis-mixing guard: aggregating `VIEWS`- and `FOLLOWERS`-based rates together must throw
- [ ] `format.ts` — mean, median, stdev, IQR, n (spread is explicitly required)
- [ ] `timing.ts` — UTC → account-local bucketing, `n` per cell, suppression thresholds
- [ ] `topPosts.ts` — best/worst per platform and format, with permalinks
- [ ] `compare.ts` — principal vs peer set
- [ ] Tests against hand-computed fixtures — **this is the 25% analytical-soundness criterion**

### Day 2 — Fri Jul 31 · the analytics engine ✅ complete

Goal met: every number the product will show is computed and tested. 175 tests, `tsc` clean. Verified against the real 940-post corpus, not only fixtures.

**What the engine found on the real data** — the planted gap surfaced on its own, which is the point of the exercise:

```
[Shashi Tharoor / X]  107 posts, views-normalised
  REEL_SHORT_VIDEO  n=14  median 6.84%  1.82x overall
  CAROUSEL          n=13  median 6.15%  1.64x
  TEXT_ONLY         n=37  median 3.47%  0.92x
  SINGLE_IMAGE      n=22  median 2.83%  0.75x
  LINK              n=21  median 2.43%  0.65x
```

That is `FORMAT_QUALITY` (1.9 · 1.25 · 1.0 · 0.75 · 0.55) recovered in exact order by code that has never seen those constants. The principal ranks **4 of 4** on every platform — 2.66× behind the peer benchmark on X — which is the central planted gap, discovered rather than asserted. The mixed-provenance note fires correctly on YouTube, naming Varun Gandhi as the seeded account.

**⚠️ One finding that changes Day 3.** Tharoor's own best hours come out as 10:00, 11:00 and 08:00 — all at roughly **1.0×** his overall median. The 7–9pm peak is nowhere in his data, and the engine is not wrong: he posts between 08:00 and 16:00 and never in the evening, so *his corpus contains no evidence that evenings are better.*

**An account's own timing data cannot reveal a slot it never posts in.** So a timing recommendation drawn only from the principal will always say "keep doing roughly what you do". The evening peak is visible only in the competitors' corpora — which means `gaps.ts` is not a nice-to-have that rounds out the comparison, it is **the only place a timing recommendation can legitimately come from**. Build it before `recommend.ts`, and make the recommendation prompt draw timing evidence from the peer set with the principal's own thin coverage stated as the reason.

### Day 3 — Sat Aug 1 · AI layer + the portal

Goal: **it runs end to end in a browser.** Longest day; start early.

- [ ] `gaps.ts` — formats, slots and themes competitors own that the principal doesn't. **Do this first**, and see the Day 2 warning above: it is the only source of a defensible timing recommendation
- [ ] `buildReport.ts` — the single analytics JSON the AI consumes
- [ ] `classify.ts` — batched, schema-constrained, confidence stored
- [ ] `recommend.ts` + **`validate.ts` in the same sitting** — build the validator *with* the generator, never after
- [ ] Express routes
- [ ] React: Accounts CRUD → Dashboard → Compare
- [ ] **Recommendations panel at the top of the dashboard**, not buried below the charts

### Day 4 — the source change ✅ complete

**The synthetic corpus is gone.** The requirement arrived from outside the build
plan: no seeded data in the product, at all. What changed, and — more usefully —
what did not:

| Layer | Change |
|---|---|
| `adapters/apifyAdapter.ts` | **New.** Instagram via `apify/instagram-post-scraper` (posts) and `apify/instagram-profile-scraper` (follower count, the ER denominator for stills) |
| `adapters/index.ts` | Registry records a `status` per platform: `LIVE` for YouTube, Instagram and X, `PLANNED` with a stated blocker for Facebook. Nothing routes to the seed adapter |
| `config/accounts.ts` | All four platforms declared; `TRACKED_ACCOUNTS` derived by filtering on `hasLiveAdapter`, so an adapter landing flips its accounts on with no roster edit |
| `scripts/ingest.ts` | `seed.ts` folded in as `--roster`. A command named "seed" describing a system that seeds nothing is a trap for the next reader |
| Everything else | **Untouched.** Same `RawPost`, same validate → normalise → upsert → log, same analytics, same AI layer, same API, same UI |

That last row is the point of the adapter contract, and this is the first time it
has been tested by a change it did not anticipate: swapping a platform's entire
data source moved 4 files and 0 lines of analytics.

**What it cost.** Two platforms of coverage at the time — X and Facebook contributed nothing
until someone builds their adapters. The corpus is smaller and the peer set is
uneven (Varun Gandhi is Instagram-only, with 28 lifetime posts). Those are real
losses, and they are the correct trade: a finding drawn from generated data is not
a smaller finding, it is a different kind of thing.

### Day 4 — Sun Aug 2 · SHOULDs, then ship

Goal: **submittable by evening, with hours to spare.**

- [ ] Filters (FR16) · Markdown export (FR17) · theme × format (FR18) — in that order, stop when time runs out
- [ ] Finish `README.md` status table and limitations · write `DECISIONS.md`
- [ ] Generate the sample report for the principal — written for a comms manager, not a reviewer
- [ ] **Clean-clone test**: fresh folder, `git clone`, follow the README verbatim, confirm it runs
- [ ] Record the 5–8 min video — demo the four questions, then 2 min on what's next and what you'd do differently
- [ ] Confirm no `.env` and no keys anywhere in git history

### Cut list — sacrifice in this order

`theme × format` → `filters` → `PDF export (keep Markdown)` → `any stretch item` → `the second live platform (seed X, say so plainly)`

**Never cut:** the validator, the tests on `engagement.ts`, `DECISIONS.md`, the clean-clone test.

**Overtaken on Day 4 — "seed X, say so plainly" is no longer an available move.** The
cut list's last resort was to seed a platform and label it. The no-synthetic-data
requirement removes that option entirely, which makes the list shorter and the
remaining choice starker: a platform is either read for real or left visibly empty.
Worth recording because the plan's safety net is gone, not because the plan was wrong.

**Corrected on Day 3 — `cadence analysis` was first on this list and should never have been on it.** The Module C MUST reads "principal vs. competitors on engagement, cadence and best-performing windows, on one screen." Cadence is named *inside* a required deliverable, so the plan's first sacrifice would have broken a MUST while the list still read as though every item on it were optional. It was mis-filed as a Module B SHOULD — which it also is, and that is what caused the error: an item that appears in two places inherits the weaker priority unless someone checks. Built on Day 3 in `analytics/cadence.ts`.

---

## Part 3 — Day 0 verification (run Wed Jul 29 evening)

Verified against the actual repo, not assumed.

### 3.1 What passes ✅

| Check | Result |
|---|---|
| Supabase connection | ✅ `prisma migrate status` → "Database schema is up to date" |
| Migration applied | ✅ `20260729124256_add_core_models` — 3 tables, 4 enums, 2 FKs, 6 indexes |
| Idempotency guard present | ✅ `@@unique([platform, postId])` in the migration SQL |
| Seed adapter runs | ✅ generated 48 posts, correctly shaped `RawPost` |
| `views` only on video types | ✅ `mediaType.includes("VIDEO")` catches both video enums |
| Deterministic `postId`s | ✅ `seed_instagram_<handle>_<i>` — re-seeding will upsert, not duplicate |
| Secrets not committed | ✅ `.env` gitignored from the first commit |

The architectural instinct was right: interface before adapters, schema before code, `isSynthetic` in the schema rather than in a README footnote.

### 3.2 Resolved in the Day 0 hardening commit ✅

| # | Was | Fix |
|---|---|---|
| ② | `tsc --noEmit` failed — TS 7 removed `moduleResolution: node10`. `tsx` ignored it, which is why the seed adapter still ran while the typecheck was broken | `module: ESNext`, `moduleResolution: bundler`, `target: ES2023`. **Typecheck now passes clean** |
| ③ | `schema.prisma` declared the removed `prisma-client-js` generator with no `output`, while `generated/prisma/` held Prisma 7's **ESM** output — in a `"type": "commonjs"` project. Latent `ERR_REQUIRE_ESM` waiting for the first import | Server moved to **ESM** (`"type": "module"`); generator declared explicitly as `prisma-client` with `output`, `runtime = "nodejs"`, `moduleFormat = "esm"`. Prisma 7 is ESM-first — forcing it back to CJS costs more than moving |
| ④ | `@prisma/adapter-pg` installed but unused; no `PrismaClient` anywhere | `src/db.ts` — singleton client over `PrismaPg`, fails loudly on missing `DATABASE_URL`, reuses the pool across hot reloads. **Verified against Supabase: connects and queries** |
| — | `Post`/`IngestionRun` → `Account` used the default `onDelete: Restrict`, so FR1's "remove an account" would throw an FK error | `onDelete: Cascade` (migration `20260729154304`) |
| — | No `Account.timezone`, but FR7 requires account-local time | Column added, `Asia/Kolkata` default |
| — | `SocialAdapter` had no way to return follower counts — the ER denominator — so the YouTube adapter would have had no channel for subscriber count | `fetchAccountMeta()` added to the interface; seed implementation derives a **stable** count from the handle so the denominator doesn't move between seed runs |
| — | `RawPost.postedAt` comment showed `+05:30`; code emits `Z`. `test.ts` was a `console.log` script that read like a test suite | Comment corrected to state the UTC-store / local-present split; `test.ts` deleted |
| — | No npm scripts — only the default failing `test` | `typecheck`, `test` (vitest), `db:generate`, `db:migrate`, `db:deploy`, `db:studio`. `.env.example` added |

### 3.3 The seed generator — ✅ resolved in `c4f8300`

*Kept as written on Day 0, because the diagnosis is what shaped the fix. Resolution at the end of the section.*

**① The seed data contains no signal — this is the next task.**

Measured over 48 generated posts:

```
distinct hours-of-day: [ 13 ]     ← every post lands at the same hour
avg likes by format:  CAROUSEL 9927 · LINK 7130 · TEXT_ONLY 8189
                      REEL 7278 · SINGLE_IMAGE 7311 · LONG_FORM 9517
```

Two consequences, both fatal to graded MUSTs:

- `randomDateWithin()` subtracts a whole number of *days* from `Date.now()`, so the hour never varies. **The day×hour heatmap (FR7) renders as a single vertical stripe.**
- Likes are `randomInt(500, 15000)` regardless of format, hour or theme — the spread above is pure noise. **Format analysis (FR6) will correctly find nothing, and the recommendation layer will have no real pattern to cite.**

The seed generator needs *deliberately planted* patterns — reels beating statics, evenings beating mornings, one theme underperforming, plus a couple of viral outliers so the mean-vs-median outlier flag has something to catch. That gives you two things at once: a demo where the AI layer has something true to say, and **known-input/known-output fixtures for the analytics tests** — you can assert the pipeline recovered the pattern you planted.

**Resolution.** The generator was rewritten to model reach first (`reach = followers × reachFactor(format)`, then `interactions = reach × BASE_ER × format × hour × day × theme × noise`). The ordering is the load-bearing part: engagement *rate* is interactions ÷ reach, so deriving reach **from** interactions would have cancelled the planted signal back out to noise no matter how much structure the raw counts appeared to carry.

Planted constants, all exported from `src/__tests__/fixtures/plantedCorpus.ts`. The generator itself was deleted with the seeded corpus (DECISIONS §1.7) — what survives is the fixture, which emits plain analytics rows and implements no adapter interface, so it can be read by tests but never routed to by ingestion:

| Pattern | Planted as |
|---|---|
| Short video wins, link-outs are suppressed | `FORMAT_QUALITY` — `REEL_SHORT_VIDEO 1.9` … `LINK 0.55` |
| Sharp 7–9pm IST peak, dead overnight | `HOUR_QUALITY` — `20 → 1.85`, `03 → 0.35` |
| Midweek lift, weekend sag | `DAY_QUALITY` — `Wed 1.12`, `Sat 0.82` |
| Conflict and personal content travel; greetings don't | `THEME_QUALITY` — `ATTACK_REBUTTAL 1.5` … `FESTIVAL_GREETING 0.7` |
| Outliers exist | `VIRAL_RATE 0.04`, `VIRAL_BOOST 6.5` — the mean-vs-median flag has something real to catch |

**The central planted gap**, which is what makes Module C non-vacuous: the principal posts policy and media appearances at safe daytime hours and rarely uses short video, while two competitors lean on the two highest-performing themes and post reels into the evening peak. The pipeline is supposed to surface that on its own; the demo is only honest if nobody hard-codes it.

Measured after the rewrite: **20 distinct posting hours** across 940 posts, against 1 before.

### 3.4 Verified green

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `prisma validate` | ✅ schema valid |
| `prisma migrate status` | ✅ 2 migrations, database in sync |
| PrismaClient → Supabase via `adapter-pg` | ✅ connects, queries, disconnects |
| `fetchAccountMeta()` stability | ✅ identical across calls |
| Secrets in git history | ✅ none — `.env` gitignored from commit #1 |
| Repository visibility | ✅ **private** (Deliverable 1 requires it; the brief's footer forbids public publication) |

### 3.5 Day 1 status — ✅ complete, verified Thu Jul 30

Re-verified against the running system, not assumed.

| Check | Result |
|---|---|
| `npm test` | ✅ 69 passing, 5 files |
| `tsc --noEmit` | ✅ clean |
| Posts persisted | ✅ **940** — X 275 · Instagram 263 · Facebook 263 · YouTube 139 |
| Live data | ✅ **108** YouTube posts from 3 verified channels via Data API v3 |
| Distinct posting hours | ✅ **20** — §3.3's single-stripe heatmap defect is fixed |
| Audit trail populated | ✅ 48 `IngestionRun` rows |
| Idempotency in practice | ✅ re-running `seed` and `ingest` leaves the row count unchanged |
| Secrets in git | ✅ none — working tree clean, `.env` gitignored |

**Known state going into Day 2:** `analytics/`, `ai/`, `api/` and `server.ts` do not exist yet; `client/` is still an empty directory. That is on plan — Module B starts today, the portal on Day 3.

**One item §3.3 did not anticipate.** YouTube ended up *mixed provenance*: three tracked people have a verified channel, the fourth does not, so 108 live posts and 31 seeded posts share a platform. Every other platform is uniformly one or the other. Analytics must therefore carry provenance **per account**, not per platform — a platform-level `isSynthetic` rollup would report YouTube as "real" while a quarter of its rows are generated. `compare.ts` and `gaps.ts` are the two places this can go wrong quietly.

---

## Part 4 — Traps to avoid

Drawn straight from the brief's "what will hurt you", plus what the verification turned up.

| Trap | Guard |
|---|---|
| Ranking on raw followers or raw likes | Every comparison goes through `engagement.ts`. No raw-count sort anywhere in the UI. |
| LLM citing a number that isn't in the data | `validate.ts`, built the same day as `recommend.ts` — never bolted on afterwards |
| README implying seeded data is live | Moot as of Day 4 — there is no seeded data. The guards stay anyway: provenance table at the top of the README, `isSynthetic` at row level, SEEDED badge in the UI, and a registry that refuses to ingest a flagged account. A removed guard is a regression nobody sees |
| A platform quietly dropped instead of decided | Facebook stays declared in the roster and in the registry with its blocker. An absent platform gets rediscovered from first principles; a `PLANNED` one gets closed — X was, on Day 5, by re-reading the blocker and finding that it named an API rather than a platform |
| A single giant commit | Commit per working piece. Commit history is read as evidence of process. |
| Committed `.env` | Already gitignored ✅ — verify once more before submitting |
| Confident claims from six data points | Suppression thresholds enforced in `timing.ts` and `format.ts`, not just styled in CSS |
| A format looking good because of one viral post | mean **and** median reported; `mean/median > 1.5` flags the distribution as outlier-driven |
| Code you can't explain in the interview | Every non-obvious choice gets a comment at the point of the decision, and a line in `DECISIONS.md` |
