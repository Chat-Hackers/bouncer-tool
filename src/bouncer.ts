import { createHash } from "node:crypto";
import { ApprovedEntry, Country, Decision, ImportEntry, MatrixEvent, Participant, PhoneInfo, Settings } from "../types.js";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const MATRIX_USER_ID = /^@[^\s:]+:[^\s]+$/;

// --- CSV parsing ----------------------------------------------------------

// Minimal RFC-4180-style parser: quoted cells, escaped quotes, BOM, CRLF.
// Rejects anything ambiguous rather than guessing.
export function parseCSV(text: unknown): { headers: string[]; rows: Record<string, string>[] } {
    if (typeof text !== "string") throw Error("Choose a CSV under 1 MB");
    if (text.length > 1000000) throw Error("Choose a CSV under 1 MB");
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let closed = false;
    const push = () => {
        row.push(cell.replace(/\r$/, ""));
        if (row.some(s => s.trim())) rows.push(row);
        row = [];
        cell = "";
        closed = false;
    };
    const csv = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < csv.length; i++) {
        const c = csv[i];
        if (c === '"') {
            if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
            else if (quoted) { quoted = false; closed = true; }
            else if (!cell && !closed) quoted = true;
            else throw Error("Unexpected quote in CSV");
        } else if (c === "," && !quoted) {
            row.push(cell);
            cell = "";
            closed = false;
        } else if (c === "\n" && !quoted) {
            push();
        } else if (closed && c !== "\r") {
            throw Error("Unexpected text after CSV quote");
        } else {
            cell += c;
        }
    }
    if (quoted) throw Error("Unclosed CSV quote");
    if (cell || row.length) push();
    const headers = rows.shift()?.map(s => s.trim().toLowerCase());
    if (!headers?.length || headers.some(s => !s) || new Set(headers).size !== headers.length) throw Error("CSV needs unique, nonempty column names");
    if (rows.length > 5000) throw Error("Maximum 5,000 entries per list");
    return {
        headers,
        rows: rows.map((r, i) => {
            if (r.length !== headers.length) throw Error(`Row ${i + 2}: expected ${headers.length} columns`);
            return Object.fromEntries(headers.map((h, j) => [h, r[j].trim()]));
        }),
    };
}

// --- phone normalisation ----------------------------------------------------

// Conservative formatting normalisation, not a validity or ownership check:
// strip spacing/punctuation, then canonicalise to +countrycode form. Anything
// it cannot express that way is returned with an error for organiser review.
export function normalizePhone(raw: unknown, country: Country = "GB"): PhoneInfo {
    if (raw === undefined || raw === null || !String(raw).trim()) return { number: null, error: "No phone number supplied" };
    let value = String(raw).normalize("NFKC").trim();
    if (country === "GB") value = value.replace(/^(\+44|0044)\s*\(0\)/, "$1");
    if (/[^+\d\s().-]/.test(value)) return { number: null, error: "Unsupported characters or extension; review the number" };
    value = value.replace(/[\s().-]/g, "");
    if (value.startsWith("00")) value = "+" + value.slice(2);
    else if (/^[1-9]\d{10,14}$/.test(value)) value = "+" + value; // international number typed without +
    if (country === "GB" && /^0[1-9]\d{9}$/.test(value)) value = "+44" + value.slice(1);
    if (!/^\+[1-9]\d{7,14}$/.test(value)) return { number: null, error: "Use +countrycode or 00countrycode; UK local numbers need a leading 0" };
    if (value.startsWith("+44") && !/^\+44[1-9]\d{9}$/.test(value)) return { number: null, error: "Expected a standard 10-digit UK national number after +44" };
    return { number: value, error: null };
}

// --- imports ---------------------------------------------------------------

function entryBindsToIssues(entry: Pick<ImportEntry, "phoneError" | "userId">): string[] {
    const issues: string[] = [];
    if (entry.phoneError) issues.push(entry.phoneError);
    if (entry.userId && !MATRIX_USER_ID.test(entry.userId)) issues.push("Invalid Matrix user ID");
    return issues;
}

