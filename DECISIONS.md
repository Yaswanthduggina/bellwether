# Decisions

Every non-obvious choice in Bellwether, the alternatives that were rejected, and why. Written as the decisions were made, not reconstructed afterwards.

The format is deliberate: **what was chosen · what was rejected · what it costs**. A decision without a stated cost is a decision that wasn't really made.

---

## 1 — Data & provenance

### 1.1 Seed the platforms we cannot legitimately reach, and say so loudly

> **⚠️ Superseded on Day 4 by §1.6.** Kept as written, because §1.6 only makes sense
> against the reasoning it replaced. The diagnosis below is still correct; the
> conclusion is no longer available.

**Chosen:** live YouTube via the Data API v3; Instagram, Facebook and X seeded and flagged at row level.

**Rejected:** scraping Instagram or Facebook behind a login wall; using an unofficial X client; quietly presenting seeded numbers as real.

**Why:** the Instagram/Facebook Graph API requires a Business or Professional account *you control* plus app review. We control none of these four politicians' accounts, and no amount of engineering makes that legitimate. Scraping was rejected on ethics grounds, not difficulty grounds — see the README's Ethics section.

**Cost, stated plainly:** three quarters of the corpus is generated. Any format or timing conclusion drawn from Instagram, Facebook or X describes the seed generator's assumptions, not Indian political social media. The pipeline is what's being demonstrated there, not the finding. This is why `isSynthetic` is a column on both `Account` and `Post` rather than a footnote — the flag travels with the data into every aggregate, and the UI cannot accidentally lose it.

### 1.2 X: assessed, then rejected rather than half-wired

> **Superseded on Day 5 by §1.9.** X is live. The assessment below is still correct
> about X's **first-party API**, which is what it actually assessed — and that is the
> point of keeping it. Filed under "X", it read for four days as a verdict on the
> platform rather than on one route to it, and it was only re-read while adding a
> platform. A blocker is only as narrow as the thing it names.
>
> (Partly superseded on Day 4 first: the fallback changed from *seeded* to
> *declared and empty*.)

**Chosen:** X is seeded.

**Rejected:** wiring the X API free tier for a partial pull.

**Why:** the free tier's read caps are far below what a 90-day history across four accounts needs. The options were a real adapter returning a truncated, unrepresentative sample, or a seeded one that is honestly labelled. A truncated real sample is the worse outcome: it *looks* live, so nobody discounts it, and the sampling bias is invisible. The build plan's own cut list anticipated this — *"the second live platform (seed X, say so plainly)"*.

**Cost:** only one of four platforms carries live data.

### 1.3 Real and synthetic data share one schema

**Chosen:** one `Post` table, an `isSynthetic` boolean, no separate tables or separate code paths.

**Rejected:** a parallel `SyntheticPost` table; a `--demo` mode that swaps the data layer.

**Why:** analytics, the AI layer and the UI should never branch on provenance — they read a flag. A separate table would have meant every query written twice, and the second copy drifting.

**Cost:** nothing prevents a careless aggregate from blending real and synthetic rows. The guard is convention plus tests, not the type system. Which is exactly how §1.4 became a problem worth writing down.

### 1.4 YouTube is mixed provenance, and provenance is therefore per-account

> **Resolved on Day 4, not reversed.** YouTube is now uniformly live — the account
> without a real channel was dropped rather than seeded. Per-account provenance
> reporting stays, because the reasoning holds for any future mixed source (a CSV
> import sits beside API data today) and because removing a guard that currently
> has nothing to catch is how it fails to catch the next thing.

**Chosen:** provenance is reported per **account**, never rolled up per platform.

**Rejected:** a platform-level `isLive` flag.

**Why:** three of the four tracked people have a verified YouTube channel; the fourth does not. So YouTube holds 108 live posts *and* 31 seeded ones. A platform-level rollup would report YouTube as "live" while a quarter of its rows are generated — the single most misleading thing this portal could do, given that honest provenance is its central claim.

**Cost:** every comparison touching YouTube has to state which side of it is seeded, which is more UI work than a single badge. `compare.ts` and `gaps.ts` are where this would go wrong quietly, so it is called out in `ARCHITECTURE.md` §3.5 as well.

### 1.5 The seed generator models reach first

> **Still true, but its output no longer reaches the database.** As of Day 4 the
> generator is a test-fixture factory only — see §1.7.

**Chosen:** `reach = followers × reachFactor(format)`, then `interactions = reach × BASE_ER × format × hour × day × theme × noise`.

**Rejected:** the obvious `likes = randomInt(500, 15000)`, and the tempting `views = likes × k`.

**Why:** the first version did draw likes at random, and the Day 0 audit caught what that costs — format analysis correctly found nothing, and the heatmap rendered as a single vertical stripe. The subtler trap is the second one: engagement *rate* is interactions ÷ reach, so deriving reach **from** interactions cancels the planted signal straight back out to noise, however structured the raw counts look.

