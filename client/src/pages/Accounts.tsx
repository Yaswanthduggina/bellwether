// FR1 — track an arbitrary number of accounts, added and removed from the UI.
//
// This page is also where the pipeline is DRIVEN, which it did not used to be.
// Every write below existed as a server route from the start and had no caller
// in the client, so refreshing a corpus meant `npm run ingest` at a prompt and
// assigning themes meant `npm run classify`. A capability reachable only from a
// checkout is not a capability for anyone who did not write the repo, and the
// dashboard is unreadable without both: no ingest means no posts, and no
// classification means recommendations have no themes to cite.
//
// THE ACKNOWLEDGEMENT GATE IS THE INTERESTING PART OF THE FORM. Two of the four
// platforms have no live adapter, so an account added on them cannot be ingested
// and stays EMPTY. The server refuses to create one unless the caller explicitly
// sends `allowNoSource: true`, and this page surfaces that refusal as a checkbox
// the user has to tick, with the consequence spelled out — rather than catching
// the error and silently retrying with the flag set, which would defeat the point.
// Those accounts are exactly why the per-row import exists: a CSV export is the
// only way to give them data.
//
// Deleting cascades to posts. The count is shown in the confirmation because
// "removed" over a silent loss of 263 rows is not an honest confirmation.

import { useRef, useState } from "react";
import {
    api,
    ApiError,
    type Account,
    type ClassifyRun,
    type IngestResult,
    type NewAccount,
} from "../api/client";
import { Badge, Loading, Notice, Panel } from "../components/ui";
import { useAsync } from "../hooks/useAsync";

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"] as const;

const EMPTY: NewAccount = {
    personName: "",
    role: "COMPETITOR",
    platform: "YOUTUBE",
    handle: "",
    timezone: "Asia/Kolkata",
};

/** Posts per classification pass. Small enough that the counter visibly moves. */
const CLASSIFY_CHUNK = 25;

/**
 * Pause between passes, and the backoff when the model rate-limits us.
 *
 * Not cosmetic. Gemini's free tier limits requests per MINUTE, and firing passes
 * back-to-back trips it after about eight of them — which is what happened the
 * first time this ran over a 1,281-post corpus: it stopped at 175 with 1,078
 * untouched. A quota wall and a rate limit look identical in the response and are
 * completely different problems: the first needs a bigger plan, the second needs
 * eight seconds of patience. Treating every 429 as fatal made the button useless
 * on exactly the corpus size it exists for.
 */
const CLASSIFY_GAP_MS = 8_000;
const CLASSIFY_BACKOFF_START_MS = 15_000;
const CLASSIFY_BACKOFF_MAX_MS = 90_000;

/**
 * Consecutive rate-limit backoffs before giving up. At the ceiling above this is
 * roughly ten minutes of retrying — long enough to ride out a per-minute limit,
 * short enough that a genuinely exhausted daily quota is reported rather than
 * retried forever.
 */
const MAX_CONSECUTIVE_BACKOFFS = 8;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A backstop on the classification loop, not a limit on corpus size — at 40 posts
 * a pass this allows 8,000. The loop's real exit is "a pass classified nothing",
 * and this only catches a server that returns success while making no progress.
 */
const MAX_CLASSIFY_PASSES = 200;

function describeIngest(result: IngestResult): string {
    const who = `${result.platform}/@${result.handle}`;
    if (result.status === "failed") return `${who} failed — ${result.error ?? "see the run log"}`;

    const wrote = `${result.rowsFetched ?? 0} posts`;
    const failed = result.rowsFailed ? `, ${result.rowsFailed} rows dropped` : "";
    // "partial" is deliberately not smoothed into "done" — a run that lost rows
    // reading as clean is the whole reason the status exists.
    return `${who} ${result.status === "partial" ? "partial" : "done"} — ${wrote}${failed}`;
}