// One ImportEntry per CSV row. The id binds to the identity source (userId,
// reference or phone) so re-imports of the same person keep a stable identity.
function entryFromRow(kind: "approved" | "participants", r: Record<string, string>, i: number, country: Country): ImportEntry {
    const phone = normalizePhone(r.phone, country);
    const userId = r.matrix_user_id || "";
    return {
        id: digest([kind, userId || r.reference || phone.number || r.phone || "", i]).slice(0, 20),
        name: (r.name || "").slice(0, 300),
        phoneRaw: r.phone || "",
        phone: phone.number,
        phoneError: phone.error,
        userId,
        reference: r.reference || "",
        row: i + 2, // +2: CSV header is row 1, data starts at row 2
        issues: entryBindsToIssues({ phoneError: phone.error, userId }),
        source: "csv",
        membership: "join",
    };
}

// Flag duplicates within a single list: they make number/reference matching ambiguous.
function markDuplicates(entries: ImportEntry[]) {
    const numbers = new Map<string, number>();
    const refs = new Map<string, number>();
    const users = new Map<string, number>();
    for (const e of entries) {
        if (e.phone) numbers.set(e.phone, (numbers.get(e.phone) || 0) + 1);
        if (e.reference) refs.set(e.reference, (refs.get(e.reference) || 0) + 1);
        if (e.userId) users.set(e.userId, (users.get(e.userId) || 0) + 1);
    }
    for (const e of entries) {
        if (e.phone && numbers.get(e.phone)! > 1) e.issues.push("Number appears more than once in this list");
        if (e.reference && refs.get(e.reference)! > 1) e.issues.push("Duplicate reference");
        if (e.userId && users.get(e.userId)! > 1) e.issues.push("Duplicate Matrix user ID");
    }
}

export function prepareImport(kind: "approved" | "participants", csv: string, country: Country = "GB"): ImportEntry[] {
    // A plain list of numbers, one per line, needs no header row.
    if (kind === "approved" && !/[a-z]/i.test(csv.trim().split("\n")[0] || "")) csv = "phone\n" + csv;
    const { headers, rows } = parseCSV(csv);
    if (kind === "approved" && !headers.includes("phone")) throw Error("Approved CSV requires a phone column");
    if (kind === "participants" && !headers.includes("phone") && !headers.includes("matrix_user_id")) throw Error("Participant CSV needs phone or matrix_user_id");
    const entries = rows.map((r, i) => entryFromRow(kind, r, i, country));
    markDuplicates(entries);
    return entries;
}

// --- bridge identity --------------------------------------------------------

// mautrix-whatsapp names ghost users after the WhatsApp number (@whatsapp_447700900101:server).
// Privacy IDs (@whatsapp_lid-…) carry no number and stay unavailable.
export function phoneFromUserId(userId: string, country: Country = "GB") {
    const digits = /^@whatsapp_(\d{7,15}):/.exec(userId || "")?.[1];
    if (!digits) return null;
    const phone = normalizePhone("+" + digits, country);
    return { phoneRaw: "+" + digits, phone: phone.number, phoneError: phone.error, phoneSource: "bridge-id" };
}

export const isBridgedUser = (userId: string) => /^@whatsapp_[^:]+:/.test(userId || "");

// Phone precedence for a membership event: bridge ID → previously observed CSV
// number → unavailable. The display name is never used as a phone source.
function phoneForParticipant(event: MatrixEvent, prior: Participant | undefined, country: Country) {
    const bridged = !prior?.phone ? phoneFromUserId(event.state_key, country) : null;
    if (bridged) {
        return { phoneRaw: bridged.phoneRaw, phone: bridged.phone, phoneError: bridged.phoneError, phoneSource: "bridge-id" };
    }
    if (prior?.phone) {
        return { phoneRaw: prior.phoneRaw, phone: prior.phone, phoneError: prior.phoneError, phoneSource: prior.phoneSource || "csv" };
    }
    return { phoneRaw: prior?.phoneRaw || "", phone: null, phoneError: prior?.phoneError || "WhatsApp is hiding this number", phoneSource: "unavailable" };
}