**Why it matters beyond the demo:** every multiplier is an exported constant, so the Module B tests assert that the engine **recovered a pattern deliberately put there** — a far stronger claim than "it computed a number without crashing."

**Cost:** the synthetic data is *tidier* than reality. Real engagement has autocorrelation, news shocks and follower drift that this model has none of. An analyst who mistook the seeded findings for facts about Indian politics would be badly wrong, which is why they are labelled everywhere they surface.

### 1.6 Day 4 — every row is fetched, or there is no row

**Chosen:** remove synthetic data from the product entirely. Instagram moves to Apify actors over the public profile surface; YouTube stays on the Data API; X and Facebook are declared with no data behind them.

**Rejected:** keeping the labelled seed corpus (§1.1); a `--demo` flag that seeds on request; generating "illustrative" rows for the platforms with no adapter.

**Why:** the requirement came from outside the build — the seeded corpus was rejected outright. But the change is defensible on its own terms, and §1.1 already contained the argument against itself: *every* place a seeded number surfaces has to carry a label, and the guarantee is only as strong as the least careful reader. A demo flag is the same bet with an extra step, because the flag's state is invisible in a screenshot.

The Graph API was never the alternative for Instagram. It reads accounts you administer; competitor benchmarking is by definition about accounts you do not. Apify reads the same public profile a visitor sees, which is the category this product already limits itself to.

**Cost, stated plainly:**

- **Two platforms lost.** X and Facebook contribute nothing until their adapters exist. The product covers less than it did.
- **The corpus is smaller and less even.** Varun Gandhi has 28 Instagram posts in the account's lifetime, so a 90-day window may return zero for him. Sample-size gates exclude him with a reason rather than reporting from two posts.
- **A per-result bill.** Apify charges per scraped item, so a full refresh has a real cost and `APIFY_RESULTS_LIMIT` is a cost knob, not a tuning knob.
- **A scraped source is less stable than an API.** Instagram can change its public surface without notice. The mitigation is that a failed or partial scrape is treated as a **failed run**, never as "posted nothing" — a silent zero would read as a finding.
- **The strongest analytics tests would have died with it** — which is why the *planted patterns* survive as §1.7, though the adapter does not.

### 1.7 The seed adapter is deleted; its planted patterns survive as a test fixture

**Chosen:** `seedAdapter.ts` and `seedAdapter.test.ts` are gone. The planted multipliers, the per-account profiles and the reach-first generative model moved to `src/__tests__/fixtures/plantedCorpus.ts`, which emits plain analytics rows — no `SocialAdapter` implementation, no `RawPost`, no export from `src/adapters`, and nothing the production build compiles.

**Rejected:** keeping the adapter in the tree but unreferenced; deleting the planted patterns outright along with it.

**Why:** two things were tangled together and only one was worth keeping. The valuable half is the *corpus with known answers* — the round-trip tests plant known constants and assert the engine recovers them, which is the best evidence in the repo that the analytics engine finds what is actually there rather than merely returning a number. The dangerous half was the *adapter shape*: anything implementing `SocialAdapter` can be pointed at the ingestion pipeline, and one `isSynthetic` flag set by hand would put generated rows back into a corpus the UI presents as real. Separating them keeps the evidence and removes the hazard.

Keeping it "inert but present" was the previous position, and it was the weaker one: an unreferenced adapter is one import away from being referenced, and it left a reader who greps for "seed" needing to be told the generator was inert. A fixture under `__tests__` needs no such disclaimer — its location is the disclaimer.

**Cost:** the fixture duplicates the platform/format matrix that the real adapters also encode, so a new media type has to be added in two places. Accepted: the alternative couples test fixtures to production adapter code, which is how a fixture change quietly becomes a product change. The captions were dropped rather than moved — no test read them, and invented political prose is exactly the artefact that should not survive in a repo whose rule is that displayed data is real.

### 1.8 X and Facebook stay visible as `PLANNED`, not deleted

**Chosen:** the registry records a status per platform — `LIVE` with a factory, or `PLANNED` with a stated blocker and the filename the adapter will have. The roster declares all four platforms' handles; `TRACKED_ACCOUNTS` is derived by filtering on `hasLiveAdapter`.

**Rejected:** deleting the unreadable platforms from the code; keeping their accounts in the database with no source (they would fail every run and pollute the audit trail).

**Why:** a platform deleted from the code is a gap the next person rediscovers from first principles, including the two days of API-terms reading that produced the blocker. A platform present with its blocker written down is a decision that can be read, argued with, and closed. Deriving the tracked set from the registry rather than restating it means building `xAdapter.ts` and flipping one entry starts ingesting the already-declared accounts — the roster is not touched, so it cannot fall out of step.

