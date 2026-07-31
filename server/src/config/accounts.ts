// The tracked set: one principal and three peers, declared across all four
// platforms and ingested on the two that can currently be read.
//
// WHY THESE FOUR
//
// The brief warns that benchmarking a 20M-follower national figure against a
// first-term MLA produces a chart that is technically correct and completely
// useless. So the peer set is chosen for *comparability of office and reach*, not
// for name recognition: four national-profile parliamentary-tier figures, all
// India-based, all active across multiple platforms, within roughly one order of
// magnitude of each other on audience size.
//
// They are NOT identical in follower count, and that is the point — it is exactly
// why nothing in this product ranks on raw followers or raw likes. Every
// cross-account comparison runs through a normalised engagement rate with an
// explicit denominator. See the engagement-rate section of the README.
//
// Contrast is deliberate too. Kanhaiya Kumar is video-native where Tharoor is
// text-forward; Varun Gandhi posts a fraction as often. A peer set that all
// behaved identically would make gap analysis (a Module C MUST) vacuous.
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
// YouTube — verified against the Data API:
//
//   @ShashiTharoorOfficial       "Dr. Shashi Tharoor Official"    835K subs   LIVE
//   @PriyankaChaturvediOfficial  "Priyanka Chaturvedi Official"    42.7K subs LIVE
//   @KanhaiyaKumar               "Kanhaiya Kumar"                  3.71M subs LIVE
//   @VarunGandhi                 0 subscribers, one 2023 upload    SQUATTER
//
// The first guess for Priyanka Chaturvedi (@PriyankaChaturvedi) did not resolve
// at all. Worse, @VarunGandhi DOES resolve — to a dormant channel with no
// subscribers whose only upload is a 2023 "Happy Independence Day" post.
// Ingesting it would have produced a real-looking row of near-zero engagement
// attributed to a sitting politician: a fabricated finding, arrived at honestly.
// No alternative handle resolves, so Varun Gandhi has NO YouTube entry.
//
// Instagram — resolved against the live source on 31 Jul 2026, measured rather
// than taken from a stats site:
//
//   @shashitharoor       2,299,726 followers   ~2,125 posts   INC MP, Thiruvananthapuram
//   @kanhaiyakumar       1,508,085 followers                  AICC/NSUI, ex-JNUSU president
//   @ferozevarungandhi     838,354 followers   28 posts       MP, Lok Sabha 2009-2024
//   @priyankac19           382,514 followers   ~866 posts     former MP, Shiv Sena (UBT)
//
// Two things that follow from that table, both load-bearing:
//
// ① The Instagram spread is 383K–2.30M — 6.0x, comfortably inside the one
//    order of magnitude the peer set was chosen for. (YouTube's 87x spread is the
//    outlier, and it is harmless there only because YouTube engagement is
//    normalised by views rather than subscribers.)
//
// ② @ferozevarungandhi has 28 posts in the account's entire life, so a 90-day
//    window may legitimately return ZERO. That is a real finding about how he
//    uses the platform, not a bug — the sample-size gates in format.ts, timing.ts
//    and gaps.ts will exclude him with a stated reason rather than reporting
//    conclusions from two posts. If a fuller peer is wanted on Instagram, the
//    honest fix is to swap the person, not to lower the gates.
//
// Varun Gandhi is the awkward one here too. He appears under several handles:
// @therealvarungandhi (4K followers, 70 posts, bio claims official) and
// @ferozevarungandhi (839K, MP bio, 28 posts). Feroze Varun Gandhi is his name as
// recorded by the Lok Sabha, and the reach is consistent with the peer set, so
// that is the handle tracked. It is the one judgement call in this list.
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
    // PRINCIPAL — sitting Lok Sabha MP (Thiruvananthapuram). Chosen for genuine
    // multi-platform activity: without volume there is nothing for format or
    // timing analysis to chew on.
    ...forPerson("Shashi Tharoor", "PRINCIPAL", "Shashi Tharoor", {
        INSTAGRAM: "shashitharoor",
        YOUTUBE: "ShashiTharoorOfficial",
        X: "ShashiTharoor",
        FACEBOOK: "ShashiTharoor",
    }),

    // Rajya Sabha MP. National profile, very active, heavy media-appearance and
    // rebuttal content — the closest behavioural comparison to the principal.
    ...forPerson("Priyanka Chaturvedi", "COMPETITOR", "Priyanka Chaturvedi", {
        INSTAGRAM: "priyankac19",
        YOUTUBE: "PriyankaChaturvediOfficial",
        X: "priyankac19",
        FACEBOOK: "priyankachaturvedi",
    }),

    // Former Lok Sabha MP. Comparable national profile, long-form written
    // positions — a like-for-like test of whether the principal's format mix is
    // actually working for him. No YouTube entry: see the handle notes above.
    ...forPerson("Varun Gandhi", "COMPETITOR", "Varun Gandhi", {
        INSTAGRAM: "ferozevarungandhi",
        X: "varungandhi80",
        FACEBOOK: "VarunGandhiOfficial",
    }),

    // National politician, contested Lok Sabha. Included for contrast: a
    // different generational and format mix (video-heavy, ground-level), so the
    // gap analysis has something real to find rather than four variations of one
    // posting style.
    ...forPerson("Kanhaiya Kumar", "COMPETITOR", "Kanhaiya Kumar", {
        INSTAGRAM: "kanhaiyakumar",
        YOUTUBE: "KanhaiyaKumar",
        X: "kanhaiyakumar",
        FACEBOOK: "kanhaiyakumar",
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

export const PRINCIPAL_NAME = "Shashi Tharoor";
