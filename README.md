# Bellwether

A social media intelligence portal for political communications teams.

Bellwether ingests the last 90 days of **public** posts for a principal and their peer set across Instagram, Facebook, X and YouTube, normalises everything into one schema, and answers four questions:

1. **What content works?** — performance by media format, on a normalised engagement measure, with spread (not just averages).
2. **When should we post?** — day × hour heatmap per platform in the account's local timezone, with sample sizes shown and thin cells suppressed.
3. **How do we compare?** — the principal against their peer set on identical metrics, one screen.
4. **So what do we do?** — a ranked list of recommendations, each one traceable to specific posts and figures in the data.

Question 4 is the point of the product. Everything above it exists to make the recommendations defensible.

---

## ⚠️ Data provenance — read this first

**Not all data in this portal is live.** The table below is the honest state of every platform.

| Platform | Source | Live? | Why |
|---|---|---|---|
| YouTube | YouTube Data API v3 | 🟢 **Live** | Official API, public channel data, workable free quota |
| X | Seeded | 🔴 **Synthetic** | Free tier read caps are far below a 90-day pull across four accounts. Assessed on Day 1 and rejected rather than half-wired — see `DECISIONS.md` |
| Instagram | Seeded | 🔴 **Synthetic** | Graph API requires a Business/Professional account you control plus app review — not obtainable in the project window |
| Facebook | Seeded | 🔴 **Synthetic** | Same as Instagram |

Synthetic data is not hidden. It is marked at the row level:

- `Account.isSynthetic` and `Post.isSynthetic` are booleans on every row
- Synthetic captions are prefixed `[synthetic]`
- Synthetic posts carry `permalink: null` — there is nothing real to link to
- The UI shows a **SEEDED** badge anywhere synthetic data contributes to a number