**Cost:** platform status is now duplicated in the client, and duplicated state drifts — `Accounts.tsx` held a hardcoded `LIVE_PLATFORMS = {YOUTUBE}` that was silently wrong the moment Instagram went live, offering a "seeded" warning for a platform that had just become real. It is corrected and commented, but the honest fix is for the UI to read status from the API (every account response already carries `liveAdapterAvailable`), and that is not done. `Filters.tsx` still lists X and Facebook as filter options that return nothing.

> **Partly closed on Day 5 by §1.9.** X is live. Facebook is not, and the reasoning
> below still governs it.

**A second cost, worth naming separately:** the account-creation gate had to change meaning. It used to make the caller acknowledge that a new account on an adapterless platform would be *seeded*; it now makes them acknowledge it will be *empty*, and such accounts are created with `isSynthetic: false`. Writing `true` there would have been worse than cosmetic — the registry refuses flagged accounts, so those accounts would have been permanently skipped by the very adapter they were waiting for.

### 1.9 X goes live through Apify — the blocker was about the wrong API

**Chosen:** read X's public timeline through an Apify actor, exactly as Instagram is read. X flips from `PLANNED` to `LIVE` in the registry; the four already-declared handles start ingesting on the next run with no edit to `config/accounts.ts` and no change to any analytics module.

**Rejected:** X's first-party API (the original blocker, and still correct — its free read tier is far below a 90-day pull across four accounts, and a truncated first-party sample would look authoritative while hiding its own bias); continuing to ship X as `PLANNED`; seeding it.

**Why:** the blocker recorded on Day 1 was assessed against X's own API and then filed under "X". Re-reading it while adding a platform showed it had never been an argument about the *platform* — it was an argument about one *route* to it. The public timeline is the same surface Instagram is already read from, under the same reasoning: it is what any visitor sees. Nothing about the original assessment was wrong; its scope had quietly widened in the retelling.

**The actor choice is the substance of this decision, and two of three candidates fail in ways the output shape does not reveal:**

| Actor | Outcome |
|---|---|
| `apidojo/tweet-scraper` | **Unusable.** Most-run X scraper on the platform by two orders of magnitude and the one every tutorial shows. It refuses API access on the Apify free plan — but *not by failing*. The run returns HTTP 201, status `SUCCEEDED`, and ten rows of `{"noResults": true}`. Trust the run status and count the rows and you have learned that a head of government posts nothing |
| `xtdata/twitter-x-scraper` | **Runs, and was the first implementation.** Abandoned on two counts found only by attempting a full ingest: $0.005/tweet (20× the going rate), and a `minimalMaxTotalChargeUsd` of **$3** that Apify checks against remaining credit before launching. Below $3 of credit no run starts at any `maxItems` or `maxTotalChargeUsd`. It also returns no view count |
| `kaitoeasyapi/…-cheapest` | **Chosen.** $0.00025/tweet, no minimum pre-authorisation, and it returns `viewCount` — which is what keeps X on the views basis rather than followers |

**Why that last column matters more than the price.** `VIEW_NATIVE_PLATFORMS` listed X before any X adapter existed, on the strength of the impression count X shows on its own web UI. That is a claim about the *source*, not the platform, and the first actor disproved it — an X corpus read through xtdata would have fallen silently through to the followers basis without erroring, re-basing a whole platform mid-product. Membership of that set is now documented as an adapter-dependent fact.

**Cost:**

- **The corpus is capped at 160 posts per account**, and because the cap is on count while the accounts post at very different rates, that bought 15 days of the principal and 65 days of one peer. **This manufactured a false finding before it was caught** — see §2.8.
- **Retweets and replies-to-others are dropped**, so X post counts are lower than a raw timeline count. A retweet's metrics belong to the original author; a reply reaches a different audience under different distribution rules. Self-replies are kept, because a thread is one broadcast post that happens to be chunked.
- **X classification is incomplete.** 640 new posts exhausted the Gemini free tier 175 rows in, so theme gaps on X cover a recent-skewed subset. `gaps.ts` reports the fraction rather than presenting the finding flat.
- **The adapter is one actor away from breaking**, on a marketplace where actors change pricing and access terms unilaterally. `X_ACTOR` makes a swap a `.env` change, and `assertUsableRun` turns the specific way these actors fail — refusal-as-data — into a loud error rather than a zero.

---

## 2 — Measurement

### 2.1 Weighted interactions, not a raw sum

**Chosen:** `(1 × likes) + (3 × comments) + (5 × shares) + (4 × saves)`.

**Rejected:** an unweighted sum; likes-only.

**Why:** these actions are not equivalent signals. A like costs a thumb-tap; a share costs the user reputation with their own audience *and* distributes the message. Summing them lets high-volume, low-commitment engagement drown out the actions that indicate a post actually landed. For a communications team, a share is the closest available proxy to the outcome they want.

**Cost, and this is the honest one:** the weights are a judgement call, not an empirically fitted model. Fitting them properly needs an outcome variable we don't have — reach lift per action type, or downstream follower conversion. Mitigation is structural rather than statistical: the weights live in one exported constant, and the tests pin the *arithmetic*, not the weights, so a team that disagrees can change them without breaking anything silently.

