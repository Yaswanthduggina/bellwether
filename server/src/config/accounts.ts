// The tracked set: one principal and three peers, declared across all four
// platforms and ingested on the two that can currently be read.
//
// WHY THESE FOUR
//
// Four national-tier Indian political figures: the Prime Minister as principal,
// against the Leader of the Opposition, the Union Home Minister, and a former
// Chief Minister who leads a national party. Comparable by office and by the fact
// that all four run genuinely active multi-platform operations — without volume
// there is nothing for format or timing analysis to chew on.
//
// THE FOLLOWER SPREAD IS THE KNOWN WEAKNESS OF THIS SET, and it is recorded
// rather than glossed. Measured 1 Aug 2026:
//
//   Instagram   4.06M – 105.6M    26x spread
//   YouTube     0.72M –  31.2M    43x spread
//
// An earlier roster was deliberately chosen to sit inside roughly ONE order of
// magnitude, because the brief warns that benchmarking a national figure against
// a first-term MLA produces a chart that is technically correct and useless. This
// set does not meet that bar: the principal is an order of magnitude above every
// peer on both live platforms.
//
// What makes it defensible is the same thing that made the spread tolerable
// before — nothing in this product ranks on raw followers or raw likes. Every
// cross-account comparison runs through a normalised engagement rate with an
// explicit denominator: views on YouTube, followers elsewhere. See the
// engagement-rate section of the README.
//
// What it does NOT fix: an account with 105M followers has a structurally
// different engagement rate from one with 4M — very large audiences engage at a
// lower rate almost mechanically. So a "the principal underperforms his peers on
// rate" finding from this roster should be read with that in mind, and the
// per-account format and timing analysis (which compares an account against
// ITSELF) carries more weight here than the cross-account rate comparison does.
//
// Contrast is deliberate too. Kejriwal's format and cadence mix differs sharply
// from the principal's, and Amit Shah is a same-party control — a peer set that
// all behaved identically would make gap analysis (a Module C MUST) vacuous.
//
// ─────────────────────────────────────────────────────────────────────────
// DECLARED vs TRACKED
//
// Every handle below is declared, including the ones on platforms with no adapter
// yet. Only the platforms whose adapter is LIVE are ingested — the split is
// derived from the registry in adapters/index.ts, not restated here, so building
// xAdapter.ts flips those accounts on with no edit to this file.
//
//   TRACKED_ACCOUNTS   ingested now         (Instagram, YouTube)
//   PLANNED_ACCOUNTS   declared, not ingested (X, Facebook — blockers in the registry)
//
// Nothing is seeded. A platform we cannot read stays empty and says why; it does
// not get filled in with generated posts that then need labelling everywhere they
// surface.
//
// ─────────────────────────────────────────────────────────────────────────
// ON THE HANDLES
//
// These are public accounts belonging to public figures acting in a public
// capacity — the only category this product touches. Every tracked handle is
// fetched live, so a wrong one is not a cosmetic error: it either fails the run
// or, worse, attributes a stranger's account to a politician. Both adapters
// therefore throw on an unresolved handle instead of returning an empty list, and
// `npm run ingest -- --check-handles` resolves every handle without writing a row.
//
// YouTube — every channel below resolved against the Data API on 1 Aug 2026 and
// confirmed by its own description, not by subscriber count alone:
//
//   @narendramodi     "Narendra Modi"     31.2M subs  "Official YouTube channel of Shri Narendra Modi, PM of India"
//   @RahulGandhi      "Rahul Gandhi"      10.8M subs  "Leader of Opposition, Lok Sabha | INC | MP, Raebareli"
//   @ArvindKejriwal   "Arvind Kejriwal"    1.09M subs
//   @AmitShah         "Amit Shah"          723K subs  "Official YouTube Channel of Amit Shah"
//
// @AmitShah is the one that needed checking rather than assuming. 723K subs is an
// order of magnitude below the other three and looks anomalous for a Home
// Minister, so it was resolved for its DESCRIPTION before being trusted — it
// self-identifies as the official channel. @AmitShahOfficial does not exist.
//
// Instagram — resolved against the live source on 1 Aug 2026, measured rather
// than taken from a stats site:
//
//   @narendramodi        105,630,443 followers   PM of India
//   @amitshahofficial     35,502,552 followers   Union Home Minister
//   @rahulgandhi          14,914,042 followers   Leader of the Opposition
//   @arvindkejriwal        4,060,543 followers   former CM, Delhi
//
// ⚠ THE HANDLE THAT NEARLY POISONED THIS ROSTER. The obvious first guess for
// Amit Shah on Instagram is @amitshah. It RESOLVES — to a namesake with 322
// followers. Ingesting it would have attached a private individual's posts to a
// Union Minister and produced a real-looking row of near-zero engagement: a
// fabricated finding, arrived at honestly, and one no downstream gate would have
// caught because 322 is a perfectly valid follower count. The correct handle is
// @amitshahofficial, at 35.5M.
//
// That is the second time a plausible handle has resolved to the wrong account in
// this project (the first was a dormant @VarunGandhi YouTube channel under the
// previous roster). It is the argument for `--check-handles` existing at all:
// resolving a handle and READING WHAT CAME BACK costs one cheap call, and is the
// only thing standing between a typo and a chart about a stranger.
// ─────────────────────────────────────────────────────────────────────────

