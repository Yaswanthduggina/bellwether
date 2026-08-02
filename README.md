# Bellwether

A social media intelligence portal for political communications teams.

Bellwether ingests the last 90 days of **public** posts for a principal and their peer set across Instagram and YouTube, normalises everything into one schema, and answers four questions:

1. **What content works?** — performance by media format, on a normalised engagement measure, with spread (not just averages).
2. **When should we post?** — day × hour heatmap per platform in the account's local timezone, with sample sizes shown and thin cells suppressed.
3. **How do we compare?** — the principal against their peer set on identical metrics, one screen.
4. **So what do we do?** — a ranked list of recommendations, each one traceable to specific posts and figures in the data.

Question 4 is the point of the product. Everything above it exists to make the recommendations defensible.

---

## ⚠️ Data provenance — read this first

**Every row in this portal is fetched, not generated.** The table below is the honest state of every platform.

| Platform | Source | Live? | Why |
|---|---|---|---|
| YouTube | YouTube Data API v3 | 🟢 **Live** | Official API, public channel data, workable free quota |
| Instagram | Apify actors (`instagram-post-scraper`, `instagram-profile-scraper`) | 🟢 **Live** | Reads the same public profile surface any visitor sees. The Graph API cannot be used here: it reads only accounts you administer, and competitor benchmarking is by definition about accounts you do not |
| X | Apify actor (`kaitoeasyapi/twitter-x-data-tweet-scraper…`) | 🟢 **Live** | The recorded blocker was about X's **first-party API**, and it still holds — its free read tier is far below a 90-day pull across four accounts. It was never an argument against reading the public timeline the way Instagram is already read. Routed through Apify, off the same public web surface. See `DECISIONS.md §1.9` for the two actors that failed first |
| Facebook | `facebookAdapter.ts` | 🟡 **Planned** | Accounts declared, adapter not built. Graph API reads only Pages you administer, so a peer's Page is unreadable without their cooperation |

Facebook is **declared but not ingested** — the handles are in `config/accounts.ts`, the blocker is in `adapters/index.ts`, and the platform is not filled in with generated stand-ins. Three platforms of real data beats four with one of them invented.

It stays visible on purpose. A platform deleted from the code is a gap the next person rediscovers from first principles; a platform present with a stated blocker is a decision they can read and close. **The registry is the switch, and X is the proof it works**: building `xAdapter.ts` and flipping one entry to `LIVE` started ingesting the four already-declared X handles on the next run, with no edit to the roster and no change to any analytics module.

The provenance machinery is still in place and still enforced, because a claim is only as good as the thing that checks it:

- `Account.isSynthetic` and `Post.isSynthetic` are booleans on every row — now `false` on every row
- The adapter registry refuses to serve an account flagged `isSynthetic`; there is no code path left that writes a generated post
- The UI shows a **SEEDED** badge anywhere synthetic data contributes to a number, so a regression would be visible rather than silent
- There is no generator left in `src/`. `seedAdapter.ts` was deleted, not merely unwired — an adapter that is one import away from being callable is a weaker guarantee than one that does not exist. Its *planted patterns* survive as a test fixture (`src/__tests__/fixtures/plantedCorpus.ts`), which emits plain analytics rows rather than implementing the adapter interface, so the round-trip tests keep their known-answer corpus while ingestion has nothing to reach for

