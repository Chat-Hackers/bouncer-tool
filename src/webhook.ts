import { appendAudit, ensureSettings, getApproved, getDecisions, getModerationConfig, getParticipants, getSeenByKind, insertIncident, markSeen, pruneSeen, upsertParticipant } from "./duckdb.js";
import { digest, isBridgedUser, participantFromEvent, phoneFromUserId, reportOf } from "./bouncer.js";
import { bridgeParticipant } from "./hub.js";
import { evaluate } from "./moderation.js";
import { HubPayload, Incident, ModerationConfig, Participant, Settings } from "../types.js";

export type WebhookResult = { code: number; data: unknown; kicks?: { userId: string; reason: string }[] };

const ok = (reason: string, kicks: { userId: string; reason: string }[] = []): WebhookResult => ({ code: 200, data: { success: true, response: {}, reason }, kicks });

// Only bridged WhatsApp members are ever removed automatically: organisers' own Matrix
// accounts, bots and anyone explicitly exempted or allowed are left alone.
function shouldAutoKick(settings: Settings, report: { userId: string; membership: string; status: string }[], userId: string, botUserId?: string) {
    const mode = settings.autoKick || "off";
    if (mode === "off" || settings.isDemo || !isBridgedUser(userId) || userId === botUserId) return false;
    const row = report.find(r => r.userId === userId && r.membership === "join");
    if (!row) return false;
    if (["needs-review", "not-approved"].includes(row.status)) return true;
    return mode === "strict" && ["missing-number", "invalid-number"].includes(row.status);
}

async function requestKick(roomId: string, kicks: { userId: string; reason: string }[], userId: string, reason: string, by: string) {
    if (kicks.some(k => k.userId === userId)) return;
    const participants = await getParticipants(roomId);
    const participant = participants.find(p => p.userId === userId);
    const at = new Date().toISOString();
    if (participant) {
        participant.kick = { status: "requested", at, by };
        await upsertParticipant(roomId, participant);
    }
    await appendAudit(roomId, { at, action: "removal-requested", detail: { userId, by } });
    kicks.push({ userId, reason });
}

// Messages from people who joined before the tool was active add them to the list.
async function rememberSender(roomId: string, settings: Settings, event: HubPayload["event"], botUserId?: string) {
    const userId = event.sender ?? "";
    if (!userId || userId === botUserId || !/^@[^\s:]+:[^\s]+$/.test(userId) || userId.length > 300) return false;
    const participants = await getParticipants(roomId);
    if (participants.some(p => p.userId === userId) || participants.length >= 5000) return false;
    const phone = phoneFromUserId(userId, settings.country) || { phoneRaw: "", phone: null, phoneError: "WhatsApp is hiding this number", phoneSource: "unavailable" };
    const participant: Participant = { id: digest(["matrix", event.room_id, userId]).slice(0, 20), name: "", userId, ...phone, reference: "", issues: [], source: "seen in chat", membership: "join", eventTs: 0 };
    await upsertParticipant(roomId, participant);
    return true;
}

// Per sender/room warning cooldown, persisted in the Seen table under a fixed kind prefix.
async function lastWarningTimes(roomId: string): Promise<Record<string, number>> {
    return getSeenByKind(roomId, "warn");
}

async function setLastWarning(roomId: string, cooldownKey: string, at: number) {
    await markSeen(roomId, cooldownKey, "warn", at);
}

