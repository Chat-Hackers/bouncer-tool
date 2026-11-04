import express, { Request, Response } from "express";
import {
    appendAudit, deleteRoomData, ensureSettings, getApproved, getAudit, getDecisions, getIncident,
    getIncidents, getModerationConfig, getParticipants, getSettings, replaceApproved,
    replaceParticipants, setDecision, setModerationConfig, updateIncidentReview, updateSettings, upsertParticipant,
} from "./duckdb.js";
import { AppRequest, ReportResponse, StateResponse, roomIdFrom } from "./requests.js";
import { digest, prepareImport, reportOf } from "./bouncer.js";
import { sendKicks } from "./hub.js";
import { recordKickOutcomes } from "./kickOutcomes.js";
import { defaults, evaluate, validateConfig } from "./moderation.js";
import { Decision, ImportEntry, Incident, Participant, Settings } from "../types.js";

// Hub connection details come from the environment, matching the sibling tools.
export const hubOrigin = () => process.env.dashboard_url || process.env.HUB_URL || "";
export const moduleSecret = () => process.env.bouncer_secret || process.env.MODULE_SECRET || "";

const autoKickModes = ["off", "unlisted", "strict"];

// CSV-imported participants become full roster rows: the original CSV supplies phone/name/userId.
function toParticipant(entry: ImportEntry): Participant {
    return {
        id: entry.id,
        userId: entry.userId,
        name: entry.name,
        phoneRaw: entry.phoneRaw,
        phone: entry.phone,
        phoneError: entry.phoneError,
        phoneSource: entry.phone || "unavailable",
        source: entry.source,
        reference: entry.reference,
        issues: entry.issues,
        membership: "join",
        eventTs: 0,
    };
}

// Shared context for dashboard handlers: everything the comparison report needs.
type RoomContext = {
    roomId: string;
    settings: Settings;
    participants: Participant[];
    approved: Awaited<ReturnType<typeof getApproved>>;
    decisions: Awaited<ReturnType<typeof getDecisions>>;
    rows: ReturnType<typeof reportOf>;
};

async function loadRoom(roomId: string): Promise<RoomContext> {
    const settings = await ensureSettings(roomId);
    const [participants, approved, decisions] = await Promise.all([getParticipants(roomId), getApproved(roomId), getDecisions(roomId)]);
    const rows = reportOf(participants, settings, approved, decisions);
    return { roomId, settings, participants, approved, decisions, rows };
}

async function statePayload(roomId: string): Promise<StateResponse> {
    const settings = await ensureSettings(roomId);
    const [approved, participants, decisions, config, incidents, audit] = await Promise.all([
        getApproved(roomId), getParticipants(roomId), getDecisions(roomId), getModerationConfig(roomId), getIncidents(roomId), getAudit(roomId),
    ]);
    const rows = reportOf(participants, settings, approved, decisions);
    return {
        settings,
        rows,
        moderation: {
            config: { mode: config.mode, warning: config.warning, cooldownSeconds: config.cooldownSeconds, exemptSenders: config.exemptSenders, rules: config.rules },
            incidents: incidents.map(({ roomId: _r, mode: _m, ...rest }) => rest),
        },
        audit,
        isDemo: settings.isDemo,
    };
}

async function getState(req: AppRequest, res: Response) {
    res.json(await statePayload(req.roomId));
}

async function getReport(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const payload: ReportResponse = {
        roomId,
        generatedAt: new Date().toISOString(),
        settings: await ensureSettings(roomId),
        rows: reportOf(await getParticipants(roomId), await ensureSettings(roomId), await getApproved(roomId), await getDecisions(roomId)),
        approved: (await getApproved(roomId)).map(a => ({ ...a, row: 0, phoneError: null })),
        audit: await getAudit(roomId),
    };
    res.json(payload);
}