export function participantFromEvent(event: MatrixEvent, settings: Settings, existing: Participant[] = []): Participant | null {
    if (event?.type !== "m.room.member" || !["join", "leave", "ban"].includes(event.content?.membership)) return null;
    if (event.room_id !== settings.roomId) return null;
    if (typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 500 || typeof event.state_key !== "string" || !MATRIX_USER_ID.test(event.state_key) || event.state_key.length > 300) {
        throw Error("Membership events require event_id and a valid state_key");
    }
    const prior = existing.find(p => p.userId === event.state_key);
    const phone = phoneForParticipant(event, prior, settings.country);
    return {
        id: prior?.id || digest(["matrix", event.room_id, event.state_key]).slice(0, 20),
        name: String(event.content.displayname || prior?.name || "").slice(0, 300),
        userId: event.state_key,
        ...phone,
        reference: "",
        issues: [],
        source: prior?.source || "observed event",
        membership: event.content.membership as Participant["membership"],
        eventId: event.event_id,
        eventTs: Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : 0,
    };
}

// --- comparison report -------------------------------------------------------

// Joins participants against the approved list and the organiser decisions,
// computing status/signature per participant. The signature covers everything a
// decision depends on (identity, phone, list content), so a decision goes stale
// automatically when any of those change.
export function reportOf(participants: Participant[], settings: Settings, approved: ApprovedEntry[], decisions: Record<string, Decision>, now = Date.now()) {
    const approvedVersion = digest(approved.map(a => [a.phone, a.reference, a.name, a.issues]));
    const counts: Record<string, number> = {};
    for (const p of participants) {
        if (p.membership === "join" && p.phone) counts[p.phone] = (counts[p.phone] || 0) + 1;
    }
    return participants.map(p => {
        const matches = p.phone ? approved.filter(a => a.phone === p.phone) : [];
        const signature = digest([settings.roomId, p.userId, p.phoneRaw, p.phone, p.membership, approvedVersion]);
        const base = baseStatus(p, settings, counts, matches);
        const decision = decisions[p.id];
        const current = decision && decision.signature === signature && (!decision.expiresAt || Date.parse(decision.expiresAt) > now);
        const decisionApplies = current && p.membership === "join" && base.status !== "service-account";
        const final = decisionApplies ? applyDecision(decision!) : base;
        return {
            ...p,
            status: final.status,
            reason: final.reason,
            signature,
            approvedMatches: matches.map(a => ({ name: a.name, reference: a.reference, phone: a.phone })),
            decision: current ? decision : null,
            previousDecision: decision && !current ? decision : null,
        };
    });
}

function baseStatus(p: Participant, settings: Settings, counts: Record<string, number>, matches: ApprovedEntry[]): { status: string; reason: string } {
    if (p.membership !== "join") return { status: "left", reason: "Observed leave or ban event; not in the current comparison" };
    if (p.userId && (settings.exemptUserIds || []).includes(p.userId)) return { status: "service-account", reason: "Explicit organiser exclusion for a bot or service account" };
    if (!p.phone) {
        const status = p.phoneRaw ? "invalid-number" : "missing-number";
        return { status, reason: p.phoneError || "Bridge did not expose a phone number; organiser verification needed" };
    }
    if (counts[p.phone!] > 1) return { status: "ambiguous", reason: "Multiple participant entries use this number" };
    if (matches.length > 1 || matches.some(a => a.issues.length)) return { status: "ambiguous", reason: "Approved list has duplicate or conflicting entries for this number" };
    if (matches.length === 1) return { status: "on-list", reason: "Exact normalised-number match to the supplied list" };
    return { status: "needs-review", reason: "No matching number in the supplied list" };
}

function applyDecision(decision: Decision): { status: string; reason: string } {
    if (decision.outcome === "guest-exception") return { status: "exception", reason: "Organiser recorded a guest exception" };
    if (decision.outcome === "changed-number") return { status: "changed-number", reason: "Organiser linked this participant to an approved-list reference" };
    if (decision.outcome === "not-approved") return { status: "not-approved", reason: "Organiser marked this participant as not approved; no removal performed" };
    return { status: "awaiting-check", reason: "Organiser is checking the missing or ambiguous details" };
}
