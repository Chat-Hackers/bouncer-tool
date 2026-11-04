import { digest, normalizePhone } from "./bouncer.js";
import { Country, HubPayload, HubSnapshot, Participant, RosterSync, Settings } from "../types.js";

// Must match the module id the Hub has registered and activated in the room.
export const HUB_TOOL_ID = "bouncer";

export const DEFAULT_HUB_URL = "https://dev.dashboard.chathackers.uk";

const validUserId = (value: unknown) => typeof value === "string" && value.length <= 300 && /^@[^\s:]+:[^\s]+$/.test(value);

// This is trusted Hub enrichment, never a display name or user-editable event.content field.
export function bridgeParticipant(value: HubPayload["participant"], country: Country, expectedUserId?: string) {
    if (!value || !validUserId(value.userId) || (expectedUserId && value.userId !== expectedUserId)) {
        throw Error("Hub participant must identify the membership target");
    }
    const raw = value.phoneSource === "bridge" && typeof value.phoneNumber === "string" ? value.phoneNumber.trim() : "";
    if (raw.length > 100) throw Error("Hub phone number is too long");
    const phone = normalizePhone(raw, country);
    return { userId: value.userId, name: typeof value.name === "string" ? value.name.slice(0, 300) : "", phoneRaw: raw, phone: phone.number, phoneError: phone.error || null, phoneSource: raw ? "bridge" : "unavailable" };
}

export function applyMemberSnapshot(
    rows: { participants: Participant[] },
    settings: Settings,
    payload: unknown
): RosterSync {
    if (settings.isDemo) throw Error("Clear the labelled demo before syncing a real group");
    if (!settings.roomId) throw Error("Save your group room ID before syncing");
    const snap = payload as HubSnapshot;
    if (snap?.roomId !== settings.roomId) throw Error("Hub returned a different group");
    if (snap.complete !== true || !Array.isArray(snap.members) || snap.members.length > 5000) {
        throw Error("Hub must return a complete member list of at most 5,000 entries");
    }
    const at = Date.parse(snap.observedAt);
    if (!Number.isFinite(at) || at > Date.now() + 30000) throw Error("Hub snapshot needs a valid observedAt timestamp");
    if (settings.rosterSync && at <= Date.parse(settings.rosterSync.observedAt)) throw Error("Hub snapshot is older than the last sync; try again");
    const members = snap.members.map(member => bridgeParticipant(member, settings.country));
    const ids = new Set(members.map(member => member.userId));
    if (ids.size !== members.length) throw Error("Hub returned duplicate participant identities");
    const { participants } = rows;
    if (new Set([...participants.map(p => p.userId || p.id), ...ids]).size > 5000) throw Error("Participant limit reached; archive a snapshot first");
    for (const member of members) {
        const prior = participants.find(p => p.userId === member.userId);
        if (prior && prior.eventTs > at) continue; // A join/leave received while fetching wins over this snapshot.
        const mapped = !member.phoneRaw && prior?.phone && prior.source.startsWith("csv")
            ? { ...member, phoneRaw: prior.phoneRaw, phone: prior.phone, phoneError: prior.phoneError, phoneSource: "csv" } : member;
        const participant: Participant = { ...mapped, id: prior?.id || digest(["matrix", snap.roomId, member.userId]).slice(0, 20),
            name: member.name || prior?.name || "", source: mapped.phoneSource === "csv" ? "csv + Hub roster" : "Hub roster",
            reference: prior?.reference || "", issues: [], membership: "join", eventTs: at };
        if (prior) Object.assign(prior, participant); else participants.push(participant);
    }
    for (const prior of participants) {
        if (prior.userId && !ids.has(prior.userId) && !(prior.eventTs > at)) {
            prior.membership = "leave"; prior.eventTs = at;
        }
    }
    const missing = members.filter(member => !member.phone).length;
    const sync: RosterSync = { observedAt: new Date(at).toISOString(), at: new Date().toISOString(), count: members.length, missingNumbers: missing };
    settings.rosterSync = sync;
    return sync;
}

export async function fetchMemberSnapshot(hubOrigin: string, roomId: string, secret: string, fetcher: typeof fetch = fetch): Promise<HubSnapshot> {
    if (!hubOrigin) throw Error("Set the Hub URL (dashboard_url) so the members API can be reached. Your Hub operator must enable the members API described in HUB-MEMBERS.md.");
    const url = new URL(hubOrigin);
    if (url.protocol !== "https:" && url.origin !== "http://localhost:8138" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
        throw Error("The Hub URL must be an HTTPS origin (or a local dev Hub), such as https://dev.dashboard.chathackers.uk");
    }
    url.pathname = "/api/members";
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("toolId", HUB_TOOL_ID);
    let response: Response;
    try { response = await fetcher(url, { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch { throw Error("Could not reach the Hub members API. Ask your Hub operator to check the connection."); }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        throw Error("Hub members API is unavailable or denied access. Ask your Hub operator to enable the API in HUB-MEMBERS.md and activate Bouncer in this room.");
    }
    const reader = response.body?.getReader();
    const chunks: Buffer[] = []; let size = 0;
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1500000) { await reader.cancel(); throw Error("Hub member response is too large"); }
        chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw Error("Hub members API returned invalid JSON"); }
}

// The Hub's POST /api/kick authenticates with the module secret in the query string and answers
// before Matrix confirms; the later leave event confirms removal.
export async function sendKicks(hubOrigin: string, roomId: string, secret: string, kicks: { userId: string; reason: string }[], fetcher: typeof fetch = fetch) {
    const url = new URL("/api/kick", hubOrigin || DEFAULT_HUB_URL);
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("toolId", HUB_TOOL_ID);
    url.searchParams.set("secret", secret);
    return Promise.all(kicks.map(async ({ userId, reason }) => {
        try {
            const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ userId, reason }), redirect: "error", signal: AbortSignal.timeout(10000) });
            const result = await response.json().catch(() => ({})) as { success?: boolean; message?: string };
            return response.ok && result.success === true ? { userId, ok: true } : { userId, ok: false, error: String(result.message || `Hub answered ${response.status}`).slice(0, 300) };
        } catch { return { userId, ok: false, error: "Could not reach the Hub" }; }
    }));
}