function AddForm({ accounts, onCreated }: { accounts: Account[]; onCreated: () => void }) {
    const [draft, setDraft] = useState<NewAccount>(EMPTY);
    const [error, setError] = useState<ApiError | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [fetchNow, setFetchNow] = useState(true);

    // Derived from the API's own answer rather than a hardcoded set. This used
    // to be a literal in this file and it was wrong for a release — Instagram
    // went live and the set still said YouTube only. `liveAdapterAvailable`
    // travels on every account row, so the rows the parent already loaded are
    // the source of truth; for a platform with no account yet there is nothing
    // to read, so it is treated as live and the server's own refusal surfaces
    // the truth. Being told by the server beats guessing here.
    const liveByPlatform = new Map<string, boolean>();
    for (const account of accounts) {
        liveByPlatform.set(account.platform, account.liveAdapterAvailable);
    }
    const hasNoSource = liveByPlatform.get(draft.platform) === false;

    const set = <K extends keyof NewAccount>(key: K, value: NewAccount[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setSuccess(null);

        try {
            const result = await api.createAccount({
                ...draft,
                handle: draft.handle.replace(/^@/, ""),
                allowNoSource: hasNoSource ? draft.allowNoSource : undefined,
                // Creating and fetching in one step is the obvious thing to want
                // and the server supports it. It stays OPT-OUT rather than
                // implicit: the request blocks for as long as the fetch takes,
                // and a form that appears to hang is worse than a slow one that
                // said it would be slow.
                ingestNow: !hasNoSource && fetchNow,
            });

            const ingestion = result.ingestion as IngestResult | { status: string; error?: string } | null;
            const fetched =
                ingestion && "handle" in ingestion
                    ? ` ${describeIngest(ingestion)}.`
                    : ingestion
                      ? ` Fetch failed — ${ingestion.error ?? "unknown error"}. The account exists; retry with Fetch.`
                      : "";

            setSuccess(
                `Added ${result.account.personName} on ${result.account.platform}.` +
                    (result.note ? ` ${result.note}` : "") +
                    fetched,
            );
            setDraft(EMPTY);
            onCreated();
        } catch (caught) {
            setError(caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught)));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit}>
            {error && (
                <Notice kind="bad">
                    <strong>{error.code.replace(/_/g, " ").toLowerCase()}.</strong> {error.message}
                </Notice>
            )}
            {success && <Notice kind="info">{success}</Notice>}

            <div className="filters" style={{ marginBottom: 12 }}>
                <div className="field">
                    <label htmlFor="a-person">Person</label>
                    <input
                        id="a-person"
                        required
                        value={draft.personName}
                        placeholder="Narendra Modi"
                        onChange={(e) => set("personName", e.target.value)}
                    />
                </div>

                <div className="field">
                    <label htmlFor="a-handle">Handle</label>
                    <input
                        id="a-handle"
                        required
                        value={draft.handle}
                        placeholder="@narendramodi"
                        onChange={(e) => set("handle", e.target.value)}
                    />
                </div>

                <div className="field">
                    <label htmlFor="a-platform">Platform</label>
                    <select
                        id="a-platform"
                        value={draft.platform}
                        onChange={(e) => set("platform", e.target.value)}
                    >
                        {PLATFORMS.map((platform) => (
                            <option key={platform} value={platform}>
                                {platform}
                                {liveByPlatform.get(platform) === false ? " (no adapter yet)" : " (live)"}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="field">
                    <label htmlFor="a-role">Role</label>
                    <select id="a-role" value={draft.role} onChange={(e) => set("role", e.target.value)}>
                        <option value="COMPETITOR">Competitor</option>
                        <option value="PRINCIPAL">Principal</option>
                    </select>
                </div>

                <div className="field">
                    <label htmlFor="a-tz">Timezone</label>
                    <input
                        id="a-tz"
                        value={draft.timezone ?? ""}
                        placeholder="Asia/Kolkata"
                        onChange={(e) => set("timezone", e.target.value)}
                    />
                </div>

                <button className="button" type="submit" disabled={busy}>
                    {busy ? (fetchNow && !hasNoSource ? "Adding & fetching…" : "Adding…") : "Add account"}
                </button>
            </div>

            {!hasNoSource && (
                <label
                    style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer", marginBottom: 10 }}
                >
                    <input
                        type="checkbox"
                        checked={fetchNow}
                        onChange={(e) => setFetchNow(e.target.checked)}
                        style={{ marginTop: 3 }}
                    />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                        Fetch the last 90 days immediately. Adds tens of seconds to this request — untick to add the
                        account now and fetch it from the table later.
                    </span>
                </label>
            )}

            {hasNoSource && (
                <Notice kind="warn">
                    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            checked={draft.allowNoSource ?? false}
                            onChange={(e) => set("allowNoSource", e.target.checked)}
                            style={{ marginTop: 3 }}
                        />
                        <span>
                            <strong>{draft.platform} has no live adapter yet.</strong> This account{" "}
                            <strong>cannot be fetched</strong> and will stay empty — nothing is generated to fill it.
                            Use <strong>Import</strong> on its row to load a CSV/JSON export, or leave it as a
                            placeholder until the adapter exists. Tick to confirm.
                        </span>
                    </label>
                </Notice>
            )}

            <p className="muted" style={{ fontSize: 12.5 }}>
                A timezone must be an IANA identifier like <code>Asia/Kolkata</code>, not an abbreviation —{" "}
                <code>EST</code> resolves to America/Panama, which does not observe daylight saving, and the heatmap
                would sit an hour off for eight months of the year with nothing reporting a problem.
            </p>
        </form>
    );
}

function Row({
    account,
    onChanged,
    onFlash,
}: {
    account: Account;
    onChanged: () => void;
    onFlash: (message: string, bad?: boolean) => void;
}) {
    const [busy, setBusy] = useState<null | "fetch" | "import" | "remove">(null);
    const fileInput = useRef<HTMLInputElement>(null);

    async function fetchPosts() {
        setBusy("fetch");
        try {
            const { results } = await api.ingest({ accountId: account.id });
            const result = results[0];
            onFlash(result ? describeIngest(result) : `${account.platform}/@${account.handle}: no result returned.`);
            onChanged();
        } catch (caught) {
            onFlash(caught instanceof ApiError ? caught.message : String(caught), true);
        } finally {
            setBusy(null);
        }
    }

    async function importFile(file: File) {
        setBusy("import");
        try {
            // Read in the browser and POST the text: the route takes a raw string
            // rather than multipart, which keeps this to a FileReader and no
            // upload dependency.
            const content = await file.text();
            const { result } = await api.importFile({ accountId: account.id, content, filename: file.name });
            onFlash(`Imported ${file.name} — ${describeIngest(result)}`);
            onChanged();
        } catch (caught) {
            onFlash(caught instanceof ApiError ? caught.message : String(caught), true);
        } finally {
            setBusy(null);
            if (fileInput.current) fileInput.current.value = "";
        }
    }

    async function remove() {
        const confirmed = window.confirm(
            `Remove ${account.personName} on ${account.platform}?\n\n` +
                `${account.postCount} posts and their ingestion history will be deleted with it. This cannot be undone.`,
        );
        if (!confirmed) return;

        setBusy("remove");
        try {
            const result = await api.deleteAccount(account.id);
            onFlash(
                `Removed ${result.deleted.personName} on ${result.deleted.platform} and ${result.deleted.postsRemoved} posts.`,
            );
            onChanged();
        } catch (caught) {
            onFlash(caught instanceof ApiError ? caught.message : String(caught), true);
            setBusy(null);
        }
    }

    const anyBusy = busy !== null;

    return (
        <tr>
            <td>
                <strong>{account.personName}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                    @{account.handle}
                </div>
            </td>
            <td>
                <Badge kind={account.role === "PRINCIPAL" ? "accent" : "neutral"}>{account.role}</Badge>
            </td>
            <td>{account.platform}</td>
            <td>
                {account.isSynthetic ? (
                    <Badge kind="seeded" title="This account's posts are generated, not fetched.">
                        Seeded
                    </Badge>
                ) : account.liveAdapterAvailable ? (
                    <Badge kind="live" title="Fetched from a live API.">
                        Live
                    </Badge>
                ) : (
                    <Badge
                        kind="neutral"
                        title="No adapter for this platform. It can only be filled by importing a CSV/JSON export."
                    >
                        Import only
                    </Badge>
                )}
            </td>
            <td className="n">{account.postCount.toLocaleString()}</td>
            <td className="n">{account.followerCount === null ? "—" : account.followerCount.toLocaleString()}</td>
            <td className="num" style={{ fontSize: 12.5 }}>
                {account.timezone}
            </td>
            <td>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {account.liveAdapterAvailable && (
                        <button
                            className="button"
                            onClick={fetchPosts}
                            disabled={anyBusy}
                            title="Fetch this account's last 90 days. Takes tens of seconds."
                        >
                            {busy === "fetch" ? "Fetching…" : "Fetch"}
                        </button>
                    )}

                    <button
                        className="button"
                        onClick={() => fileInput.current?.click()}
                        disabled={anyBusy}
                        title="Load a CSV or JSON export into this account."
                    >
                        {busy === "import" ? "Importing…" : "Import"}
                    </button>
                    <input
                        ref={fileInput}
                        type="file"
                        accept=".csv,.json,text/csv,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void importFile(file);
                        }}
                    />

                    <button className="button danger" onClick={remove} disabled={anyBusy}>
                        {busy === "remove" ? "Removing…" : "Remove"}
                    </button>
                </div>
            </td>
        </tr>
    );
}