async function postSettings(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const input = (typeof req.body === "object" && req.body ? req.body : {}) as Record<string, unknown>;
    const settings = await ensureSettings(roomId);
    if (!["GB", "international"].includes(String(input.country))) throw Error("Choose UK or international-only phone formats");
    const autoKick = input.autoKick !== undefined ? String(input.autoKick) : settings.autoKick;
    if (!autoKickModes.includes(autoKick)) throw Error("Choose an auto-remove option");
    if (settings.isDemo && autoKick !== "off") throw Error("Clear the demo before turning on auto-remove");
    const exempt = Array.isArray(input.exemptUserIds) ? input.exemptUserIds : [];
    if (exempt.length > 100 || exempt.some(s => typeof s !== "string" || !/^@[^\s:]+:[^\s]+$/.test(s) || s.length > 300)) throw Error("Use valid Matrix IDs for service-account exclusions");
    settings.country = input.country as Settings["country"];
    settings.autoKick = autoKick as Settings["autoKick"];
    settings.exemptUserIds = exempt as string[];
    await updateSettings(settings);
    await appendAudit(roomId, { at: new Date().toISOString(), action: "settings-updated", detail: { country: settings.country, autoKick: settings.autoKick } });
    res.json({ success: true });
}

async function previewImport(req: AppRequest, res: Response) {
    const input = req.body as { kind?: string; csv?: string };
    if (!["approved", "participants"].includes(String(input.kind))) throw Error("Choose approved or participants");
    const settings = await ensureSettings(req.roomId);
    const entries = prepareImport(input.kind as "approved" | "participants", String(input.csv ?? ""), settings.country);
    const current = input.kind === "approved" ? await getApproved(req.roomId) : await getParticipants(req.roomId);
    const version = digest(current);
    res.json({ entries, version, kind: input.kind, issues: entries.filter(e => e.issues.length).length });
}

async function applyImport(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const input = req.body as { kind?: string; csv?: string; expectedVersion?: string };
    const settings = await ensureSettings(roomId);
    if (settings.isDemo) throw Error("Clear the labelled demo before importing real lists");
    if (!["approved", "participants"].includes(String(input.kind))) throw Error("Choose approved or participants");
    const kind = input.kind as "approved" | "participants";
    const current = kind === "approved" ? await getApproved(roomId) : await getParticipants(roomId);
    const entries = prepareImport(kind, String(input.csv ?? ""), settings.country);
    const version = digest(current);
    if (input.expectedVersion !== version) throw Error("The list changed; preview again before applying");
    if (!entries.length) throw Error("The list is empty; nothing imported");
    if (kind === "participants" && entries.some(e => e.userId && e.issues.includes("Invalid Matrix user ID"))) throw Error("Fix invalid Matrix IDs before applying the participant list");
    if (kind === "participants" && entries.some(e => e.issues.includes("Duplicate Matrix user ID"))) throw Error("Duplicate Matrix IDs cannot identify participants reliably; resolve them first");
    if (kind === "approved") await replaceApproved(roomId, entries);
    else await replaceParticipants(roomId, entries.map(toParticipant));
    settings.imports[kind] = { at: new Date().toISOString(), rows: entries.length, issues: entries.filter(e => e.issues.length).length };
    await updateSettings(settings);
    await appendAudit(roomId, { at: new Date().toISOString(), action: "list-imported", detail: { kind, rows: entries.length } });
    res.json({ success: true });
}

async function reviewParticipant(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const input = req.body as { signature?: string; outcome?: string; note?: string; linkedReference?: string; expiresAt?: string };
    const room = await loadRoom(roomId);
    const row = room.rows.find(p => p.id === req.params.id);
    if (!row) {
        res.status(404).json({ error: "Participant not found" });
        return;
    }
    if (input.signature !== row.signature) throw Error("Participant or approved list changed; refresh before deciding");
    if (row.membership !== "join") throw Error("This participant has left; no current access decision is needed");
    if (!["guest-exception", "changed-number", "awaiting-check", "not-approved", "clear"].includes(String(input.outcome))) throw Error("Choose a supported review outcome");
    if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw Error("Add a note of 1–2,000 characters");
    if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw Error("Expiry must be in the future");
    if (input.outcome === "changed-number") {
        const matches = room.approved.filter(a => a.reference && a.reference === input.linkedReference && !a.issues.length);
        if (matches.length !== 1) throw Error("Select a unique, valid approved-list reference for the changed number");
    }
    const decision: Decision | null = input.outcome === "clear" ? null : {
        outcome: input.outcome as Decision["outcome"],
        note: input.note!.trim(),
        signature: row.signature,
        linkedReference: input.outcome === "changed-number" ? input.linkedReference : undefined,
        expiresAt: input.expiresAt || null,
        at: new Date().toISOString(),
    };
    await setDecision(roomId, row.id, decision);
    await appendAudit(roomId, { at: decision?.at ?? new Date().toISOString(), action: "review", detail: { participantId: row.id, outcome: input.outcome, note: input.note.trim() } });
    res.json({ success: true });
}

