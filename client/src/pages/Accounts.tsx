// FR1 — track an arbitrary number of accounts, added and removed from the UI.
//
// THE ACKNOWLEDGEMENT GATE IS THE INTERESTING PART. Two of the four platforms
// have no live adapter, so an account added on them cannot be ingested and stays
// EMPTY. The server refuses to create one unless the caller explicitly sends
// `allowNoSource: true`, and this page surfaces that refusal as a checkbox the
// user has to tick, with the consequence spelled out — rather than catching the
// error and silently retrying with the flag set, which would defeat the point.
//
// It used to warn that such an account would be SEEDED. Since the synthetic
// corpus was removed the warning is different but the reason for it is the same:
// an account that quietly collects nothing looks, on a dashboard, exactly like a
// person who does not post.
//
// Deleting cascades to posts. The count is shown in the confirmation because
// "removed" over a silent loss of 263 rows is not an honest confirmation.

import { useState } from "react";
import { api, ApiError, type Account, type NewAccount } from "../api/client";
import { Badge, Loading, Notice, Panel } from "../components/ui";
import { useAsync } from "../hooks/useAsync";

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "X", "YOUTUBE"] as const;

/** Mirrors the server's adapter registry. YouTube is the one live source. */
// Mirrors the LIVE entries in the server's adapter registry. Duplicated state,
// and it is the reason this list was wrong for a release: Instagram went live and
// this set still said YouTube only. The honest fix is to read platform status
// from the API — every account response already carries `liveAdapterAvailable` —
// and it is worth doing the next time this file is touched for a real feature.
const LIVE_PLATFORMS = new Set(["YOUTUBE", "INSTAGRAM"]);

const EMPTY: NewAccount = {
    personName: "",
    role: "COMPETITOR",
    platform: "YOUTUBE",
    handle: "",
    timezone: "Asia/Kolkata",
};

function AddForm({ onCreated }: { onCreated: () => void }) {
    const [draft, setDraft] = useState<NewAccount>(EMPTY);
    const [error, setError] = useState<ApiError | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const hasNoSource = !LIVE_PLATFORMS.has(draft.platform);

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
            });
            setSuccess(
                `Added ${result.account.personName} on ${result.account.platform}.` +
                    (result.note ? ` ${result.note}` : ""),
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
                        placeholder="Shashi Tharoor"
                        onChange={(e) => set("personName", e.target.value)}
                    />
                </div>

                <div className="field">
                    <label htmlFor="a-handle">Handle</label>
                    <input
                        id="a-handle"
                        required
                        value={draft.handle}
                        placeholder="@ShashiTharoor"
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
                                {LIVE_PLATFORMS.has(platform) ? " (live)" : " (no adapter yet)"}
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
                    {busy ? "Adding…" : "Add account"}
                </button>
            </div>

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
                            <strong>cannot be ingested</strong> and will stay empty — nothing is generated to fill it.
                            Import a CSV/JSON export to give it data, or leave it as a placeholder until the adapter
                            exists. Tick to confirm.
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

function Row({ account, onDeleted }: { account: Account; onDeleted: (message: string) => void }) {
    const [busy, setBusy] = useState(false);

    async function remove() {
        const confirmed = window.confirm(
            `Remove ${account.personName} on ${account.platform}?\n\n` +
                `${account.postCount} posts and their ingestion history will be deleted with it. This cannot be undone.`,
        );
        if (!confirmed) return;

        setBusy(true);
        try {
            const result = await api.deleteAccount(account.id);
            onDeleted(
                `Removed ${result.deleted.personName} on ${result.deleted.platform} and ${result.deleted.postsRemoved} posts.`,
            );
        } catch (caught) {
            window.alert(caught instanceof ApiError ? caught.message : String(caught));
            setBusy(false);
        }
    }

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
                ) : (
                    <Badge kind="live" title="Fetched from a live API.">
                        Live
                    </Badge>
                )}
            </td>
            <td className="n">{account.postCount.toLocaleString()}</td>
            <td className="n">{account.followerCount === null ? "—" : account.followerCount.toLocaleString()}</td>
            <td className="num" style={{ fontSize: 12.5 }}>
                {account.timezone}
            </td>
            <td>
                <button className="button danger" onClick={remove} disabled={busy}>
                    {busy ? "Removing…" : "Remove"}
                </button>
            </td>
        </tr>
    );
}

export function Accounts() {
    const accounts = useAsync(() => api.accounts(), []);
    const [flash, setFlash] = useState<string | null>(null);

    return (
        <>
            <Panel
                title="Tracked accounts"
                eyebrow="FR1"
                sub="The principal and their peer set, per platform. The same person can be live on one platform and seeded on another — provenance is tracked per account, never per platform."
            >
                {flash && <Notice kind="info">{flash}</Notice>}

                {accounts.loading ? (
                    <Loading lines={5} />
                ) : accounts.error ? (
                    <Notice kind="bad">
                        <strong>Could not load accounts.</strong> {accounts.error.message}
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
                                {(accounts.data?.accounts ?? []).map((account) => (
                                    <Row
                                        key={account.id}
                                        account={account}
                                        onDeleted={(message) => {
                                            setFlash(message);
                                            accounts.reload();
                                        }}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>

            <Panel title="Add an account">
                <AddForm
                    onCreated={() => {
                        setFlash(null);
                        accounts.reload();
                    }}
                />
            </Panel>

            <Notice kind="plain">
                <strong>One thing that will surprise you when demoing this.</strong>{" "}
                <code>npm run ingest -- --roster</code> prunes accounts that are not in <code>config/accounts.ts</code>,
                so an account added here does not survive it. Use plain <code>npm run ingest</code> to refresh it instead.
            </Notice>
        </>
    );
}
