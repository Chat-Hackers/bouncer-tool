import "./App.css";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
    applyImport, clearDemo, getReport, getState, kickParticipant, loadDemo, previewImport,
    reviewIncident, reviewParticipant, saveModerationConfig, saveSettings,
    type AutoKickMode, type Country, type Incident, type ModerationMode, type ReportRow,
    type Rule, type StateResponse,
} from "./requests";

const statusText: Record<string, [string, string]> = {
    "on-list": ["Approved", "ok"],
    "exception": ["Allowed", "ok"],
    "changed-number": ["Allowed", "ok"],
    "needs-review": ["Not on list", "bad"],
    "not-approved": ["Not approved", "bad"],
    "missing-number": ["Number hidden", "warn"],
    "invalid-number": ["Bad number", "warn"],
    "ambiguous": ["Duplicate number", "warn"],
    "awaiting-check": ["Checking", "warn"],
    "service-account": ["Ignored", "muted"],
    "left": ["Left", "muted"],
};
const attention = (r: ReportRow) => r.membership === "join" && ["needs-review", "not-approved", "missing-number", "invalid-number", "ambiguous", "awaiting-check"].includes(r.status);
const filters: [string, string, (r: ReportRow) => boolean][] = [
    ["attention", "Needs action", attention],
    ["approved", "Approved", r => ["on-list", "exception", "changed-number"].includes(r.status)],
    ["all", "In group", r => r.membership === "join"],
    ["left", "Left", r => r.membership !== "join"],
];
const incidentLabels: Record<string, string> = { pending: "New", "false-positive": "Fine", confirmed: "Concern", dismissed: "Dismissed" };
const ruleActions: [string, string][] = [["review", "Flag"], ["warn", "Flag + warn"], ["remove", "Flag + remove"]];

function download(data: unknown, name: string) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

const emptyState: StateResponse = {
    settings: { roomId: "", country: "GB", exemptUserIds: [], autoKick: "off", isDemo: false, imports: {} },
    rows: [],
    moderation: { config: { mode: "demo", cooldownSeconds: 300, exemptSenders: [], warning: "", rules: [] }, incidents: [] },
    isDemo: false,
};