/**
 * FR11 — classification, run from the UI.
 *
 * Chunked rather than fired as one request, and the reason is not cosmetic. A
 * full pass over a fresh corpus takes minutes; a single fetch would sit with no
 * feedback for all of it, and any failure would lose the whole run. Passes of
 * `CLASSIFY_CHUNK` commit as they go — an interrupted run keeps everything it
 * already wrote, because the server's incremental query filters on `theme: null`.
 *
 * The loop exits on LACK OF PROGRESS, never on `unclassified === 0`. Posts the
 * model skips are deliberately left unclassified, so a corpus can sit at a
 * non-zero count forever; looping until it empties would spin and keep spending
 * quota. A pass that classifies nothing means the rest cannot be classified now.
 */
function Classification() {
    const status = useAsync(() => api.classification(), []);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<{ message: string; bad: boolean } | null>(null);
    const cancelled = useRef(false);

    async function run(force: boolean) {
        if (force) {
            const ok = window.confirm(
                "Re-classify every post, including ones already assigned a theme?\n\n" +
                    "This spends model quota proportional to the whole corpus. The incremental run only touches " +
                    "posts with no theme yet.",
            );
            if (!ok) return;
        }

        setRunning(true);
        setOutcome(null);
        cancelled.current = false;

        let classified = 0;
        let passes = 0;
        let backoff = CLASSIFY_BACKOFF_START_MS;
        let consecutiveBackoffs = 0;

        /** Wait, but stay responsive to Stop — one long sleep would ignore it. */
        async function waitInterruptible(ms: number) {
            const step = 500;
            for (let waited = 0; waited < ms; waited += step) {
                if (cancelled.current) return;
                await sleep(step);
            }
        }

        try {
            for (;;) {
                if (cancelled.current) {
                    setOutcome({ message: `Stopped. ${classified} posts classified — the rest kept their state.`, bad: false });
                    break;
                }

                // `force` only on the first pass. Leaving it set would re-select
                // the same posts every time and never terminate.
                const pass: ClassifyRun = await api.classify({
                    limit: CLASSIFY_CHUNK,
                    ...(force && passes === 0 ? { force: true } : {}),
                });
                passes += 1;

                const wrote = pass.report.classified + pass.report.unclassifiable;
                classified += wrote;
                setProgress(
                    `${classified} classified · ${pass.status.unclassified} still unclassified of ${pass.status.total}`,
                );

                if (pass.status.unclassified === 0) {
                    setOutcome({ message: `Done. Every one of ${pass.status.total} posts has a theme.`, bad: false });
                    break;
                }

                // A rate limit and an exhausted plan arrive identically. Retry
                // with growing backoff and let the retry count decide which it
                // was — a per-minute limit clears in seconds, a spent quota never
                // does, and only one of them deserves an error message.
                if (pass.report.stoppedEarly || wrote === 0) {
                    consecutiveBackoffs += 1;

                    if (consecutiveBackoffs > MAX_CONSECUTIVE_BACKOFFS) {
                        const why =
                            pass.report.stoppedEarly?.message ??
                            pass.report.failedBatches[0]?.error ??
                            "the model returned no usable labels for them";
                        setOutcome({
                            message:
                                `Gave up after ${consecutiveBackoffs} retries — ${why} ` +
                                `${classified} posts were classified in this run and are kept; ${pass.status.unclassified} remain. ` +
                                `Classification is incremental, so running it again continues from here rather than restarting.`,
                            bad: true,
                        });
                        break;
                    }

                    setProgress(
                        `Rate-limited — waiting ${Math.round(backoff / 1000)}s, then continuing. ` +
                            `${classified} classified so far, ${pass.status.unclassified} left.`,
                    );
                    await waitInterruptible(backoff);
                    backoff = Math.min(backoff * 2, CLASSIFY_BACKOFF_MAX_MS);
                    continue;
                }

                // A clean pass means the limit receded; recover the pace.
                consecutiveBackoffs = 0;
                backoff = CLASSIFY_BACKOFF_START_MS;

                if (passes >= MAX_CLASSIFY_PASSES) {
                    setOutcome({
                        message: `Stopped after ${passes} passes as a safety limit. ${pass.status.unclassified} posts remain — run again to continue.`,
                        bad: true,
                    });
                    break;
                }

                // Space the passes out rather than sprinting into the next limit.
                await waitInterruptible(CLASSIFY_GAP_MS);
            }
        } catch (caught) {
            const error = caught instanceof ApiError ? caught : new ApiError(0, "UNKNOWN", String(caught));
            setOutcome({
                message: `${error.message}${classified > 0 ? ` (${classified} posts were classified before this and are kept.)` : ""}`,
                bad: true,
            });
        } finally {
            setRunning(false);
            setProgress(null);
            status.reload();
        }
    }

    const current = status.data;

    return (
        <Panel
            title="Themes"
            eyebrow="FR11"
            sub="Recommendations cite themes, so a corpus with no themes produces recommendations with nothing to say. Runs incrementally — only posts without a theme are sent."
        >
            {status.loading && !current ? (
                <Loading lines={2} />
            ) : status.error ? (
                <Notice kind="bad">
                    <strong>Could not read classification status.</strong> {status.error.message}
                </Notice>
            ) : current ? (
                <>
                    {!current.apiKeyConfigured && (
                        <Notice kind="warn">
                            <strong>No Gemini API key is configured.</strong> Classification and recommendations both
                            need one — set <code>GEMINI_API_KEY</code> in <code>server/.env</code> and restart the
                            server. Every analytics panel works without it.
                        </Notice>
                    )}

                    <p style={{ margin: "0 0 12px" }}>
                        <strong>{current.classified.toLocaleString()}</strong> of{" "}
                        <strong>{current.total.toLocaleString()}</strong> posts have a theme
                        {current.unclassified > 0 && (
                            <>
                                {" "}
                                · <strong>{current.unclassified.toLocaleString()}</strong> still unclassified
                            </>
                        )}
                        {current.lowConfidence > 0 && (
                            <>
                                {" "}
                                · <span className="muted">{current.lowConfidence.toLocaleString()} low confidence</span>
                            </>
                        )}
                    </p>

                    {progress && <Notice kind="info">{progress}</Notice>}
                    {outcome && <Notice kind={outcome.bad ? "warn" : "info"}>{outcome.message}</Notice>}

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                            className="button"
                            disabled={running || !current.apiKeyConfigured || current.unclassified === 0}
                            onClick={() => void run(false)}
                        >
                            {running ? "Classifying…" : `Classify ${current.unclassified.toLocaleString()} posts`}
                        </button>

                        <button
                            className="button"
                            disabled={running || !current.apiKeyConfigured || current.total === 0}
                            onClick={() => void run(true)}
                            title="Re-classify everything, including posts that already have a theme."
                        >
                            Re-classify all
                        </button>

                        {running && (
                            <button className="button danger" onClick={() => (cancelled.current = true)}>
                                Stop
                            </button>
                        )}
                    </div>

                    {current.unclassified === 0 && current.total > 0 && !running && (
                        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
                            Nothing left to classify. Fetch more posts and this becomes available again.
                        </p>
                    )}
                </>
            ) : null}
        </Panel>
    );
}