async function kickParticipant(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const room = await loadRoom(roomId);
    const row = room.rows.find(p => p.id === req.params.id);
    if (!row) {
        res.status(404).json({ error: "Participant not found" });
        return;
    }
    if (room.settings.isDemo) throw Error("Demo participants are not real; nothing to remove");
    if (row.membership !== "join") throw Error("This person has already left");
    if (!row.userId) throw Error("This entry has no group identity to remove");

    // Queue + send in one step: the Hub answers before Matrix confirms the leave.
    const kicks: { userId: string; reason: string }[] = [{ userId: row.userId, reason: "Removed by an organiser" }];
    const participant = room.participants.find(p => p.userId === row.userId);
    const at = new Date().toISOString();
    if (participant) {
        participant.kick = { status: "requested", at, by: "organiser" };
        await upsertParticipant(roomId, participant);
    }
    await appendAudit(roomId, { at, action: "removal-requested", detail: { userId: row.userId, by: "organiser" } });

    const outcomes = await sendKicks(hubOrigin(), roomId, moduleSecret(), kicks);
    await recordKickOutcomes(roomId, outcomes, "organiser");
    if (outcomes.some(o => !o.ok)) res.status(502).json({ error: "The Hub did not accept the removal: " + outcomes.find(o => !o.ok)!.error });
    else res.json({ success: true });
}

async function postModerationConfig(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const settings = await ensureSettings(roomId);
    const input = req.body as Record<string, unknown>;
    if (settings.isDemo && input.mode === "live") throw Error("Clear the labelled demo before enabling live warnings");
    // Scope always comes from the room in the request, not a browser-supplied room list.
    const config = validateConfig({ ...input, rooms: [roomId] });
    await setModerationConfig(roomId, config);
    await appendAudit(roomId, { at: new Date().toISOString(), action: "moderation-config-updated", detail: { mode: config.mode } });
    res.json({ success: true });
}

async function simulateModeration(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const settings = await ensureSettings(roomId);
    const input = req.body as { text?: string; sender?: string; config?: unknown };
    const config = input.config ? validateConfig({ ...(input.config as object), rooms: [roomId] }) : await getModerationConfig(roomId);
    const result = evaluate(
        { event_id: "$simulation", room_id: roomId, sender: input.sender || "@test:local", type: "m.room.message", content: { msgtype: "m.text", body: input.text } },
        { ...config, exemptSenders: [...new Set([...config.exemptSenders, ...settings.exemptUserIds])] }
    );
    res.json({ ...result, simulation: true, proposedWarning: result.matches?.some(match => match.action === "warn") ? config.warning : null });
}

async function reviewIncident(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const input = req.body as { status?: string; note?: string };
    if (!["confirmed", "false-positive", "dismissed"].includes(String(input.status))) throw Error("Choose a supported moderation decision");
    if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw Error("Add a review note of 1–2,000 characters");
    const incident = await getIncident(roomId, String(req.params.id));
    if (!incident) {
        res.status(404).json({ error: "Moderation incident not found" });
        return;
    }
    const at = new Date().toISOString();
    await updateIncidentReview(roomId, incident.id, input.status as Incident["status"], input.note.trim(), at);
    await appendAudit(roomId, { at, action: "moderation-review", detail: { incidentId: incident.id, status: input.status, note: input.note.trim() } });
    res.json({ success: true });
}

const DEMO_APPROVED_CSV = "phone,name,reference\n" +
    "07700 900101,Example A,DEMO-A\n" +
    "+44 7700 900102,Example B,DEMO-B\n" +
    "00447700900103,Example C,DEMO-C\n" +
    "07700 900104,Example D,DEMO-D\n" +
    "+44 7700 900104,Duplicate D,DEMO-DUP";

const DEMO_PARTICIPANTS_CSV = "phone,name,matrix_user_id\n" +
    "+44 (0)7700 900101,Example A,@demo_a:local\n" +
    "07700 900199,Unmatched example,@demo_unknown:local\n" +
    ",Opaque identity example,@opaque_lid:local\n" +
    "07700 900104,Duplicate-list example,@demo_dup:local\n" +
    "07700 900202,Changed-number example,@demo_changed:local\n" +
    "+44 7700 900103,Example C,@demo_c:local";