### 2.2 Views-first denominator, with an explicit basis flag

**Chosen:** normalise by `views` where a platform exposes them (YouTube, short video, X impressions); by `followerCount` otherwise. Every computed rate carries `erBasis: VIEWS | FOLLOWERS`.

**Rejected:** followers everywhere (simple, comparable, wrong); views everywhere (unavailable on half the corpus).

**Why:** followers are a *potential* audience; views are a *realised* one. "Of the people who actually saw this, how many acted" is what format and timing analysis is genuinely asking. Follower-normalisation conflates a content-quality question with an audience-size question.

**Cost:** two incommensurable quantities now exist in one system — hence §2.3.

### 2.3 The analytics layer refuses to aggregate across mixed bases

**Chosen:** mixing `VIEWS`- and `FOLLOWERS`-based rates in one aggregate **throws**. Where a comparison spans both, the UI splits it into two panels.

**Rejected:** averaging them; silently preferring one; a conversion factor between them.

**Why:** a view-normalised rate and a follower-normalised rate differ by an order of magnitude. Averaging them produces a number that looks precise and means nothing — the exact failure this project is graded against. A conversion factor was rejected because it would have to be invented, and an invented constant buried in a denominator is worse than a refusal.

**Cost:** some comparisons a user would like to see are simply unavailable, and the UI has to explain why. A thrown error is a deliberately loud failure mode: better a developer hits it in a test than a comms manager acts on a blended number.

### 2.4 Spread reported alongside every average

**Chosen:** mean, median, stdev, IQR and `n` on every format statistic. Where `mean / median > 1.5`, the distribution is flagged outlier-driven and the recommendation layer leads with the median.

**Rejected:** mean alone.

**Why:** a format with one viral post and nine duds is not a good format, but its mean says otherwise. The seed generator plants a 4% viral rate precisely so this flag has something real to catch.

**Cost:** more numbers on screen than a simpler dashboard would show. Accepted — the alternative is a confident average with a lie inside it.

### 2.5 Sample-size thresholds enforced in code, not styled in CSS

**Chosen:** heatmap cells with `n < 2` are suppressed entirely; hour and day marginals with `n < 3` are dropped; anything under `n < 5` renders muted and flagged; format statistics with `n < 5` read "insufficient data"; any recommendation resting on `n < 5` is dropped by the validator.

**Rejected:** rendering everything and greying out the thin cells.

**Why:** a greyed-out cell is still a cell, and a number on screen gets acted on regardless of its styling. Suppression has to be a property of the computation, or it isn't a guarantee.

**Cost:** a sparse account's heatmap will have real holes in it. That is the correct appearance for sparse data.

**Amended:** the grid and the marginals were originally gated by one constant at `n < 3`, which conflated "is this worth drawing?" with "is this worth citing?". They are different questions: a thin cell on a picture costs a reader nothing as long as it is visibly marked thin, while a thin marginal becomes a sentence in a recommendation. The grid's floor is now 2 and the marginals' is 3 — so the heatmap is legible on a real account without the recommendation layer's bar moving. Lowering one can no longer silently lower the other, and a test asserts the two floors stay in that order.

### 2.6 The gap panel reports what it rejected, and why

> **Partly superseded by §2.9.** `MIN_PEER_ACCOUNTS` was subsequently lowered to 1
> by product decision, so most of what this entry sends to the near-miss list is
> now a reported gap. The near-miss machinery and everything below about keeping
> a refusal from reading as a finding still stands.

**Chosen:** alongside its gaps, `findGaps` returns **near misses** — buckets where at least one peer cleared the 1.2× bar on its own, but the evidence failed a gate — each tagged with the gate that stopped it (`SINGLE_PEER_ONLY`, `NO_PEER_AGREEMENT`, `MEDIAN_BELOW_BAR`, `PRINCIPAL_COMPETITIVE`) and what would change it. Every gap and near miss also carries its per-peer evidence, and each dimension reports how many buckets it could actually test.

**Rejected:** lowering `GAP_LIFT_THRESHOLD` or `MIN_PEER_ACCOUNTS` to produce more findings; ranking near misses alongside gaps; leaving the panel as it was.

**Why:** the gates are strict and on a real corpus they reject nearly everything — the first live run across three platforms returned **one** gap in six basis-platform combinations. The statistic is right, and every attempt in this project to relax it has produced a finding that did not survive scrutiny (see the `MIN_PEER_ACCOUNTS` note in `gaps.ts`, where one peer at 1.76× and one at exactly 1.00× interpolated to a reportable 1.38×).