import { hasLiveAdapter } from "../adapters";

export type Platform = "INSTAGRAM" | "FACEBOOK" | "X" | "YOUTUBE";
export type AccountRole = "PRINCIPAL" | "COMPETITOR";

export interface TrackedAccount {
    /** Links this account to the same person's accounts on other platforms. */
    personName: string;
    role: AccountRole;
    platform: Platform;
    handle: string;
    displayName: string;
    /** IANA zone. Drives the local-time timing heatmap (FR7). */
    timezone: string;
}

const IST = "Asia/Kolkata";

/**
 * Platforms are optional per person. A missing entry means "no account we can
 * verify", which is a fact about that person on that platform — not a gap to be
 * papered over with a handle that merely looks plausible.
 */
function forPerson(
    personName: string,
    role: AccountRole,
    displayName: string,
    handles: Partial<Record<Platform, string>>,
): TrackedAccount[] {
    return (Object.keys(handles) as Platform[])
        .filter((platform) => handles[platform])
        .map((platform) => ({
            personName,
            role,
            platform,
            handle: handles[platform]!,
            displayName,
            timezone: IST,
        }));
}

/** Everyone we intend to cover, on every platform, regardless of adapter status. */
export const DECLARED_ACCOUNTS: TrackedAccount[] = [
    // PRINCIPAL — Prime Minister. The highest-volume, highest-reach political
    // account in the country on every platform here, which is what makes the
    // follower spread below a real analytical issue rather than a footnote.
    ...forPerson("Narendra Modi", "PRINCIPAL", "Narendra Modi", {
        INSTAGRAM: "narendramodi",
        YOUTUBE: "narendramodi",
        X: "narendramodi",
        FACEBOOK: "narendramodi",
    }),

    // Leader of the Opposition, Lok Sabha. The direct counterpart to the
    // principal and the most natural comparison in the set.
    ...forPerson("Rahul Gandhi", "COMPETITOR", "Rahul Gandhi", {
        INSTAGRAM: "rahulgandhi",
        YOUTUBE: "RahulGandhi",
        X: "RahulGandhi",
        FACEBOOK: "rahulgandhi",
    }),

    // Union Home Minister. Same party as the principal, comparable office and
    // reach — the within-party control against which the principal's own format
    // and timing choices can be read as choices rather than as party house style.
    ...forPerson("Amit Shah", "COMPETITOR", "Amit Shah", {
        INSTAGRAM: "amitshahofficial",
        YOUTUBE: "AmitShah",
        X: "AmitShah",
        FACEBOOK: "amitshahofficial",
    }),

    // Former Chief Minister of Delhi, national party leader. Included for
    // contrast: a different format and cadence mix, so gap analysis has
    // something real to find rather than three variations of one posting style.
    ...forPerson("Arvind Kejriwal", "COMPETITOR", "Arvind Kejriwal", {
        INSTAGRAM: "arvindkejriwal",
        YOUTUBE: "ArvindKejriwal",
        X: "ArvindKejriwal",
        FACEBOOK: "AAPKaArvind",
    }),
];

/**
 * The accounts ingestion actually creates and refreshes.
 *
 * Derived from the adapter registry rather than hand-maintained: an account is
 * tracked exactly when its platform can be read for real. The X and Facebook
 * handles above are declared but not ingested — they are not seeded either.
 */
export const TRACKED_ACCOUNTS: TrackedAccount[] = DECLARED_ACCOUNTS.filter((account) =>
    hasLiveAdapter(account.platform),
);

/** Declared, not yet ingestible. Printed by the roster run so the gap stays visible. */
export const PLANNED_ACCOUNTS: TrackedAccount[] = DECLARED_ACCOUNTS.filter(
    (account) => !hasLiveAdapter(account.platform),
);

export const PRINCIPAL_NAME = "Narendra Modi";