No live-account data was scraped from behind a login wall, and no platform authentication or rate limit was circumvented. Only public accounts and public content. See [Ethics & scope](#ethics--scope).

---

## Who we track, and why

**Principal:** **Shashi Tharoor** — sitting Lok Sabha MP (Thiruvananthapuram), unusually active and multi-platform, with a confirmed "Shashi Tharoor Official" YouTube channel. He posts across all four platforms in volume, which means the format and timing analysis has something to actually chew on.

**Peer set:**

| Account | Office / tier | Why they're a fair comparison |
|---|---|---|
| Priyanka Chaturvedi | Rajya Sabha MP | National-profile parliamentarian, very active on X, confirmed active YouTube channel, heavy media-appearance content |
| Varun Gandhi | Former Lok Sabha MP | Comparable national profile and communication style — long-form written positions, policy-forward content |
| Kanhaiya Kumar | National politician, contested Lok Sabha | Different generational and format mix (video-heavy, rally-forward) — deliberately included so the format gap analysis has genuine contrast |

**On comparability:** the brief warns against benchmarking a 20M-follower national figure against a first-term MLA. These four are all national-profile parliamentary-tier figures — but their follower counts are *not* identical, and that is precisely why **nothing in this portal ranks on raw followers or raw likes**. Every cross-account comparison runs on a normalised engagement rate with an explicit denominator. See below.

---

## The engagement rate formula

The single most important number in the product, so it gets the most scrutiny.

### Numerator — weighted interactions

```
interactions = (1 × likes) + (3 × comments) + (5 × shares) + (4 × saves)
```

**Why weighted, not a raw sum:** these actions are not equivalent signals. A like costs a user a thumb-tap. A share costs them their own reputation with their own audience. Treating them as one unit lets high-volume, low-commitment engagement drown out the actions that actually indicate a post landed.

The weights follow an **effort-and-reach ladder**:

| Action | Weight | Reasoning |
|---|---|---|
| Like | 1 | Baseline. Lowest-friction action available. |
| Comment | 3 | Requires composing text; also feeds ranking algorithms on every platform. |
| Save | 4 | Private signal of durable value — the user intends to return to it. |
| Share | 5 | Highest weight: it costs social capital **and** it distributes the message to a new audience. For a communications team, a share is the closest proxy to the outcome they actually want. |

**Honest limitation:** these weights are a documented judgement call, not an empirically fitted model. Fitting them properly would need an outcome variable we don't have (reach lift per action type, or downstream follower conversion). The weights live in one constant in `server/src/analytics/engagement.ts` and are trivially adjustable — and the tests pin the arithmetic, not the weights, so changing them doesn't silently break anything.

> **Status:** implemented and tested in `server/src/analytics/engagement.ts` as described. The basis-mixing guard throws — see the tests.

### Denominator — per platform, because platforms differ

The brief is explicit that different platforms need different denominators. Ours:

| Platform / format | Denominator | Basis flag |
|---|---|---|
| YouTube | `views` | `VIEWS` |
| Instagram Reels / short video (when views present) | `views` | `VIEWS` |
| X (when public impressions present) | `views` | `VIEWS` |
| Everything else | `followerCount` | `FOLLOWERS` |

```
engagement_rate = interactions / denominator
```

**Why views-first:** followers are a *potential* audience; views are a *realised* one. Normalising by views measures "of the people who actually saw this, how many acted" — which is what format and timing analysis is genuinely asking. Follower-normalisation conflates a content-quality question with an audience-size question.

**The rule that keeps this honest:** every computed rate carries an `erBasis` flag of `VIEWS` or `FOLLOWERS`, and **the analytics layer refuses to aggregate or compare across mixed bases.** A view-normalised rate and a follower-normalised rate are different quantities with different magnitudes; averaging them together would produce a number that looks precise and means nothing. Where a comparison spans both, the UI splits it into two panels rather than silently blending them.

### Sample-size discipline

No confident claims from six data points. Enforced in code, not just in the UI:

| Context | Rule |
|---|---|
| Timing heatmap cell | `n < 3` → cell suppressed entirely. `3 ≤ n < 5` → rendered muted, flagged low-confidence |
| Format statistic | `n < 5` → shown as "insufficient data", excluded from recommendations |
| Any recommendation | must cite `n`; recommendations built on `n < 5` are dropped by the validator |

### Spread, not just averages

A format with one viral outlier and nine duds is not a good format. Every format statistic reports **mean, median, standard deviation, IQR and n**. Where `mean / median > 1.5`, the UI flags the distribution as **outlier-driven** and the recommendation layer is instructed to lead with the median.

---

## How the AI layer is kept from inventing numbers

This is the design decision the project is built around.

**The recommendation model never sees raw post data.** It receives *only* the pre-computed analytics JSON — format statistics, the heatmap, gap analysis, top/bottom posts, each with its `n` already attached. It has no raw engagement figures to misread and no corpus to average in its head. Structurally, it can misinterpret a verified number; it cannot invent an unverified one.

On top of that, three layers:

1. **Schema-constrained output.** Both LLM calls use Gemini's `responseSchema` structured output. Nothing is parsed out of free text — a model that cannot emit a field cannot smuggle an unverifiable claim into one.
2. **A deterministic validator (`server/src/ai/validate.ts`, no LLM involved).** It extracts every numeric literal and every `post_id` from the model's output and checks each one against the analytics JSON that was passed in — numbers must match a real value within a rounding tolerance, post IDs must exist in the database.
3. **Reject and retry.** A recommendation citing an unverifiable figure is rejected, and the call is retried once with the specific violation named. If it fails twice, that recommendation is **dropped, not shown**. Drop counts are logged so the failure rate is visible rather than invisible.

Every recommendation rendered in the UI is therefore traceable: click the evidence chip and it takes you to the posts and the computed figures behind it.

**Where the LLM is *not* used:** all analytics arithmetic, all aggregation, all sample-size gating, all validation. Those are deterministic, tested code. The LLM does two jobs only — **classifying content into themes** (a judgement task rules do badly) and **writing recommendations from verified numbers** (a language task). That's the whole surface.

### Content taxonomy

Fixed taxonomy rather than model-induced, for one reason: the principal and three competitors must be classified into the *same* categories or the gap analysis is meaningless. An induced taxonomy drifts between corpora.

```
POLICY_ANNOUNCEMENT · CONSTITUENCY_VISIT · PERSONAL_FAMILY · ATTACK_REBUTTAL
FESTIVAL_GREETING · ACHIEVEMENT_CLAIM · MEDIA_APPEARANCE · OTHER
```

Every classification stores a `themeConfidence`. Posts below the confidence threshold fall to `OTHER` rather than being forced into a category, and the theme analysis reports how much of the corpus is unclassified instead of hiding it.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite (SPA) | Fast dev loop, no framework to learn mid-sprint. Plain REST client. |
| Backend | Node.js + Express | Same language as the frontend — no context-switching under time pressure |
| Database | PostgreSQL (Supabase) | Real datastore with a considered schema; also what the team uses in production |
| ORM | Prisma 7 + `@prisma/adapter-pg` | Type-safe queries, readable schema file, migrations included |
| LLM | Gemini (`@google/genai`), `responseSchema` structured output | Structured output *is* the grounding mechanism |
| Charts | Recharts | |
| Tests | Vitest | Analytics math is tested; that's where correctness actually matters |

**Why not Next.js:** the team uses it in production, but a separate React SPA and Express API gives a cleaner, more visible boundary between ingestion, analysis and presentation — which is what's actually being graded — and avoids learning a framework during a four-day build. See `ARCHITECTURE.md`.

**Why Prisma over Drizzle:** faster to reason about under time pressure, and the schema file doubles as documentation. Drizzle is closer to the team's production stack; the tradeoff is noted in `DECISIONS.md`.

---

## Setup

### Prerequisites
- Node.js 20+
- A PostgreSQL database (Supabase free tier is fastest)
- A Google Gemini API key ([aistudio.google.com](https://aistudio.google.com/apikey))
- *(Optional, for live YouTube data)* a YouTube Data API v3 key

### 1. Clone and install

```bash
git clone <repo-url>
cd bellwether

cd server && npm install
cd ../client && npm install
```

### 2. Configure environment

```bash
cd server
cp .env.example .env
```

Fill in `server/.env`:

```env
DATABASE_URL="postgresql://user:pass@host:5432/postgres"
GEMINI_API_KEY="..."
YOUTUBE_API_KEY=""        # optional — omit to run fully on seeded data
PORT=4000
```

**No API keys are committed to this repository.** `.env` is in `.gitignore` from the first commit; `.env.example` documents the shape without the secrets.

### 3. Set up the database

```bash
cd server
npx prisma migrate deploy
npx prisma generate
```

### 4. Seed the demo dataset

```bash
npm run seed
```

This loads the principal and peer accounts and generates 90 days of synthetic posts for the platforms without live access. **The portal is fully demonstrable from this point with no API keys at all.**

### 5. (Optional) Pull live YouTube data

```bash
npm run ingest -- --platform=YOUTUBE
```

### 5b. (Optional) Classify content themes

Needs `GEMINI_API_KEY`. Incremental — only posts with no theme are sent, so re-running after an ingest costs a couple of calls rather than the whole corpus.

```bash
npm run classify              # everything unclassified
npm run classify -- --limit=50   # a cheap smoke test first
```

On the free tier the daily quota will not cover 940 posts in one pass. The run stops cleanly, reports how many posts it did not attempt, and continues from there next time.

### 6. Run

```bash
# terminal 1
cd server && npm run dev      # http://localhost:4000

# terminal 2
cd client && npm run dev      # http://localhost:5173
```

Open http://localhost:5173.

---

## Tests

```bash
cd server && npm test
```

Coverage is deliberately concentrated on the layers where a silent error corrupts every number downstream.

**Passing today — 175 tests across 11 files.**

Module A — ingestion:

- Normalisation: each adapter's `RawPost` → `Post` mapping, plus the rejection rules (bad dates, negative metrics, non-HTTP permalinks, missing `postId`)
- Idempotency: ingesting the same payload twice produces one row, not two
- Adapters: seed determinism, YouTube response mapping, CSV/JSON column inference
- Pipeline integration: run-log status transitions, partial-failure accounting, platform-mismatch guard

Module B — analytics:

- Engagement rate: weighting, both denominators, division-by-zero, absent-vs-zero handling
- Basis-mixing guard: aggregating `VIEWS`-based and `FOLLOWERS`-based rates together **throws**
- Statistics: mean/median/stdev/IQR against hand-computed fixtures, R type-7 quantiles pinned
- Format aggregation: the `n < 5` gate, median-based ranking, the outlier-driven headline
- Timing: UTC → account-local bucketing including a cross-midnight boundary and a **DST-observing zone**, plus the `n < 3` / `n < 5` suppression thresholds
- Top posts: ranking on rate rather than raw counts, with the trap asserted to be real
- Comparison: median-peer benchmarking, sample-size exclusion with reasons, and mixed provenance reported rather than averaged away

Module C — gap analysis:

- The finding that justifies the module: an account's own timing data **cannot reveal a slot it never posts in**, so a timing recommendation drawn only from the principal always says "carry on". Both halves are asserted on one corpus.
- Volume invariance: tripling one peer's output must not move the reported lift. Pooling would swing it 1.67× → 2.00×, which is the Day 2 habit-vs-quality bug in a different costume.
- Agreement is a gate, not a footnote — two peers must each clear the bar, because the median of two values interpolates and one enthusiastic peer was dragging a flat one over the line.

Module D — classification:

- Alignment, not position. `responseSchema` constrains shape but **not count or order**; a positional zip of results to posts would shift every label by one and write a whole batch of confidently wrong themes with no error. Out-of-order, skipped, duplicated, out-of-range and non-integer indices are all pinned.

Module D — the recommendation validator (`src/__tests__/validate.test.ts`):

- A fabricated number and a non-existent `post_id` are both rejected, as promised above.
- A number lifted from a post **caption** is rejected too. `collectEvidence` deliberately leaves captions unindexed, so a rationale quoting "₹5,000 crore" out of a post fails — that figure is a claim about the world this system has not verified and cannot check.
- The counterweight: a figure that appears **only inside the report's own pre-written prose** is accepted. Every number the model can see must be a number the validator accepts, or the only way to make the pipeline pass is to loosen the validator until it stops checking. Building this found a second live instance of that break — a gap's hour exists only in its `label` (`"20:00"`), which was unindexed, so the model would have been rejected for naming the very hour it was told about.
- Verified on the real 940-post corpus rather than only on fixtures: every numeric literal in the report's own prose validates, across three filters, zero failures.

**The round-trip tests are the ones worth reading.** Every multiplier the seed generator plants — format quality, the 7–9pm IST peak, the midweek lift, the theme ranking — is an exported constant, so the analytics tests run the real generator through the real pipeline and assert the engine **recovered a pattern that was deliberately put there**. That is a much stronger claim than "it computed a number without crashing."

One of them earned its keep: pooling format statistics across accounts turned out to conflate format quality with *posting habit* — the accounts that post reels also post in the evening peak on the themes that travel, inflating reel-over-link from the planted 3.45× to 6.46×. Format analysis is therefore computed per account, and the test that found it is kept as the explanation.

---

## Project status

<!-- UPDATE THIS TABLE AS YOU BUILD — it is the first thing a reviewer reads -->

**Day 3 of 4 complete.** Ingestion runs end to end — **940 posts** in Postgres across four platforms, **108 of them live** from the YouTube Data API. Every number the product shows is computed and tested, the REST API is up, all 940 posts are classified, the grounded recommendation layer is in, and the portal runs in a browser.

`cd server && npm test` → **293 passing**, `tsc --noEmit` clean.
`cd client && npm test` → **10 passing**, `npm run build` clean.

| Module | Status |
|---|---|
| A — Schema, migrations, adapter contract, seed adapter | ✅ Done |
| A — DB client (Prisma 7 + `adapter-pg`), verified against Supabase | ✅ Done |
| A — Seed generator carrying real signal (patterns to discover) | ✅ Done |
| A — Normalise + idempotent upsert + ingestion run log | ✅ Done |
| A — YouTube live adapter | ✅ Done — 108 real posts, 3 verified channels |
| A — CSV/JSON import adapter (`fileAdapter.ts`) | ✅ Done |
| B — Engagement rate + format analysis | ✅ Done |
| B — Timing heatmap | ✅ Done |
| B — Top/bottom performers | ✅ Done |
| C — Comparison | ✅ Done |
| B — Cadence analysis | ✅ Done |
| C — Gap analysis (formats · hours · days · themes) | ✅ Done |
| C — Comparison: cadence, format mix, best windows | ✅ Done |
| API — Express routes, accounts CRUD, shared filters | ✅ Done |
| D — Theme classification | ✅ Done — **940 of 940 classified** |
| D — Grounded recommendations + validator | ✅ Done — generator, pure validator, retry-then-drop, drop count reported |
| E — React portal — dashboard, filters, accounts CRUD | ✅ Done — recommendations panel at the top, SEEDED badges throughout |
| Docs — README / DECISIONS.md / sample report / video | 🔨 README + `DECISIONS.md` current; report and video pending |

**Corpus as ingested** (`npm run seed && npm run ingest -- --platform=YOUTUBE`):

| Platform | Posts | Provenance |
|---|---|---|
| X | 275 | seeded |
| Instagram | 263 | seeded |
| Facebook | 263 | seeded |
| YouTube | 108 live + 31 seeded | **mixed** — 3 of the 4 tracked people have a verified channel; the fourth is seeded and flagged |

48 `IngestionRun` rows record every fetch attempt behind those numbers.

---

## Known limitations

Stated plainly rather than buried.

- **Three of four platforms are synthetic.** Instagram, Facebook and X data is generated, not fetched. Every affected row is flagged `isSynthetic` and every affected UI number carries a SEEDED badge. Format and timing conclusions drawn from those platforms describe the seed generator's assumptions, not reality — they demonstrate that the pipeline works, not that the finding is true.
- **YouTube is mixed provenance.** Three of the four tracked people have a verified channel (108 live posts); the fourth is seeded (31 posts). So a YouTube-wide aggregate blends real behaviour with generated behaviour. The analytics layer therefore reports provenance per account rather than per platform, and any cross-account YouTube comparison states which side of it is seeded.
- **No metric history.** Post metrics are a single snapshot at ingestion time. Bellwether cannot distinguish a post that earned 10K likes in two hours from one that took three weeks. Follower counts are likewise a single scalar, so follower-growth trend is out of scope.
- **Theme classification is incomplete: 450 of 940 posts.** The Gemini free tier's daily quota ran out mid-run. Classification is incremental — it only considers posts with no theme — so re-running `npm run classify` after the quota resets continues where it stopped. Two consequences while it is partial: theme gaps are computed over the classified subset only, and because classification runs **newest-first**, that subset skews recent. `gaps.ts` says so in its `notes` rather than reporting the finding flat, and `buildReport.ts` states the classified fraction.
- **Engagement weights are a judgement call**, not empirically fitted. See the formula section.
- **Timezone is account-level, defaulting to `Asia/Kolkata`.** All four tracked accounts are India-based, so this is accurate here; a multi-region deployment would need per-account configuration honoured everywhere.
- **No comment-level analysis.** Sentiment and tone of comments — including code-mixed Hinglish/Manglish — was deliberately not attempted. It was a stretch item, and doing it badly across Indian languages would be worse than not doing it.
- **Classification is caption-only.** Themes are inferred from caption text and media type. No image, video-frame or audio understanding, so a post whose meaning lives entirely in its visual will often land in `OTHER`.
- **No multi-tenancy.** One principal and one peer set. The schema would extend to it cleanly; the UI assumes a single tenant.

---

## Ethics & scope

Bellwether is an analytics tool. It measures publicly visible engagement on public accounts belonging to public figures acting in a public capacity.

It is explicitly **not** built for, and does not support:

- voter profiling or micro-targeting of individuals
- building profiles of ordinary commenters or private citizens
- coordinated inauthentic behaviour
- generating content designed to deceive

Concretely, in the code: only public accounts and public content are ingested; nothing behind a login wall is touched; no platform authentication or rate limit is circumvented; and **no per-commenter data is stored** — the schema has no commenter table, by design. Where the roadmap contemplates comment analysis at all, it is aggregate-only.

If a source is closed, it is recorded as closed and left alone.

---

## Repository map

```
bellwether/
├── README.md            ← you are here
├── ARCHITECTURE.md      system design + build plan
├── DECISIONS.md         decisions made, alternatives rejected, why
├── client/              React + Vite SPA
└── server/              Express API, ingestion, analytics, AI layer
    ├── prisma/          schema + migrations
    └── src/
        ├── adapters/    one interface, many sources
        ├── ingestion/   normalise → upsert → log
        ├── analytics/   deterministic, tested math
        ├── ai/          classify · recommend · validate
        └── api/         REST routes
```
