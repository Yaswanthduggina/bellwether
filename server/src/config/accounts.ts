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
// The YouTube handles must be verified against the Data API before the live
// adapter is trusted — a channel handle that does not resolve should fail loudly
// at ingestion rather than quietly return an empty result set that reads as "this
// account posted nothing in 90 days".
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
}

const IST = "Asia/Kolkata";

function forPerson(
    personName: string,
    role: AccountRole,
    displayName: string,
    handles: Record<Platform, string>,
): TrackedAccount[] {
    return (Object.keys(handles) as Platform[]).map((platform) => ({
        personName,
        role,
        platform,
        handle: handles[platform],
        displayName,
        timezone: IST,
    }));
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
        YOUTUBE: "PriyankaChaturvedi",
    }),

    // Former Lok Sabha MP. Comparable national profile, long-form written
    // positions — a like-for-like test of whether the principal's format mix is
    // actually working for him.
    ...forPerson("Varun Gandhi", "COMPETITOR", "Varun Gandhi", {
        X: "varungandhi80",
        INSTAGRAM: "varunferozegandhi",
        FACEBOOK: "VarunGandhiOfficial",
        YOUTUBE: "VarunGandhi",
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
