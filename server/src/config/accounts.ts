// The tracked set: one principal and three peers, across four platforms.
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
// text-forward; Varun Gandhi posts a third as often. A peer set that all behaved
// identically would make gap analysis (a Module C MUST) vacuous.
//
// ─────────────────────────────────────────────────────────────────────────
// ON THE HANDLES
//
// These are public accounts belonging to public figures acting in a public
// capacity — the only category this product touches.
//
// For platforms served by the SEED adapter, the handle is a *label*: it names who
// the synthetic corpus is modelled on, and the data behind it is generated, not
// fetched. Account.isSynthetic and Post.isSynthetic mark that at row level and the
// UI badges it.
//
// The YouTube handles WERE verified against the Data API, and the check earned
// its keep. Results:
//
//   @ShashiTharoorOfficial       "Dr. Shashi Tharoor Official"    835K subs   LIVE
//   @PriyankaChaturvediOfficial  "Priyanka Chaturvedi Official"    42.7K subs LIVE
//   @KanhaiyaKumar               "Kanhaiya Kumar"                  3.71M subs LIVE
//   @VarunGandhi                 0 subscribers, one 2023 upload    SQUATTER
//
// The first guess for Priyanka Chaturvedi (@PriyankaChaturvedi) did not resolve
// at all. Worse, @VarunGandhi DOES resolve — to a dormant channel with no
// subscribers whose only upload is a 2023 "Happy Independence Day" post. Ingesting
// it would have produced a real-looking row of near-zero engagement attributed to
// a sitting politician: a fabricated finding, arrived at honestly. No alternative
// handle resolves, so Varun Gandhi stays seeded on YouTube and says so.
//
// This is why resolveChannel() throws instead of returning an empty list. An
// unresolved handle rendering as "posted nothing in 90 days" would appear on the
// dashboard as a finding rather than a failure.
//
// NOTE ON THE SUBSCRIBER SPREAD: 42.7K to 3.71M is an 87x range, far wider than
// the follower comparability the peer set was chosen for. It does not distort the
// YouTube numbers, because YouTube engagement rate is normalised by VIEWS, not
// subscribers — which is exactly the case the per-platform denominator exists for.
// ─────────────────────────────────────────────────────────────────────────

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
    /**
     * Force this account to be seeded even where a live adapter exists, and record
     * WHY. Without this, "seeded" would be inferred purely from platform, and an
     * account with no real channel on an otherwise-live platform would silently
     * get ingested from whatever the handle happened to resolve to.
     */
    seedReason?: string;
}

const IST = "Asia/Kolkata";

/** A handle, optionally pinned to the seed adapter with a stated reason. */
type HandleSpec = string | { handle: string; seedReason: string };

function forPerson(
    personName: string,
    role: AccountRole,
    displayName: string,
    handles: Record<Platform, HandleSpec>,
): TrackedAccount[] {
    return (Object.keys(handles) as Platform[]).map((platform) => {
        const spec = handles[platform];
        const resolved = typeof spec === "string" ? { handle: spec, seedReason: undefined } : spec;

        return {
            personName,
            role,
            platform,
            handle: resolved.handle,
            displayName,
            timezone: IST,
            ...(resolved.seedReason ? { seedReason: resolved.seedReason } : {}),
        };
    });
}

export const TRACKED_ACCOUNTS: TrackedAccount[] = [
    // PRINCIPAL — sitting Lok Sabha MP (Thiruvananthapuram). Chosen for genuine
    // multi-platform activity: without volume there is nothing for format or
    // timing analysis to chew on.
    ...forPerson("Shashi Tharoor", "PRINCIPAL", "Shashi Tharoor", {
        X: "ShashiTharoor",
        INSTAGRAM: "shashitharoor",
        FACEBOOK: "ShashiTharoor",
        YOUTUBE: "ShashiTharoorOfficial",
    }),

    // Rajya Sabha MP. National profile, very active, heavy media-appearance and
    // rebuttal content — the closest behavioural comparison to the principal.
    ...forPerson("Priyanka Chaturvedi", "COMPETITOR", "Priyanka Chaturvedi", {
        X: "priyankac19",
        INSTAGRAM: "priyankac19",
        FACEBOOK: "priyankachaturvedi",
        YOUTUBE: "PriyankaChaturvediOfficial",
    }),

    // Former Lok Sabha MP. Comparable national profile, long-form written
    // positions — a like-for-like test of whether the principal's format mix is
    // actually working for him.
    ...forPerson("Varun Gandhi", "COMPETITOR", "Varun Gandhi", {
        X: "varungandhi80",
        INSTAGRAM: "varunferozegandhi",
        FACEBOOK: "VarunGandhiOfficial",
        // @VarunGandhi resolves to a dormant channel with 0 subscribers whose only
        // upload is from 2023 — not the politician, and no alternative handle
        // resolves. Seeded rather than ingesting a stranger's channel as his.
        YOUTUBE: { handle: "VarunGandhi", seedReason: "no verified YouTube channel — @VarunGandhi is a dormant unrelated channel" },
    }),

    // National politician, contested Lok Sabha. Included for contrast: a
    // different generational and format mix (video-heavy, ground-level), so the
    // gap analysis has something real to find rather than four variations of one
    // posting style.
    ...forPerson("Kanhaiya Kumar", "COMPETITOR", "Kanhaiya Kumar", {
        X: "kanhaiyakumar",
        INSTAGRAM: "kanhaiyakumar",
        FACEBOOK: "kanhaiyakumar",
        YOUTUBE: "KanhaiyaKumar",
    }),
];

export const PRINCIPAL_NAME = "Shashi Tharoor";