// Three illustrative incidents: a direct match, a context false positive and a review warning.
async function loadModerationDemo(roomId: string, settings: Settings) {
    const config = await getModerationConfig(roomId);
    await setModerationConfig(roomId, { ...config, mode: "demo" });
    for (const [id, text] of [["direct", "You are an idiot."], ["context", "Please don’t call people an idiot."], ["review", "Shut up."]] as const) {
        await import("./webhook.js").then(({ handleWebhook }) => handleWebhook({
            displayName: "LOCAL DEMO — not a real participant",
            botUserId: "@bot:local",
            event: { event_id: "$moderation-demo-" + id, room_id: roomId, sender: "@demo_unknown:local", type: "m.room.message", content: { msgtype: "m.text", body: text } },
        }));
    }
    const incidents = await getIncidents(roomId);
    const context = incidents.find(i => i.eventId === "$moderation-demo-context");
    if (context) await updateIncidentReview(roomId, context.id, "false-positive", "Demo: the speaker challenges an insult. Keyword matching misses the context.", new Date().toISOString());
}

async function loadDemo(req: AppRequest, res: Response) {
    const roomId = req.roomId;
    const settings = await ensureSettings(roomId);
    const [approved, participants] = await Promise.all([getApproved(roomId), getParticipants(roomId)]);
    if (approved.length || participants.length) throw Error("Demo data can only be loaded into an empty room");
    settings.isDemo = true;
    settings.country = "GB";
    settings.exemptUserIds = [];
    await updateSettings(settings);
    await replaceApproved(roomId, prepareImport("approved", DEMO_APPROVED_CSV, settings.country));
    await replaceParticipants(roomId, prepareImport("participants", DEMO_PARTICIPANTS_CSV, settings.country).map(toParticipant));
    const changed = (await loadRoom(roomId)).rows.find(p => p.userId === "@demo_changed:local");
    if (changed) {
        await setDecision(roomId, changed.id, {
            outcome: "changed-number",
            note: "Demo organiser checked the new number against reference DEMO-B. Original approved list preserved.",
            linkedReference: "DEMO-B",
            signature: changed.signature,
            expiresAt: null,
            at: new Date().toISOString(),
        });
    }
    const [approvedCount, participantsCount] = await Promise.all([(await getApproved(roomId)).length, (await getParticipants(roomId)).length]);
    settings.imports = { approved: { at: new Date().toISOString(), rows: approvedCount }, participants: { at: new Date().toISOString(), rows: participantsCount } };
    await updateSettings(settings);
    await loadModerationDemo(roomId, settings);
    await appendAudit(roomId, { at: new Date().toISOString(), action: "demo-loaded", detail: { note: "Illustrative entries only; no real group connected" } });
    res.json({ success: true });
}

async function resetDemo(req: AppRequest, res: Response) {
    const settings = await getSettings(req.roomId);
    if (!settings?.isDemo) throw Error("Only a labelled demo can be cleared here");
    await deleteRoomData(req.roomId);
    res.json({ success: true });
}

// --- route table ----------------------------------------------------------

export function registerRoutes(app: express.Express) {
    const wrap = (handler: (req: AppRequest, res: Response) => Promise<unknown>) =>
        async (req: Request, res: Response) => {
            try {
                const roomId = roomIdFrom(req);
                await handler({ ...req, roomId } as AppRequest, res);
            } catch (error) {
                const status = (error as { status?: number }).status ?? 400;
                res.status(status).json({ error: (error as Error).message || "Request failed" });
            }
        };

    app.get("/health", async (_req, res) => res.json({ ok: true }));
    app.get("/api/state", wrap(getState));
    app.get("/api/report", wrap(getReport));
    app.post("/api/settings", wrap(postSettings));
    app.post("/api/import/preview", wrap(previewImport));
    app.post("/api/import/apply", wrap(applyImport));
    app.post("/api/participants/:id/review", wrap(reviewParticipant));
    app.post("/api/participants/:id/kick", wrap(kickParticipant));
    app.post("/api/moderation/config", wrap(postModerationConfig));
    app.post("/api/moderation/simulate", wrap(simulateModeration));
    app.post("/api/moderation/incidents/:id/review", wrap(reviewIncident));
    app.post("/api/demo", wrap(loadDemo));
    app.post("/api/demo/reset", wrap(resetDemo));
}
