# Day 3 — where things stand, and what to do next

Working notes. Delete before submission; `README.md`, `ARCHITECTURE.md` and
`DECISIONS.md` are the documents that ship.

---

## Done today (5 commits)

| Commit | What |
|---|---|
| `6347502` | `gaps.ts` + `corpus.ts` — Module C MUST |
| `fa3ef68` | `cadence.ts`, format mix, best windows — closes the rest of the Module C MUST |
| `da9ae06` | `buildReport.ts` — the analytics JSON the AI consumes, plus the evidence index |
| `7147b98` | Express API — routes, accounts CRUD, shared filters |
| `78d74da` | `classify.ts` — Gemini theme classification |

**265 tests passing, `tsc --noEmit` clean.**

---

## ⚠️ Do these two things first, next session

### 1. Finish classification — it is quota-blocked, not broken

```bash
cd server && npm run classify
```

**450 of 940 posts are classified.** The Gemini free tier's daily quota ran out
at batch 15 of 36. The run is incremental (only `theme = null` posts are sent),
so this command continues where it stopped. It will need to be run across more
than one day on the free tier, or the key needs a paid plan.

Check status without spending anything:

```bash
curl -s http://localhost:4000/api/ai/classify | python -m json.tool
```

**Why it matters:** theme gaps and theme × format are computed over the
classified subset only, and classification runs **newest-first**, so a partial
corpus skews recent. `gaps.ts` reports this in `notes` and `buildReport.ts`
reports the classified fraction — but the sample report and the video should not
be produced until this is complete, or the theme findings will be provisional.

### 2. Delete this file before submitting.

---

## What is left

### Task 6 — `recommend.ts` + `validate.ts` (Module D, ~20% of the grade)

**Build them in one sitting. The validator gets written WITH the generator,
never after.** `README.md` already promises this validator exists.

Everything it needs is built and tested:

- `buildReport(filter)` → `AnalyticsReport` — the only thing the model may see
- `collectEvidence(report)` → `{ numbers: Map<number, string[]>, postIds: Set<string> }`
- `ai/gemini.ts` → `structured()`, `RECOMMEND_MODEL`, `ThinkingLevel`, `QuotaExhaustedError`

**The invariant that must not break:** every number the model can SEE must be a
number the validator ACCEPTS. This was already broken once and fixed — the
report carried `principalVsPeers: 0.61` beside a sentence reading "1.63× behind",
the same fact rounded from opposite ends, and the prose was excluded from the
index. A model quoting 1.63 out of its own evidence would have been rejected as
a fabricator, and the only way to make that pass is to loosen the validator until
it stops checking. `buildReport.test.ts` pins this as a property; keep it.

Captions are deliberately **not** in the evidence index. A caption reading
"₹5,000 crore scheme" is a claim about the world this system has not verified.
**The recommendation prompt must say explicitly: cite computed figures only,
never numbers lifted from post text.**

Sketch:

```
recommend.ts
  buildReport(filter) → prompt (report JSON + the four questions)
  structured() with a strict schema: { recommendations: [{ action, rationale,
    evidence: { postIds[], figures[] }, confidence, priority }] }
  RECOMMEND_MODEL, ThinkingLevel.HIGH  ← quality matters, volume is tiny
  → validate() each one
  → on failure: retry ONCE naming the specific violation
  → on second failure: DROP it, and log the drop count so the failure rate is
    visible rather than invisible
```

```
validate.ts   ← pure code, no LLM anywhere near it
  extract every numeric literal from the recommendation's prose
  extract every post_id
  numbers must exist in evidence.numbers (they are pre-rounded, so this is
    near-exact — a tolerance loose enough to need fuzzy matching means the
    rounding contract has broken)
  post ids must exist in evidence.postIds
  a recommendation citing n < 5 is dropped (MIN_FORMAT_N / MIN_GAP_N)
```

**Tests that must exist** (README promises them): a fabricated number and a
non-existent `post_id` are both rejected.

**Timing recommendations must draw on `gaps.ts`, not on the principal's own
timing.** This is the Day 2 finding and the reason `gaps.ts` exists — see below.

### Task 7 — The React portal (Module E, ~25% of the grade)