But `No gap clears the bar on this basis`, rendered alone above a table about over-investment, is indistinguishable to a reader from *we did not look* — and it discards the most useful thing the analysis knows. A bucket where one peer sits at 1.48× and a second at 1.11× is not nothing; it is a named, quantified thing to watch with a stated distance to the bar. The entry rule is deliberately narrow — **at least one peer must have cleared the bar on its own** — which is exactly the situation `MIN_PEER_ACCOUNTS` was written for. A near miss is the gate's own argument made visible, not a softer gate under a different name.

The per-peer evidence closes a smaller hole in the same wall: `2 of 3 peers agree` was an assertion the reader had no way to check, because the projection computed the per-peer lifts and then dropped them.

**Cost:**

- **A near miss can be misread as a finding**, and that would be worse than the blank panel it replaces. Everything that makes a gap look actionable is withheld: no opportunity multiple, no table, muted type, an explicit *These are not findings* line, and `describeNearMiss` leads with `NOT REPORTED as a gap` so the AI layer receives a refusal it cannot paraphrase into a claim. Six tests pin that separation. It remains the main risk in the change.
- **More surface area on screen.** The panel is longer and denser, and a reader in a hurry has more to skim past before reaching the findings.
- **The `PRINCIPAL_COMPETITIVE` reason is good news wearing a warning's clothes** — "peers do well here and so do you" sits in a list of things that failed. It is sorted last and dimmed, which is a presentation fix for what is really a taxonomy problem.

### 2.7 Derived metrics are computed, never stored

**Chosen:** engagement rate is computed in `analytics/engagement.ts` at query time.

**Rejected:** an `engagementRate` column on `Post`.

**Why:** follower counts change, so a stored rate goes stale silently — the worst kind of wrong, because nothing in the system reports it. A single computation path is also a single thing to test.

**Cost:** repeated computation on every request. If it ever gets slow the fix is a cache with an explicit TTL, not a denormalised column — the staleness stays visible either way.

### 2.8 Cadence is withheld when histories do not cover the window

**Chosen:** `compareCadence` checks whether each account's earliest post covers the window it is being divided by. If any account's does not, the platform's cadence figures — the comparison **and** the principal's own rate and consistency — are returned as `null` with a sentence explaining why.

**Rejected:** publishing the figures with a caveat; giving each account its own denominator (the failure mode `cadence.ts` was written against — an account with two posts three days apart is not posting 4.67×/week).

**Amended, Day 4 — the intersection window was rejected here and is now the first fallback.** See §2.8a. Withholding is still what happens when narrowing cannot produce an honest window; it is no longer the only thing that happens.

**Why:** found the day X went live, and it is the sharpest example in the project of correct arithmetic over incomparable inputs. The X adapter caps results per account for cost reasons. The cap is on **count**, but the accounts post at very different rates, so 160 posts bought 15 days of the principal and 65 days of one peer — and `windowSpanning` takes the union, dividing all four by the same 65-day denominator.

Every account came out at exactly **17.11 posts/week**. The dashboard reported `principalVsPeers = 1.00×` — *he posts exactly as often as his peers*. That is not a weak finding, it is a manufactured one: the number measures the result cap. Consistency was worse, reporting the principal as active in **30% of weeks** when he posts most days, because seven of the ten blocks predated anything that had been fetched.

Withholding beats caveating here because the figure is not *approximately* right. `1.00×` is a specific, memorable, false claim, and a caveat under a number that precise does not survive being skimmed.

**Cost:**

- **The check is a heuristic on post rows** (`MIN_WINDOW_COVERAGE = 0.9`), not a fact from ingestion. The truncation is *known* at fetch time — `rowsFetched === limit` — and plumbing that through `IngestionRun` to the analytics layer would let the two cases be told apart properly. Not done.
- **It can fire on honest data**: an account that genuinely started posting a month into the window will suppress its platform's cadence. That is the conservative direction, but it is a real false positive.

### 2.8a The withheld panel gets a second chance: narrow the window, don't blank the panel

**Chosen:** when the comparison is not comparable over the derived window, `compareCadence` re-runs it over `windowCovered` — the latest first-post across accounts through to the end of the data — and publishes that, labelled. It falls back to withholding when the covered span is under `MIN_NARROWED_DAYS` (14) or when an account is silent through the start of it too. A window the *caller* named is never narrowed.

**Rejected:** leaving §2.8 as the only behaviour; narrowing without a floor; narrowing silently.

**Why:** §2.8 was right that `1.00×` had to go and wrong that nothing could replace it. The reasoning it rejected the intersection window on — *an account genuinely silent early looks identical to a truncated one* — is still true, but it argues against the wrong thing. Both cases have the same remedy: measure over the span where every account's history is complete, and say that is what you did. The union window is not more honest than the covered window; it is a denominator three of the four accounts never had data for.

The practical case for it is that §2.8's cost line was accurate and expensive. A blank panel on the platform the reviewer is most likely to click reads as a broken pipeline, not as a refusal, and the sentence explaining it is the one thing a skimming reader will not read. On the roster this was found with, narrowing to 20 days recovers a real finding — the principal posts **2.19×** the peer median — where the union window manufactured `1.00×`.