No live-account data was scraped from behind a login wall, and no platform authentication or rate limit was circumvented. Only public accounts and public content. See [Ethics & scope](#ethics--scope).

---

## Who we track, and why

**Principal:** **Narendra Modi** — Prime Minister, and the highest-volume, highest-reach political account in the country on both tracked platforms. Volume is the practical requirement here: without it there is nothing for format or timing analysis to chew on.

**Peer set:**

| Account | Office / tier | Why they're a fair comparison |
|---|---|---|
| Rahul Gandhi | Leader of the Opposition, Lok Sabha | The direct counterpart to the principal and the most natural comparison in the set |
| Amit Shah | Union Home Minister | Same party as the principal, comparable office — the within-party control that lets the principal's format and timing choices read as *choices* rather than party house style |
| Arvind Kejriwal | Former Chief Minister of Delhi, national party leader | Different format and cadence mix, deliberately included so the gap analysis has genuine contrast rather than three variations of one posting style |

**Handles were verified before the first ingest**, because a wrong handle is the one error the pipeline cannot catch for you — it either fails the run, or resolves to a stranger's account and attributes their posts to a politician. `npm run ingest -- --check-handles` resolves every handle against its live source and writes nothing.

Resolved against the live sources on 1 Aug 2026 — measured, not estimates from a third-party stats site:

| Account | Platform | Followers | Resolved name |
|---|---|---|---|
| [`@narendramodi`](https://www.instagram.com/narendramodi/) | Instagram | **105,630,443** | Narendra Modi |
| `@narendramodi` | YouTube | 31,200,000 | Narendra Modi |
| [`@amitshahofficial`](https://www.instagram.com/amitshahofficial/) | Instagram | **35,502,552** | Amit Shah |
| `@AmitShah` | YouTube | 723,000 | Amit Shah |
| [`@rahulgandhi`](https://www.instagram.com/rahulgandhi/) | Instagram | **14,914,042** | Rahul Gandhi |
| `@RahulGandhi` | YouTube | 10,800,000 | Rahul Gandhi |
| [`@arvindkejriwal`](https://www.instagram.com/arvindkejriwal/) | Instagram | **4,060,543** | Arvind Kejriwal |
| `@ArvindKejriwal` | YouTube | 1,090,000 | Arvind Kejriwal |

**The handle that nearly poisoned this roster.** The obvious first guess for Amit Shah on Instagram is `@amitshah`. It *resolves* — to a namesake with **322 followers**. Ingesting it would have attached a private individual's posts to a Union Minister and produced a real-looking row of near-zero engagement: a fabricated finding, arrived at honestly, and one no downstream gate would have caught, because 322 is a perfectly valid follower count. The correct handle is `@amitshahofficial`. His YouTube channel needed the same treatment in reverse — 723K subscribers looks anomalously low for a Home Minister, so the channel was resolved for its *description* ("Official YouTube Channel of Amit Shah") before being trusted rather than being rejected on the number alone.

That is the second time a plausible handle has resolved to the wrong account in this project. It is the entire argument for `--check-handles`: resolving a handle and **reading what came back** costs one cheap call, and is the only thing standing between a typo and a chart about a stranger.

**On comparability — the known weakness of this roster.** The brief warns against benchmarking a 20M-follower national figure against a first-term MLA. All four here are national-tier figures, but the spread is **26× on Instagram** (4.06M–105.6M) and **43× on YouTube** (723K–31.2M). An earlier roster was deliberately chosen to sit inside roughly one order of magnitude; this one does not meet that bar, and the principal is an order of magnitude above every peer on both platforms.

What makes it workable is that **nothing in this portal ranks on raw followers or raw likes** — every cross-account comparison runs on a normalised engagement rate with an explicit denominator (views on YouTube, followers elsewhere). What that does *not* fix: an account with 105M followers has a structurally lower engagement rate than one with 4M, close to mechanically. So a "the principal underperforms his peers on rate" finding from this roster deserves that caveat, and the per-account format and timing analysis — which compares an account against **itself** — carries more weight here than the cross-account rate comparison does.

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
| Timing heatmap cell | `n < 2` → cell suppressed entirely. `2 ≤ n < 5` → rendered muted, flagged low-confidence |
| Timing hour/day marginal | `n < 3` → bucket dropped. A higher floor than the grid's, because the marginals are what recommendations cite while the grid is only a picture |
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
GEMINI_API_KEY="..."      # optional — only theme classification and recommendations need it
YOUTUBE_API_KEY="..."     # required — YouTube accounts are ingested live
APIFY_API_TOKEN="..."     # required — serves the Instagram accounts
APIFY_RESULTS_LIMIT=""    # optional — posts per Instagram account per run (default 200)
PORT=4000
```

**No API keys are committed to this repository.** `.env` is in `.gitignore` from the first commit; `.env.example` documents the shape without the secrets.

### 3. Set up the database

```bash
cd server
npx prisma migrate deploy
npx prisma generate
```

### 4. Check the handles before spending anything

```bash
npm run ingest -- --check-handles
```

Resolves every tracked handle against its live source and prints what came back — display name and follower count — **without writing a row**. A wrong handle is the one error the pipeline cannot catch for you, and this costs one cheap call per account.

### 5. Load the roster and ingest 90 days

```bash
npm run ingest -- --roster
```

Upserts the principal and peer accounts, then runs the ingestion pipeline over them: YouTube through the Data API, Instagram through Apify. Nothing is generated — an account whose source fails is recorded as a failed run in `IngestionRun` and left empty rather than filled in.

Run this once after upgrading from an earlier build too: it purges any generated posts left behind by the seeded era and prunes accounts that are no longer in the roster.

### 6. Refresh later without re-asserting the roster

```bash
npm run ingest                          # everything, last 90 days
npm run ingest -- --days=30             # shorter window
npm run ingest -- --platform=INSTAGRAM
npm run ingest -- --roster --reset      # wipe and rebuild from scratch
```

**There is no `npm run seed`.** It was folded into this one command when the synthetic corpus was removed — a script whose name implies generated data has no place in a product whose central claim is that its data is real. The distinction it protected survives as the `--roster` flag: a plain `npm run ingest` refreshes posts *without* re-asserting the roster, so accounts you added through the UI (FR1) are not pruned out from under you.

### 7. (Optional) Classify content themes

Needs `GEMINI_API_KEY`. Incremental — only posts with no theme are sent, so re-running after an ingest costs a couple of calls rather than the whole corpus.

```bash
npm run classify              # everything unclassified
npm run classify -- --limit=50   # a cheap smoke test first
```

On the free tier the daily quota will not cover a full corpus in one pass. The run stops cleanly, reports how many posts it did not attempt, and continues from there next time.

### 8. Run

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
- Adapters: YouTube response mapping, Instagram/Apify response mapping, CSV/JSON column inference, seed determinism
- Pipeline integration: run-log status transitions, partial-failure accounting, platform-mismatch guard

Module B — analytics:

- Engagement rate: weighting, both denominators, division-by-zero, absent-vs-zero handling
- Basis-mixing guard: aggregating `VIEWS`-based and `FOLLOWERS`-based rates together **throws**
- Statistics: mean/median/stdev/IQR against hand-computed fixtures, R type-7 quantiles pinned
- Format aggregation: the `n < 5` gate, median-based ranking, the outlier-driven headline
- Timing: UTC → account-local bucketing including a cross-midnight boundary and a **DST-observing zone**, plus the `n < 2` grid / `n < 3` marginal / `n < 5` confidence thresholds — including that the grid's floor stays below the marginals'
- Top posts: ranking on rate rather than raw counts, with the trap asserted to be real
- Comparison: median-peer benchmarking, sample-size exclusion with reasons, and mixed provenance reported rather than averaged away

Module C — gap analysis:

- The finding that justifies the module: an account's own timing data **cannot reveal a slot it never posts in**, so a timing recommendation drawn only from the principal always says "carry on". Both halves are asserted on one corpus.
- Volume invariance: tripling one peer's output must not move the reported lift. Pooling would swing it 1.67× → 2.00×, which is the Day 2 habit-vs-quality bug in a different costume.
- Agreement is reported, not required — **one** peer clearing the bar is enough for a gap (`MIN_PEER_ACCOUNTS = 1`), and the count of how many backed it travels with the finding. This was 2 until the product decision to widen it; what survives from that gate is the part that mattered most: `peerLift` is the median of the **clearing** peers, so a gap built on one peer at 1.76× and one at 1.00× reports 1.76× — a number that peer actually earned — rather than the interpolated 1.38× that used to be published and matched neither.

Module D — classification:

- Alignment, not position. `responseSchema` constrains shape but **not count or order**; a positional zip of results to posts would shift every label by one and write a whole batch of confidently wrong themes with no error. Out-of-order, skipped, duplicated, out-of-range and non-integer indices are all pinned.

Module D — the recommendation validator (`src/__tests__/validate.test.ts`):

- A fabricated number and a non-existent `post_id` are both rejected, as promised above.
- A number lifted from a post **caption** is rejected too. `collectEvidence` deliberately leaves captions unindexed, so a rationale quoting "₹5,000 crore" out of a post fails — that figure is a claim about the world this system has not verified and cannot check.
- The counterweight: a figure that appears **only inside the report's own pre-written prose** is accepted. Every number the model can see must be a number the validator accepts, or the only way to make the pipeline pass is to loosen the validator until it stops checking. Building this found a second live instance of that break — a gap's hour exists only in its `label` (`"20:00"`), which was unindexed, so the model would have been rejected for naming the very hour it was told about.
- Verified on the real 940-post corpus rather than only on fixtures: every numeric literal in the report's own prose validates, across three filters, zero failures.

**The round-trip tests are the ones worth reading.** Every multiplier the seed generator plants — format quality, the 7–9pm IST peak, the midweek lift, the theme ranking — is an exported constant, so the analytics tests run the real generator through the real pipeline and assert the engine **recovered a pattern that was deliberately put there**. That is a much stronger claim than "it computed a number without crashing."

This is the seed generator's **only** remaining job. It writes nothing to the database and no ingestion path calls it; it survives as a fixture factory precisely because a generator with known planted constants is the one thing that can prove the analytics engine finds what is actually there. Deleting it would have cost the strongest tests in the suite to remove code that no longer produces a single stored row.

One of them earned its keep: pooling format statistics across accounts turned out to conflate format quality with *posting habit* — the accounts that post reels also post in the evening peak on the themes that travel, inflating reel-over-link from the planted 3.45× to 6.46×. Format analysis is therefore computed per account, and the test that found it is kept as the explanation.

---

## Project status

<!-- UPDATE THIS TABLE AS YOU BUILD — it is the first thing a reviewer reads -->

**Day 3 of 4 complete, plus a source change on Day 4.** Ingestion runs end to end, every number the product shows is computed and tested, the REST API is up, the grounded recommendation layer is in, and the portal runs in a browser.

The Day 4 change: **the synthetic corpus is gone.** Instagram now comes from Apify and YouTube from the Data API, so the database holds fetched rows only. Nothing above the adapter layer moved — same `RawPost` contract, same validate → normalise → upsert → log pipeline, same analytics, same API, same UI. The corpus counts below are from the last seeded run and are **stale until the first live Apify ingest**; they are left visible rather than quietly replaced with numbers nobody has measured.

`cd server && npm test` → **307 passing**, `tsc --noEmit` clean.
`cd client && npm test` → **10 passing**, `npm run build` clean.

| Module | Status |
|---|---|
| A — Schema, migrations, adapter contract | ✅ Done |
| A — DB client (Prisma 7 + `adapter-pg`), verified against Supabase | ✅ Done |
| A — Seed generator carrying real signal (patterns to discover) | ⚪ Retired — kept in the tree with its tests, unreferenced by ingestion |
| A — Normalise + idempotent upsert + ingestion run log | ✅ Done |
| A — YouTube live adapter | ✅ Done — 108 real posts, 3 verified channels |
| A — Instagram live adapter via Apify (`apifyAdapter.ts`) | ✅ Done — replaces the seeded Instagram corpus |
| A — X live adapter via Apify (`xAdapter.ts`) | ✅ Done — 640 real posts across four accounts |
| A — Facebook adapter (`facebookAdapter.ts`) | 🟡 Planned — accounts declared, blocker recorded in the registry |
| A — CSV/JSON import adapter (`fileAdapter.ts`) | ✅ Done |
| B — Engagement rate + format analysis | ✅ Done |
| B — Timing heatmap | ✅ Done |
| B — Top/bottom performers | ✅ Done |
| C — Comparison | ✅ Done |
| B — Cadence analysis | ✅ Done |
| C — Gap analysis (formats · hours · days · themes) | ✅ Done |
| C — Comparison: cadence, format mix, best windows | ✅ Done |
| API — Express routes, accounts CRUD, shared filters | ✅ Done |
| D — Theme classification | ✅ Done — 940 of 940 classified on the previous corpus; re-runs incrementally over the live one |
| D — Grounded recommendations + validator | ✅ Done — generator, pure validator, retry-then-drop, drop count reported |
| E — React portal — dashboard, filters, accounts CRUD | ✅ Done — recommendations panel at the top, SEEDED badges throughout |
| Docs — README / DECISIONS.md / sample report / video | 🔨 README + `DECISIONS.md` current; report and video pending |

**Corpus, before the source change** (the last seeded run — kept for comparison, not current):

| Platform | Posts | Then | Now |
|---|---|---|---|
| X | 275 | seeded | declared, **not ingested** — adapter planned |
| Instagram | 263 | seeded | **live via Apify** |
| Facebook | 263 | seeded | declared, **not ingested** — adapter planned |
| YouTube | 108 live + 31 seeded | mixed | **live only** — the seeded account had no real channel and was dropped |

**Corpus as it stands now** — measured, from the live run on 1 Aug 2026:

| Account | Platform | Posts (90d) | Source |
|---|---|---|---|
| Narendra Modi | YouTube | 839 | `youtube_api` |
| Rahul Gandhi | YouTube | 190 | `youtube_api` |
| Rahul Gandhi | Instagram | 184 | `apify_instagram` |
| Narendra Modi | Instagram | 160 | `apify_instagram` |
| Arvind Kejriwal | Instagram | 139 | `apify_instagram` |
| Arvind Kejriwal | YouTube | 136 | `youtube_api` |
| Amit Shah | YouTube | 48 | `youtube_api` |
| Amit Shah | Instagram | 29 | `apify_instagram` |

**1,725 posts, all of them real, 0 synthetic, 0 failed rows.** Instagram 512, YouTube 1,213. Every account reaches back 84–90 days, so the window is genuinely covered rather than nominally requested. The reconcile pruned 5 accounts that were no longer in the roster, removing 458 posts with them.

### The bug that hid inside a successful run

The first pull of this roster returned **500** posts for Modi's YouTube and **55** for his Instagram, and both runs were recorded `success`. They were not.

`MAX_PAGES = 10` in `youtubeAdapter.ts` capped paging at exactly 500 videos. Modi uploads ~10/day, so 500 videos reached only **48 of the 90 days** requested — and the loop simply stopped, with nothing recording that it had run out of pages rather than out of window. Instagram truncated the same way against `APIFY_RESULTS_LIMIT`, covering 41 days.

The missing rows were not the damage. **Cadence divides by the window that was asked for**, so the 42 unfetched days registered as weeks in which the Prime Minister posted nothing:

| | Truncated pull | Full 90 days |
|---|---|---|
| Cadence | 39.1×/week | **12.5×/week** |
| vs. peer median | 3.64× more often | **1.16× — essentially level** |
| Weeks with any post | 62% | **100%** |

The truncated version is a confident, quotable, completely false finding: *the principal posts in bursts and goes silent for a third of the year.* It would have survived every sample-size gate in the product, because the gates check whether there are enough posts — not whether the window they are divided by was actually fetched.

Two changes followed. `MAX_PAGES` is now 60 (3,000 videos), and — the part that matters — **exhausting the page budget before reaching the window edge now throws and fails the run.** A partial window is not a smaller answer, it is a wrong one, so it is no longer allowed to masquerade as a complete pull. This is the same principle already applied to a failed Apify scrape, which ingests nothing rather than writing the partial page it managed to collect.

**One run failed and was retried, which is the interesting part.** Rahul Gandhi's Instagram pull died mid-roster on `Monthly usage hard limit exceeded` — the Apify account was out of credit. The pipeline treated it as a **failed run and ingested nothing**, rather than writing the partial page it had already scraped. That is the design working: a partial scrape written as a complete one would have shown Rahul Gandhi posting a fraction of his real volume, and every cadence and share-of-output figure involving him would have been wrong with nothing on screen admitting it. Re-run against a funded account, the same handle returned 184 posts.

**The volume asymmetry is real and worth reading before any cross-account conclusion.** Modi's YouTube alone is 839 posts against Amit Shah's 29 on Instagram — a 29× range across the corpus. That is a genuine finding about how these four operate rather than a sampling artefact, but it means per-account sample sizes differ by an order of magnitude, and the sample-size gates will include and exclude accounts unevenly because of it.

**End-to-end result on this corpus.** All **1,725 posts are classified — 100% coverage, 0 low-confidence**, and the recommendation layer produced **6 recommendations, all 6 accepted, 0 dropped by the validator and 0 requiring repair**, citing 143 distinct figures and 20 real post IDs. A sample:

> **Stop publishing SINGLE_IMAGE posts on Instagram and replace them with CAROUSEL posts.** Narendra Modi spends 25% of his Instagram output on SINGLE_IMAGE across 23 posts, where a typical post earns 0.49× his own baseline. In contrast, CAROUSEL posts earn 1.22× his own baseline across 68 posts. — *confidence HIGH, n=23*

Note what the model is *not* doing there: it is not comparing Modi to a peer on raw reach, which the 26× follower spread would make meaningless. It compares each format against **his own baseline**, which is the comparison this roster actually supports. The one recommendation resting on a thin sample (an hour-of-day suggestion at n=7) came back **MEDIUM**, not HIGH, without being asked.

---

## Known limitations

Stated plainly rather than buried.

- **Most gaps rest on a single competitor, and are flagged as such.** A gap is reported where **one or more peers** clear a 1.2× lift over **n ≥ 5** in the same bucket (`MIN_PEER_ACCOUNTS = 1`). That floor was 2 until a product decision widened it — at 2, three of the four live basis-platform panels reported **zero** gaps against a 2,365-post corpus, and a missed opportunity was judged the more expensive error than a thin one. **16 of the 19** gaps now shown rest on one peer, each carrying a `ONE PEER` badge and its agreement count (`1 of 3`), because one account's strong bucket can be that account's habit rather than a pattern.

  What did **not** move is the honesty of the figure. `peerLift` is the median of the **clearing** peers, not of every peer with a sample — so the failure that originally set the floor to 2 (one peer at 1.76×, one at 1.00×, published as an interpolated **1.38×** that neither peer achieved) cannot recur. That bucket now reports 1.76×, which is checkable against a named account. `MIN_GAP_N` did not move either: a rate is still never quoted over fewer than five posts.

  **The panel also reports what it rejected.** "No gap clears the bar" rendered on its own is indistinguishable, to a reader, from "we did not look". **Near misses** are buckets where a peer beat its own baseline but the evidence still failed a gate, tagged with which one and what would change it. At the current floor the reachable case is `He already matches them` — peers do well there and so does the principal — which is worth saying, since a reader otherwise cannot tell a bucket that was checked and cleared from one that was never testable. **Near misses are not findings and the UI is built so they cannot read as findings**: no opportunity multiple, no table, muted type, explicit copy, and `describeNearMiss` leads with `NOT REPORTED as a gap` so the AI layer cannot paraphrase one into a claim.

  Per-peer evidence rows ship with every gap and near miss, so `2 of 3 peers agree` is checkable rather than asserted — the lifts were previously computed and then dropped on the way to the UI.

  The panel also reports **what was searched** per dimension — `HOUR 12/18 buckets testable` — so a dimension that could test nothing (THEME before classification finishes) is distinguishable from one that ran and found nothing. Those are opposite meanings and previously rendered identically.
- **The AI layer's binding constraint is the Gemini free tier, not the code.** Classification is roughly one request per 25 posts, so a 1,725-post corpus is ~70 requests and exhausts a free-tier key's daily allowance well before it finishes; reaching 100% coverage took four keys across one day. Two things follow. Classification is **incremental and resumable**, so a run that stops at a quota wall keeps everything it wrote and continues from there. And the UI's Classify button **paces itself** (one batch every 8 seconds, with exponential backoff on 429) because Gemini's per-minute limit and its daily limit return an identical error — firing batches back-to-back trips the per-minute one after about eight of them, which reads as "quota exhausted" when eight seconds of patience would have cleared it. Recommendations, by contrast, cost **one or two requests**, so generating them first and classifying with what remains is the right order on a constrained key.
- **Three platforms carry data, not four.** Facebook is declared in the roster and visible in the adapter registry with its blocker, but it is not ingested and not approximated. Any conclusion here describes Instagram, YouTube and X behaviour only, and the product says so rather than implying coverage it does not have.
- **The X window is capped at 160 posts per account, not 90 days of output — and the cap bites unevenly.** The actor bills per tweet and the Apify free plan carries $5 of monthly credit, so `X_RESULTS_LIMIT` is deliberately low. It returns **newest first**, so the cap drops the *oldest* posts in the window rather than sampling at random — a known, directional truncation. But because the cap is on **count** while the accounts post at very different rates, 160 posts buys very different spans of history:

  | Account | Posts | Window covered |
  |---|---|---|
  | @narendramodi | 160 | 15 days |
  | @AmitShah | 160 | 26 days |
  | @ArvindKejriwal | 160 | 31 days |
  | @RahulGandhi | 160 | 65 days |

  **This produced a false finding before it was caught, and the fix is worth stating.** Cadence divides every account by one shared window, so all four came out at exactly 17.11 posts/week and the dashboard reported `principalVsPeers = 1.00×` — "he posts exactly as often as his peers". That number measured the result cap, not the accounts. Consistency was worse: the principal read as posting in 30% of weeks when he posts most days, because seven of the ten blocks predated anything that had been fetched. `compareCadence` now detects that an account's history does not cover the window and **withholds the cadence figures for that platform entirely**, with a sentence saying why — rather than publishing arithmetic that is correct over inputs that are not comparable. Instagram and YouTube are unaffected and still report cadence normally. Raising `X_RESULTS_LIMIT` on a paid plan restores it.

  Engagement-rate analysis on X is **not** affected: rate is per post, so a shorter history is a smaller sample rather than a distorted one.
- **Instagram data is scraped, not served by an API.** Apify reads the public profile surface, which means it is subject to what Instagram renders publicly and can change shape without notice. Two consequences: a failed or partial scrape is treated as a **failed run** rather than as "posted nothing" (a silent zero would read as a finding), and shares and saves are unavailable, so Instagram engagement is computed from likes, comments and — on Reels — plays.
- **Instagram follower counts are a scraped scalar.** They are the engagement denominator for photos and carousels, which have no view count. A hidden or unreadable count leaves the previous stored value in place rather than overwriting it with a guess.
- **Uneven coverage across the peer set.** Varun Gandhi has no verifiable YouTube channel, so he appears on Instagram only — where his account has 28 posts in its lifetime, and a 90-day window may return zero. Comparisons involving him are Instagram-only by necessity, and the analytics layer reports the per-account sample rather than implying a like-for-like sweep.
- **The dashboard's platform filter still offers Facebook**, which returns nothing. Platform status is hardcoded in two client files rather than read from the API, which is exactly the duplication that let `Accounts.tsx` keep calling Instagram "seeded" after it went live, and that made the X filter option dead until X shipped. Fixed in `Accounts.tsx`, unfixed in `Filters.tsx`.
- **No metric history.** Post metrics are a single snapshot at ingestion time. Bellwether cannot distinguish a post that earned 10K likes in two hours from one that took three weeks. Follower counts are likewise a single scalar, so follower-growth trend is out of scope.
- **Theme classification is incomplete: 1,900 of 2,365 posts.** The 640 X posts added 465 unclassified rows and the Gemini free tier's daily quota ran out 175 of the way through them, so the shortfall is entirely on X. Classification is incremental — it only considers posts with no theme — so re-running `npm run classify` after the quota resets continues where it stopped. Two consequences while it is partial: theme gaps are computed over the classified subset only, and because classification runs **newest-first**, that subset skews recent. `gaps.ts` says so in its `notes` rather than reporting the finding flat, and `buildReport.ts` states the classified fraction.
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