export default function App() {
    const [searchParams] = useSearchParams();
    const roomId = searchParams.get("roomId") ?? "";
    const [notice, setNotice] = useState("");
    const [snapshot, setSnapshot] = useState<StateResponse | null>(null);
    const [filter, setFilter] = useState("attention");
    const [showReviewed, setShowReviewed] = useState(false);

    const [roomDraft, setRoomDraft] = useState("");
    const [country, setCountry] = useState<Country>("GB");
    const [autoKick, setAutoKick] = useState<AutoKickMode>("off");
    const [exempt, setExempt] = useState("");
    const [approvedCsv, setApprovedCsv] = useState("");
    const [approvedSummary, setApprovedSummary] = useState("");

    const [modMode, setModMode] = useState<ModerationMode>("demo");
    const [modWarning, setModWarning] = useState("");
    const [modRules, setModRules] = useState<Rule[]>([]);
    const [exceptionDrafts, setExceptionDrafts] = useState<Record<string, string>>({});
    const cooldownRef = useRef(300);

    const noticeOf = (e: unknown) => setNotice(e instanceof Error ? e.message : String(e));
    const run = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => (...args: A): Promise<T | void> => fn(...args).catch(noticeOf);

    const fillForms = (snap: StateResponse) => {
        const s = snap.settings;
        setRoomDraft(s.roomId);
        setCountry(s.country);
        setAutoKick(s.autoKick || "off");
        setExempt(s.exemptUserIds.join("\n"));
        const c = snap.moderation.config;
        cooldownRef.current = c.cooldownSeconds;
        setModMode(c.mode);
        setModWarning(c.warning);
        setModRules(c.rules);
        setExceptionDrafts({});
        const i = s.imports.approved;
        setApprovedSummary(i ? `${i.rows} numbers saved${i.issues ? `, ${i.issues} with problems` : ""}.` : "No list saved yet.");
    };

    const refresh = useCallback(async (forms = false) => {
        const snap = await getState(roomId);
        setSnapshot(snap);
        if (forms) fillForms(snap);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomId]);

    useEffect(() => {
        setNotice("");
        setSnapshot(null);
        if (!roomId) return;
        refresh(true).catch(noticeOf);
        const interval = setInterval(() => {
            if (!document.hidden) refresh().catch(noticeOf);
        }, 10000);
        return () => clearInterval(interval);
    }, [roomId, refresh]);

    if (!roomId) {
        return (
            <>
                <header>
                    <a className="brand" href="./"><span className="logo">✓</span><span>AUTO BOUNCER<small>Chat Hackers</small></span></a>
                </header>
                <main>
                    <div className="card"><div className="empty">Open this dashboard from the Chat Hackers hub so the room is set in the address.</div></div>
                </main>
            </>
        );
    }

    const settings = snapshot?.settings ?? emptyState.settings;
    const isDemo = snapshot?.isDemo ?? false;
    const approvedRows = settings.imports.approved?.rows ?? 0;
    const participantsRows = settings.imports.participants?.rows ?? 0;
    const incidents = snapshot?.moderation.incidents ?? [];
    const rows = snapshot?.rows ?? [];
    const live = snapshot?.moderation.config.mode === "live" && !isDemo;

    const doSaveSettings = async (changes: Partial<{ country: Country; autoKick: AutoKickMode; exemptUserIds: string[] }>) => {
        await saveSettings(roomId, { country: settings.country, autoKick: settings.autoKick || "off", exemptUserIds: settings.exemptUserIds, ...changes });
        await refresh(true);
    };

    const onRoomSubmit = run(async (e: FormEvent) => {
        e.preventDefault();
        if (!roomDraft.trim()) throw new Error("Paste the group room ID first.");
        await doSaveSettings({ exemptUserIds: settings.exemptUserIds });
        setRoomDraft(roomDraft.trim());
        setNotice(`Room ${roomDraft.trim()} is now managed by this dashboard.`);
    });

    const onSettingsSubmit = run(async (e: FormEvent) => {
        e.preventDefault();
        await doSaveSettings({ country, autoKick, exemptUserIds: exempt.split("\n").map(s => s.trim()).filter(Boolean) });
        setNotice("Bouncer settings saved.");
    });

    const onApprovedFile = run(async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (file.size > 1000000) throw new Error("Choose a CSV under 1 MB");
        setApprovedCsv(await file.text());
    });

    const onApprovedSave = run(async () => {
        const csv = approvedCsv;
        const preview = await previewImport(roomId, "approved", csv);
        if (approvedRows && !confirm(`Replace the current list of ${approvedRows} with these ${preview.entries.length} numbers?`)) return;
        await applyImport(roomId, "approved", csv, preview.version);
        setApprovedCsv("");
        await refresh(true);
        const problems = preview.entries.filter(e => e.issues.length);
        setApprovedSummary(`${preview.entries.length} numbers saved.` + (problems.length
            ? ` Problems: ` + problems.slice(0, 5).map(e => `row ${e.row} (${e.issues[0]})`).join("; ") + (problems.length > 5 ? "…" : "")
            : ""));
        setNotice("Approved list saved.");
    });

    const onModerationSubmit = run(async (e: FormEvent) => {
        e.preventDefault();
        await saveModerationConfig(roomId, {
            mode: modMode,
            warning: modWarning,
            cooldownSeconds: cooldownRef.current,
            exemptSenders: snapshot?.moderation.config.exemptSenders ?? [],
            rules: modRules.filter(r => r.phrase.trim()).map(r => ({ ...r, exceptions: (exceptionDrafts[r.id] ?? r.exceptions.join("; ")).split(";").map(s => s.trim()).filter(Boolean) })),
        });
        await refresh(true);
        setNotice("Rules saved.");
    });

    const review = run(async (r: ReportRow, outcome: string, note: string): Promise<void> => {
        await reviewParticipant(roomId, r.id, { signature: r.signature, outcome, note });
        await refresh();
        setNotice(outcome === "clear" ? "Allowance removed." : `${r.name || r.userId} allowed.`);
    });

    const kick = run(async (r: ReportRow): Promise<boolean> => {
        if (!confirm(`Remove ${r.name || r.userId} from the group?`)) return false;
        await kickParticipant(roomId, r.id);
        await refresh();
        setNotice(`Removal requested for ${r.name || r.userId}. If they stay, the Hub bot may need a higher power level than them.`);
        return true;
    });

    const decide = run(async (i: Incident, status: Incident["status"]): Promise<void> => {
        await reviewIncident(roomId, i.id, { status, note: status === "false-positive" ? "Marked fine by organiser" : "Marked as a concern by organiser" });
        await refresh();
    });

    const shown = rows.filter(r => filters.find(f => f[0] === filter)?.[2](r)).sort((a, b) => (b.eventTs || 0) - (a.eventTs || 0));
    const shownFlags = incidents.filter(i => showReviewed || i.status === "pending");

    return (
        <>
            <header>
                <a className="brand" href="./"><span className="logo">✓</span><span>AUTO BOUNCER<small>Chat Hackers</small></span></a>
                <div className="pills">
                    {isDemo && <span className="tag warn">Demo data</span>}
                    <span className={`tag ${autoKick === "off" ? "muted" : "bad"}`}>{autoKick === "off" ? "Auto-remove off" : "Auto-remove on"}</span>
                    <span className={`tag ${live ? "bad" : "muted"}`}>{live ? "Rules live" : "Rules: flag only"}</span>
                </div>
            </header>
            <main>
                <p id="notice" role="status" aria-live="polite">{notice}</p>

                <form className={`card room${settings.roomId ? "" : " needs"}`} onSubmit={onRoomSubmit}>
                    <label>Group room ID <span>the roomId= part of the Chat Hackers dashboard link. Used by both the bouncer and message rules</span>
                        <input value={roomDraft} placeholder="!abc123:matrix.org" onChange={e => setRoomDraft(e.target.value)} />
                    </label>
                    <button>Save room</button>
                </form>

                <section className="card">
                    <div className="head">
                        <h2>People</h2>
                        <div className="filters">
                            {filters.map(([key, label, test]) => (
                                <button key={key} className={`chip${key === filter ? " active" : ""}`} onClick={() => setFilter(key)}>
                                    {label} {rows.filter(test).length}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Person</th><th>Number</th><th>Status</th><th></th></tr></thead>
                            <tbody>
                                {shown.map(r => {
                                    const left = r.membership !== "join";
                                    const [label, tone] = left && r.kick?.status === "sent" ? ["Removed", "muted"] : statusText[r.status] || [r.status, "muted"];
                                    return (
                                        <tr key={r.id}>
                                            <td><strong>{r.name || r.userId || "Unknown"}</strong><small>{r.name ? r.userId : ""}</small></td>
                                            <td>{r.phone || r.phoneRaw || "—"}</td>
                                            <td>
                                                <span className={`tag ${tone}`}>{label}</span>
                                                {r.kick && !left && <small className={r.kick.status === "failed" ? "error" : ""}>{r.kick.status === "failed" ? `Removal failed: ${r.kick.error}` : "Removal requested. Waiting for them to leave"}</small>}
                                            </td>
                                            <td className="actions">
                                                {!left && r.status !== "service-account" && (
                                                    <>
                                                        {["exception", "changed-number"].includes(r.status)
                                                            ? <button className="secondary" onClick={run(() => review(r, "clear", "Allowance removed by organiser"))}>Undo allow</button>
                                                            : r.status !== "on-list" && <button className="secondary" onClick={run(() => review(r, "guest-exception", "Allowed by organiser"))}>Allow</button>}
                                                        {r.userId && !isDemo && <button className="danger" onClick={run(() => kick(r))}>Remove</button>}
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {!shown.length && <p className="empty">Nobody here yet. People appear as they join or post.</p>}
                </section>

                <section className="card">
                    <div className="head">
                        <h2>Flagged messages</h2>
                        <label className="check"><input type="checkbox" checked={showReviewed} onChange={e => setShowReviewed(e.target.checked)} />Show reviewed</label>
                    </div>
                    {shownFlags.length ? shownFlags.map(i => {
                        const person = rows.find(r => r.userId === i.sender);
                        const why = [`Matched: ${i.matches.map(m => m.phrase).join(", ")}`];
                        if (i.warning === "returned-to-hub") why.push("warning sent");
                        if (i.removal) why.push("removal sent");
                        return (
                            <article key={i.id} className="flag">
                                <div className="meta">
                                    <strong>{i.displayName || i.sender}</strong>
                                    <small>{new Date(i.receivedAt).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" })}</small>
                                    <span className={`tag ${i.status === "pending" ? "warn" : "muted"}`}>{incidentLabels[i.status] || i.status}</span>
                                </div>
                                <p className="message">{i.text}</p>
                                <small>{why.join(" · ")}</small>
                                <div className="actions">
                                    <button className="secondary" onClick={run(() => decide(i, "false-positive"))}>Fine</button>
                                    <button className="secondary" onClick={run(() => decide(i, "confirmed"))}>Concern</button>
                                    {person && person.membership === "join" && !isDemo && (
                                        <button className="danger" onClick={run(async () => {
                                            if (await kick(person)) await decide(i, "confirmed");
                                        })}>Remove sender</button>
                                    )}
                                </div>
                            </article>
                        );
                    }) : <p className="empty">{incidents.length ? 'Nothing waiting. Tick "Show reviewed" to see past flags.' : "No flagged messages yet."}</p>}
                </section>

                <details className="card">
                    <summary><h2>Bouncer settings</h2></summary>
                    <form onSubmit={onSettingsSubmit}>
                        <div className="grid">
                            <label>Auto-remove new joiners
                                <select value={autoKick} onChange={e => setAutoKick(e.target.value as AutoKickMode)}>
                                    <option value="off">Off</option>
                                    <option value="unlisted">Remove if their number isn't on the list</option>
                                    <option value="strict">Remove anyone not approved or allowed, including hidden numbers</option>
                                </select>
                            </label>
                            <label>Number format
                                <select value={country} onChange={e => setCountry(e.target.value as Country)}>
                                    <option value="GB">UK + international</option>
                                    <option value="international">International only</option>
                                </select>
                            </label>
                            <label>Never remove or flag <span>Matrix IDs, one per line</span>
                                <textarea rows={2} value={exempt} placeholder="@whatsapp_447700900000:matrix.org" onChange={e => setExempt(e.target.value)} />
                            </label>
                        </div>
                        <button>Save settings</button>
                    </form>
                    <h3>Approved numbers</h3>
                    <p className="hint">One number per line, or a CSV with a <code>phone</code> column. Saving replaces the list. WhatsApp hides many people's numbers; use <strong>Allow</strong> under People for them.</p>
                    <div className="grid">
                        <textarea rows={5} value={approvedCsv} placeholder={"07700 900101\n44 7700 900102"} onChange={e => setApprovedCsv(e.target.value)} />
                        <div>
                            <input type="file" accept=".csv,text/csv" onChange={e => onApprovedFile(e.target.files)} />
                            <p className="hint">{approvedSummary}</p>
                        </div>
                    </div>
                    <button onClick={onApprovedSave}>Save list</button>
                </details>

                <details className="card" open={modRules.length > 0}>
                    <summary><h2>Message rules</h2></summary>
                    <form onSubmit={onModerationSubmit}>
                        <div className="grid">
                            <label>Mode
                                <select value={modMode} onChange={e => setModMode(e.target.value as ModerationMode)}>
                                    <option value="demo">Flag only. No warnings or removals</option>
                                    <option value="live">Live. Send warnings and removals</option>
                                </select>
                            </label>
                            <label>Warning message<textarea rows={2} value={modWarning} onChange={e => setModWarning(e.target.value)} /></label>
                        </div>
                        {modRules.map(rule => (
                            <div key={rule.id} className="rule">
                                <input type="checkbox" title="Rule on" aria-label="Rule on" checked={rule.enabled}
                                    onChange={e => setModRules(rs => rs.map(x => x.id === rule.id ? { ...x, enabled: e.target.checked } : x))} />
                                <input maxLength={200} placeholder="word or phrase" aria-label="Word or phrase" value={rule.phrase}
                                    onChange={e => setModRules(rs => rs.map(x => x.id === rule.id ? { ...x, phrase: e.target.value } : x))} />
                                <select aria-label="Action" value={rule.action}
                                    onChange={e => setModRules(rs => rs.map(x => x.id === rule.id ? { ...x, action: e.target.value as Rule["action"] } : x))}>
                                    {ruleActions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                                </select>
                                <input className="exceptions" placeholder="except…" aria-label="Exceptions"
                                    value={exceptionDrafts[rule.id] ?? rule.exceptions.join("; ")}
                                    onChange={e => setExceptionDrafts(d => ({ ...d, [rule.id]: e.target.value }))} />
                                <button className="link" type="button" onClick={() => setModRules(rs => rs.filter(x => x.id !== rule.id))}>×</button>
                            </div>
                        ))}
                        <p className="hint">Whole words or phrases, any case. "Except" lists phrases that cancel the match, separated by ;</p>
                        <button className="secondary" type="button" onClick={() => setModRules(rs => [...rs, { id: crypto.randomUUID(), phrase: "", action: "review", enabled: true, exceptions: [] }])}>+ Add word</button>{" "}
                        <button type="submit">Save rules</button>
                    </form>
                </details>

                <footer>
                    <button className="link" onClick={run(async () => {
                        download(await getReport(roomId), "bouncer-report.json");
                        setNotice("Report downloaded. It contains full phone numbers.");
                    })}>Export report</button>
                    {!isDemo && !approvedRows && !participantsRows && <button className="link" onClick={run(async () => {
                        await loadDemo(roomId);
                        await refresh(true);
                        setNotice("Demo loaded. Nothing here is real.");
                    })}>Load demo</button>}
                    {isDemo && <button className="link" onClick={run(async () => {
                        await clearDemo(roomId);
                        await refresh(true);
                        setNotice("Demo cleared.");
                    })}>Clear demo</button>}
                </footer>
            </main>
        </>
    );
}