Three constraints keep it honest:

- **A floor at two weekly blocks.** Below that, `consistency` reads 100% for anyone who posted at all, so narrowing would buy a posts-per-week figure by silently destroying the regularity figure next to it. Under 14 days the panel stays blank.
- **The disclosure leads.** Both the sentence and the panel state the shortened window *before* any rate, name the accounts that forced it, and say consistency over few weeks is weak evidence. A denominator disclosed after the numbers has already been mis-read.
- **Never on a window the caller asked for.** An explicit date range is a question about a period; answering a different period quietly would be a worse failure than the one this fixes.

**Cost:**

- **A genuine early silence stops showing up in the numbers.** An account dark for the first month of the window now moves the window instead of scoring a low rate. The prose says it has no history before the narrowed start; the *figures* no longer show it. This is the objection §2.8 raised, and it is not fully answered — only disclosed.
- **Two accounts can now be compared over 15 days and called comparable.** They are, but a fortnight of cadence is thinner evidence than a quarter of it, and the only thing standing between a reader and that mistake is the sentence.
- **The window is now data-dependent.** Re-ingesting changes the denominator, so cadence figures are not stable across runs in the way a fixed 90-day window would be.
- **None of this is the fix.** The fix is a result cap large enough to cover the window — ~$0.60 on X — and the narrowing is what the product does while the cap is wrong. RUNBOOK §4.4.

### 2.9 One competitor is enough for a gap

**Chosen:** `MIN_PEER_ACCOUNTS = 1`. A bucket where a single peer clears the 1.2× bar over five or more posts is a reported gap, carrying the count of how many peers backed it and a `ONE PEER` flag on the finding itself.

**Rejected:** keeping the floor at 2 (the previous behaviour); lowering `GAP_LIFT_THRESHOLD` or `MIN_GAP_N` instead; reporting one-peer buckets only as near misses.

**Why:** a product decision, and it reverses a gate this file previously defended — so the reasoning on both sides is worth keeping.

The gate existed because of a real failure. The first run of `gaps.ts` surfaced an Instagram day-of-week "gap" at **1.38×**, built from one peer at 1.76× and one at exactly 1.00×. One account's strong bucket is that account's *habit*, and a recommendation built on it is a recommendation to imitate one person rather than to follow a pattern.

What outweighed it: at a floor of 2, three of the four live basis-platform panels reported **zero** gaps against a 2,365-post corpus. The module that answers *"what are they doing that we aren't?"* was answering "nothing" almost everywhere, and a missed real opportunity was judged the more expensive error.

**What was kept from the gate, and this is the substantive part.** The 1.38× failure had two halves, and only one of them was about agreement. The other was that the headline figure was the median across *every* peer with a sample, so it interpolated between a strong peer and a flat one and published a number **neither peer achieved and no reader could check against an account**. `peerLift` is now the median of the **clearing** peers, so the same bucket reports 1.76× — Strong's actual number — with `1 of 2` beside it. Lowering the agreement bar did not require lowering the honesty bar on the figure.

Two things carry the rest of the weight, and neither existed when the gate was written: `peerAgreement` and the per-peer evidence rows both ship to the UI (§2.6), and a gap resting on one competitor is badged `ONE PEER` on its face so a reader does not have to open the evidence to notice.

**Cost:**

- **Thin findings are now published, and they are the majority.** **16 of the 19** gaps shown on the live corpus rest on a single peer. Every one is flagged, but a flag is weaker than a refusal, and some of these will not reproduce. This ratio is the honest measure of what the change bought and what it cost.
- **The 1.38× class of error returns in a milder form.** A gap can still be one account's habit. What can no longer happen is publishing a lift figure that no account earned.
- **The near-miss list is nearly empty.** At this floor the only reachable reason is `PRINCIPAL_COMPETITIVE`; `SINGLE_PEER_ONLY` and `NO_PEER_AGREEMENT` are unreachable, and `MEDIAN_BELOW_BAR` was removed outright because a median over values that each clear the bar cannot fall below it. The machinery and its tests are kept intact, because the floor is a one-line constant and deleting them is how it stops being tunable.
- **`MAX_GAPS = 5` now truncates.** Panels that reported nothing are hitting the cap, and the truncation note is doing real work rather than sitting unused.

---

## 3 — The AI layer

### 3.1 The recommendation model never sees raw post data

**Chosen:** the LLM receives only the pre-computed analytics JSON from `buildReport.ts`, each figure with its `n` already attached.

**Rejected:** giving the model the post corpus and asking it to find patterns.

**Why:** this is the decision the whole project is built around. A model with no raw engagement figures **cannot invent an unverified number** — at worst it misinterprets a verified one. That is an architectural guarantee rather than a prompt instruction, and prompt instructions are not guarantees.