`client/` is **still an empty directory**. `README.md` step 6 tells a reviewer to
`cd client && npm run dev`. Until this exists, a clean-clone test fails at
exactly the step the "we clone it and reach a working dashboard" criterion checks.

**Theme is decided: "Briefing Room".** Light-default, dark-mode toggle.

```
paper   #FAFAF9      ink     #1C1917      accent  #1E3A5F
serif display headings · tabular monospace numerals · dense but calm
```

Rationale: the brief's persona is a communications manager who should not need to
understand the analytics. A briefing document reads to her; a developer dashboard
does not. It also screenshots and prints cleanly for the sample report deliverable.

Layout, in order:

1. **Recommendations panel at the TOP**, not below the charts. The brief is
   explicit and bold about this. Question 4 is the product.
2. KPI row · format performance · timing heatmap · comparison · gaps
3. Accounts CRUD page (FR1 — the API is done and tested)
4. **SEEDED badge anywhere synthetic data contributes to a number.** Every
   endpoint already returns provenance per account; the UI must not drop it.

Stack per `README.md`: React + Vite + Recharts, plain REST client. Every endpoint
needed is live — see the route list in `ARCHITECTURE.md` §1.4.

### Day 4 (unchanged)

Filters (FR16 — API side done) · Markdown export (FR17) · theme × format (FR18) ·
trim `DECISIONS.md` to one page / 8–10 decisions **(the brief says one page and
it is currently much longer — this is a stated-requirement miss)** · sample
report · clean-clone test · 5–8 min video · confirm no keys in git history.

---

## Things worth knowing that are not obvious from the code

**The finding that justifies `gaps.ts` existing.** Tharoor's own best hours come
out at ~1.0× his median because he posts 08:00–16:00 and never in the evening.
An account's own timing data cannot reveal a slot it never posts in, so a
recommendation drawn only from his corpus will always say "carry on". The evening
peak is visible only in the peers' corpora. `gaps.ts` is therefore the **only**
legitimate source of a timing recommendation in this product. Both halves are
asserted in `gaps.test.ts`.

**Nothing is pooled across peers.** Each peer is measured against its own median.
Pooling conflates format quality with posting habit — the Day 2 test caught it
inflating reel-over-link from the planted 3.45× to 6.46×. `gaps.test.ts` pins a
volume-invariance property: tripling one peer's output must not move the reported
lift, where pooling would swing it 1.67× → 2.00×.

**A bigger report is a WEAKER validator.** Every number in `buildReport`'s output
is a number the validator will accept, because a figure in the evidence is by
definition citable. The list caps exist for that reason, not to save tokens. One
platform indexes ~64 numbers; the full corpus ~207. If that jumps into the
thousands, validation has quietly become a formality. `buildReport.test.ts`
asserts an upper bound.

**Two live-data findings worth leading with in the video.** These came off the
108 real YouTube posts — the only data nobody planted, which is the answer to
"what did it learn that you didn't tell it?":

- He posts **84% reels vs a 52% peer median**, and his reels **underperform**:
  1.04× his own baseline against 1.43× for peers. Over-invested in a format he
  is worse at.
- **69% weekly consistency against a 92% peer median**, longest silence 8 days.

**The X evening-window finding is correctly self-caveating.** X is fully seeded,
so `describeGap` appends "every peer behind this figure is seeded data — it
demonstrates the pipeline, not a real-world finding." Do not quote it as a real
finding in the video.

**Database state:** 16 accounts, 940 posts, 48 ingestion runs. Test accounts
created while exercising the API were deleted; the DB is as Day 2 left it.

**`npm run seed` prunes accounts not in `config/accounts.ts`.** Accounts added
through the UI do not survive it — use `npm run ingest` to refresh those. This is
documented in `seed.ts` but it will surprise someone demoing the accounts CRUD.

**Server:** `cd server && npm run dev` → http://localhost:4000. Kill a stuck one
with PowerShell, not bash job control — each Bash tool call is a fresh shell:

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Model note:** `gemini-2.5-flash` returns 404 "no longer available to new
users". `gemini-3.6-flash` is what both model constants point at, in
`ai/gemini.ts`.