async function moderateMessage(roomId: string, settings: Settings, payload: HubPayload): Promise<{ data: unknown; kicks?: { userId: string; reason: string }[] }> {
    const { event, botUserId } = payload;
    const config = await getModerationConfig(roomId);
    const merged: ModerationConfig = { ...config, exemptSenders: [...new Set([...config.exemptSenders, ...settings.exemptUserIds])] };
    let result;
    try {
        result = evaluate(event, merged, botUserId);
    } catch (error) {
        throw Object.assign(error as Error, { status: 400 });
    }
    if (result.ignored) return { data: { success: true, response: {}, reason: result.ignored } };
    const key = digest([roomId, event.event_id]);
    const now = Date.now();
    // Claim-first: a concurrent duplicate delivery of the same event gets "Duplicate event".
    if (!(await markSeen(roomId, key, "message", now))) return { data: { success: true, response: {}, reason: "Duplicate event" } };
    await pruneSeen(roomId, now);
    if (!result.matches.length) return { data: { success: true, response: {}, reason: result.exceptions.length ? "Allowed by rule exception" : "No rule matched" } };
    const cooldownKey = digest([roomId, event.sender]);
    const lastWarnings = await lastWarningTimes(roomId);
    const wantsWarning = result.matches.some(match => match.action === "warn");
    const inCooldown = now - (lastWarnings[cooldownKey] || 0) < config.cooldownSeconds * 1000;
    const live = config.mode === "live" && !settings.isDemo;
    const reply = live && wantsWarning && !inCooldown;
    const remove = live && result.matches.some(match => match.action === "remove") && event.sender !== botUserId;
    const incident: Incident = {
        id: key.slice(0, 32),
        eventId: event.event_id!,
        roomId,
        sender: event.sender!,
        displayName: String(payload.displayName || event.sender).slice(0, 300),
        text: result.text,
        matches: result.matches,
        exceptions: result.exceptions,
        receivedAt: new Date(now).toISOString(),
        status: "pending",
        note: "",
        mode: settings.isDemo ? "demo" : config.mode,
        warning: reply ? "returned-to-hub" : settings.isDemo || config.mode === "demo" ? "demo-only" : wantsWarning && inCooldown ? "cooldown" : "review-only",
        removal: remove ? "requested" : null,
    };
    await insertIncident(roomId, incident);
    if (reply) await setLastWarning(roomId, cooldownKey, now);
    const kicks = remove ? [{ userId: event.sender!, reason: "Removed by the group moderator" }] : [];
    return { data: { success: true, response: reply ? { message: config.warning, context: { autoModerator: true, moduleEvent: true } } : {}, incidentId: incident.id }, kicks };
}

// Membership events: merge the observed join/leave/ban into the roster, and
// auto-queue a removal when the (joined) member is not covered by the approved list.
async function observeMembership(roomId: string, settings: Settings, payload: HubPayload, kicks: { userId: string; reason: string }[]): Promise<WebhookResult> {
    const event = payload.event;
    const participants = await getParticipants(roomId);
    let participant: Participant | null;
    try {
        participant = participantFromEvent(event, settings, participants);
    } catch (error) {
        throw Object.assign(error as Error, { status: 400 });
    }
    if (!participant) return ok("Not a relevant membership event", kicks);

    // Optional trusted Hub enrichment of the phone number, never a display name.
    if (payload.participant !== undefined) {
        const mapped = bridgeParticipant(payload.participant, settings.country, participant.userId);
        Object.assign(participant, { phoneRaw: mapped.phoneRaw, phone: mapped.phone, phoneError: mapped.phoneError, phoneSource: mapped.phoneSource, source: "Hub membership event" });
    }

    const key = digest([event.room_id, event.event_id]);
    const now = Date.now();
    if (!(await markSeen(roomId, key, "member", now))) return ok("Duplicate event", kicks);
    const prior = participants.find(x => x.userId === participant!.userId);
    if (prior?.eventTs && participant.eventTs && participant.eventTs < prior.eventTs) {
        return ok("Older than last observed membership event", kicks);
    }
    if (!prior && participants.length >= 5000) throw Error("Participant limit reached; ask organiser to archive a snapshot");
    await pruneSeen(roomId, now);
    if (prior) await upsertParticipant(roomId, { ...participant, id: prior.id });
    else await upsertParticipant(roomId, participant);

    if (participant.membership === "join") {
        const [approved, decisions] = await Promise.all([getApproved(roomId), getDecisions(roomId)]);
        const rows = reportOf(prior ? participants.map(x => (x.userId === participant!.userId ? { ...participant, id: prior.id } : x)) : participants, settings, approved, decisions);
        if (shouldAutoKick(settings, rows, participant.userId, payload.botUserId)) {
            await requestKick(roomId, kicks, participant.userId, "Not on the approved list for this group", "auto-remove");
            return ok("Not on the approved list; removal requested", kicks);
        }
    }
    return ok("Membership observation recorded", kicks);
}

// Hub webhook entry: passive m.room.message and m.room.member events.
export async function handleWebhook(payload: HubPayload): Promise<WebhookResult> {
    const event = payload.event;
    if (!event || typeof event.room_id !== "string") return ok("No room in event");
    const roomId = event.room_id;
    const settings = await ensureSettings(roomId);
    const kicks: { userId: string; reason: string }[] = [];

    if (event.type === "m.room.message") {
        await rememberSender(roomId, settings, event, payload.botUserId);
        const result = await moderateMessage(roomId, settings, payload);
        kicks.push(...(result.kicks ?? []));
        return { code: 200, data: result.data, kicks };
    }

    return observeMembership(roomId, settings, payload, kicks);
}