**Cost:** the model cannot surface a pattern the deterministic analytics layer didn't compute. Every insight the product can express must first exist as tested code. Accepted deliberately: a narrower set of defensible claims beats a wider set of unverifiable ones.

### 3.2 A deterministic validator, built in the same sitting as the generator

**Chosen:** `validate.ts` — pure code, no LLM. Extracts every numeric literal and every `post_id` from the model's output and checks each against the analytics JSON that produced it. Fail → retry once naming the specific violation → fail again → **drop the recommendation and log the drop**.

**Rejected:** an LLM-as-judge validator; validating by prompt ("only cite numbers from the input"); building the validator after the generator.

**Why:** an LLM judge shares the failure mode it is meant to catch. And a validator written afterwards gets shaped by the output it sees rather than by the rule it should enforce — which is why the build plan pins it to the same sitting and the cut list marks it never-cut.

**Cost:** correctly-worded recommendations are sometimes dropped over a rounding mismatch. Accepted: **a dropped recommendation is better than a fabricated one, and a visible drop count is better than a silent one.**

### 3.3 A fixed content taxonomy, not model-induced themes

**Chosen:** eight fixed pillars, shared as one constant. Posts below a confidence threshold fall to `OTHER`, and the theme analysis reports how much of the corpus is unclassified.

**Rejected:** letting the model induce categories from each corpus.

**Why:** the principal and three competitors must be classified into the *same* categories or the gap analysis compares nothing. Induced taxonomies drift between corpora — the whole point of Module C is a like-for-like comparison.

**Cost:** a genuinely novel content type has nowhere to go but `OTHER`. Reporting the unclassified share is the mitigation; hiding it would be the failure.

### 3.4 The LLM does two jobs only

**Chosen:** classification (a judgement task rules do badly) and writing recommendations from verified numbers (a language task). All arithmetic, aggregation, sample-size gating and validation are deterministic tested code.

**Why:** each of those is what the respective tool is actually good at. An LLM asked to compute a median will sometimes produce a plausible one.

**Cost:** none identified. This is the boundary the architecture exists to enforce.

---

## 4 — Stack & structure

### 4.1 React SPA + Express, not Next.js

**Chosen:** a separate Vite SPA and an Express API.

**Rejected:** Next.js — which is what the team uses in production.

**Why:** a hard network boundary between ingestion, analysis and presentation is exactly what's being assessed here, and it is more visible across two processes than inside one framework's server components. Secondary: learning a framework's conventions during a four-day build spends time on the wrong thing.

**Cost:** it diverges from the team's production stack, and a real deployment would likely consolidate. CORS and two dev servers are minor overhead. The API surface is plain REST, so the port is mechanical.

### 4.2 Prisma over Drizzle

**Chosen:** Prisma 7 with `@prisma/adapter-pg`.

**Rejected:** Drizzle — closer to the team's production stack.

**Why:** faster to reason about under time pressure, migrations included, and `schema.prisma` doubles as readable documentation of the data model — which matters when the schema is itself part of the deliverable.

**Cost:** the divergence from production noted above, plus Prisma 7's ESM-first stance, which forced §4.3.

### 4.3 The server moved to ESM

**Chosen:** `"type": "module"`, `moduleResolution: bundler`, the `prisma-client` generator with `moduleFormat = "esm"`.

**Rejected:** forcing Prisma 7's ESM output back into a CommonJS project.

**Why:** the Day 0 audit found a latent `ERR_REQUIRE_ESM` — Prisma 7's ESM output sitting in a `"type": "commonjs"` project, waiting for the first import to fail. `tsx` was masking a broken `tsc --noEmit`, so the seed adapter ran while the typecheck was already failing. Fighting an ESM-first library back into CJS costs more than moving.

**Cost:** ESM's sharper edges — explicit extensions in some contexts, no `require`. Contained and one-time.

### 4.4 `onDelete: Cascade` on both relations to `Account`

**Chosen:** cascade.

**Rejected:** Prisma's default `Restrict`; soft-delete with a `deletedAt` column.

**Why:** FR1 is a MUST — the user removes tracked accounts from the UI — and `Restrict` makes that fail with a foreign-key error the moment an account has posts. Soft-delete was rejected because the audit value of orphaned posts doesn't justify adding a `deletedAt IS NULL` predicate to every query in the system, and forgetting it once produces wrong numbers silently.

**Cost:** removing an account destroys its history irreversibly. `IngestionRun` rows go with it, so the audit trail is scoped to accounts that still exist.

### 4.5 `fetchAccountMeta()` on the adapter interface

**Chosen:** the adapter contract returns account-level facts, not just posts.

**Rejected:** maintaining follower counts by hand outside the adapters.

**Why:** follower count *is* the engagement-rate denominator for non-video platforms, and only the source can supply it — YouTube reports subscribers, Instagram reports followers. Hand-maintained follower counts would go stale and silently distort every rate they touch.