export function Accounts() {
    const accounts = useAsync(() => api.accounts(), []);
    const [flash, setFlash] = useState<{ message: string; bad: boolean } | null>(null);
    const [fetchingAll, setFetchingAll] = useState(false);

    async function fetchAll() {
        setFetchingAll(true);
        setFlash(null);
        try {
            const { results } = await api.ingest({});
            const failed = results.filter((r) => r.status === "failed");
            const written = results.reduce((sum, r) => sum + (r.rowsFetched ?? 0), 0);

            setFlash({
                message:
                    `Refreshed ${results.length} account${results.length === 1 ? "" : "s"} — ${written} posts written.` +
                    (failed.length > 0
                        ? ` ${failed.length} failed: ${failed.map(describeIngest).join("; ")}`
                        : ""),
                bad: failed.length > 0,
            });
            accounts.reload();
        } catch (caught) {
            setFlash({ message: caught instanceof ApiError ? caught.message : String(caught), bad: true });
        } finally {
            setFetchingAll(false);
        }
    }

    const rows = accounts.data?.accounts ?? [];
    const anyLive = rows.some((account) => account.liveAdapterAvailable);

    return (
        <>
            <Panel
                title="Tracked accounts"
                eyebrow="FR1"
                sub="The principal and their peer set, per platform. Add, fetch, import and remove entirely from here — none of it needs a terminal."
                right={
                    anyLive ? (
                        <button
                            className="button"
                            onClick={() => void fetchAll()}
                            disabled={fetchingAll}
                            title="Refresh every account with a live adapter. Sequential, so it takes a while."
                        >
                            {fetchingAll ? "Fetching all…" : "Fetch all"}
                        </button>
                    ) : undefined
                }
            >
                {flash && <Notice kind={flash.bad ? "warn" : "info"}>{flash.message}</Notice>}

                {fetchingAll && (
                    <Notice kind="info">
                        Fetching every account in sequence — deliberately not in parallel, because a burst of requests
                        is the fastest way to get an API key throttled. This can take a few minutes; leave the tab open.
                    </Notice>
                )}

                {accounts.loading && rows.length === 0 ? (
                    <Loading lines={5} />
                ) : accounts.error ? (
                    <Notice kind="bad">
                        <strong>Could not load accounts.</strong> {accounts.error.message}
                    </Notice>
                ) : rows.length === 0 ? (
                    <Notice kind="plain">
                        No accounts tracked yet. Add one below — start with the person you are advising, as{" "}
                        <strong>Principal</strong>, then add their peers as competitors.
                    </Notice>
                ) : (
                    <div className="table-scroll">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Person</th>
                                    <th>Role</th>
                                    <th>Platform</th>
                                    <th>Data</th>
                                    <th className="n">Posts</th>
                                    <th className="n">Followers</th>
                                    <th>Timezone</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((account) => (
                                    <Row
                                        key={account.id}
                                        account={account}
                                        onChanged={() => accounts.reload()}
                                        onFlash={(message, bad) => setFlash({ message, bad: bad ?? false })}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>

            <Panel title="Add an account">
                <AddForm
                    accounts={rows}
                    onCreated={() => {
                        setFlash(null);
                        accounts.reload();
                    }}
                />
            </Panel>

            <Classification />

            <Notice kind="plain">
                <strong>The order that matters.</strong> Add accounts → <strong>Fetch</strong> to pull their posts →{" "}
                <strong>Classify</strong> to assign themes → the dashboard. Analysis and recommendations are computed
                on read, so they need no button: once posts and themes exist, the dashboard reflects them on its next
                load. One thing to know if you ever do open a terminal:{" "}
                <code>npm run ingest -- --roster</code> prunes accounts that are not in <code>config/accounts.ts</code>,
                so accounts added here do not survive it. Plain <code>npm run ingest</code> is the safe one.
            </Notice>
        </>
    );
}