**Cost:** one more method every adapter must implement, including sources that have nothing useful to return (`followerCount: null`). On Instagram it costs a **second Apify actor**: the post scraper does not report follower count, and Instagram stills carry no view count, so without the profile scraper every photo and carousel would fall into `NO_DENOMINATOR` and drop out of the comparison. Two actor runs per account per refresh is the price of the denominator existing at all.

### 4.6 `fileAdapter.ts`, not `csvAdapter.ts`

**Chosen:** one adapter handling both CSV and JSON, named for what it does.

**Why:** the architecture sketch said `csvAdapter.ts`, but the shipped module handles both formats behind one entry point. Naming it for CSV alone would have been misleading to the next reader — a small thing, recorded because the architecture doc says otherwise and an unexplained mismatch reads as drift.

### 4.7 Ingestion refreshes accounts; it never creates them

**Chosen:** an account must exist before it can be ingested. `fetchAccountMeta` may update `followerCount`; it may not touch `displayName`.

**Rejected:** auto-creating accounts from whatever a source returns.

**Why:** which accounts to track is a user decision (FR1), not something a data source gets to assert. `displayName` is a label the user set in the UI, and a source overwriting it would be the user's edit vanishing for no visible reason.

**Cost:** importing a CSV for an untracked account fails rather than helpfully creating it. The error names the missing account.

### 4.8 Sequential ingestion, with per-account failure isolation

**Chosen:** accounts are ingested one at a time; one failing does not stop the others.

**Rejected:** parallel fetches.

**Why:** real APIs rate-limit, and a burst of parallel requests is the fastest way to get a key throttled. One slow pass that finishes beats a fast one that gets cut off. Failures are already recorded in each account's own `IngestionRun` row, and a partial refresh is more useful than none.

**Cost:** a full refresh is slower than it could be. Irrelevant at 16 accounts; would need revisiting at hundreds.

### 4.9 `seed.ts` folded into `ingest.ts` behind a `--roster` flag

**Chosen:** one script. `npm run ingest` refreshes posts; `npm run ingest -- --roster` reconciles the roster first; `--check-handles` resolves every handle and writes nothing.

**Rejected:** keeping `npm run seed` as the roster command; keeping two scripts under new names.

**Why:** the command was named for the thing it no longer does. In a product whose central claim is that its data is real, a first-run command called `seed` is a trap for exactly the reader the claim is aimed at. The distinction the two scripts protected is still real — refreshing posts must not silently re-assert the roster, or accounts added through the UI (FR1) vanish — so it survives as a flag, which is where a modal difference of one line of behaviour belongs.

`--check-handles` was added at the same time because live sources made handle correctness load-bearing: a wrong handle either fails the run or attributes a stranger's posts to a politician, and neither is catchable downstream.

**Cost:** the first-run command now carries a flag (`npm run ingest -- --roster`), which is marginally less obvious than a bare word. Every doc that referenced `npm run seed` had to change, including two strings in the UI.

### 4.10 Normalisation counts bad rows instead of throwing on them

**Chosen:** `normalize.ts` validates and collects failures; the pipeline records them as `rowsFailed`. It imports nothing from Prisma.

**Rejected:** throwing on the first bad row; writing rows through unvalidated.

**Why:** sources lie, omit and occasionally return nonsense. A bad row should be counted and skipped, never written and never allowed to abort the batch — which is what makes `IngestionRun.rowsFailed` a number worth looking at. Keeping the ORM out means normalisation is unit-testable without a database.

**Cost:** a systematically malformed feed degrades quietly into a high `rowsFailed` count rather than a loud crash. Mitigated by `status: "partial"` being distinct from `"success"`, so a run that lost half its data cannot read as clean.

---

## 5 — Process

### 5.1 A commit per working piece

Commit history is read as evidence of process, and a single 4,000-line commit is evidence of the wrong one. Five commits for Day 1, one per shipped unit.

### 5.2 Documentation is corrected when it stops being true

The Day 0 audit sections in `ARCHITECTURE.md` are kept as originally written, with resolutions appended, because the diagnosis is what shaped the fix and deleting it would hide the reasoning. The **status tables are different** — a stale status table actively misleads, so those are rewritten. On Day 1 the README still described the seed generator as the next task and claimed analytics tests that did not exist; both were corrected here rather than left to look like completed work.

### 5.3 What gets cut, in order

`theme × format` → `filters` → `PDF export (Markdown stays)` → `any stretch item` → `a platform's coverage`.

**Cadence analysis was first on this list and should never have been on it** — it is named inside a Module C MUST, so the first sacrifice would have broken a required deliverable. An item that appears in two places inherits the weaker priority unless someone checks.

**"Seed it and say so" is no longer the last resort.** The original list ended with *"the second live platform (seed X, say so plainly)"*. Since Day 4 that move does not exist: a platform is read for real or left visibly empty. The list is shorter and the remaining choice is starker.

**Never cut:** the validator, the tests on `engagement.ts`, this file, and the clean-clone test.
