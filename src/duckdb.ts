import { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement } from "@duckdb/node-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditEntry, ApprovedEntry, Decision, Incident, ModerationConfig, Participant, Settings } from "../types.js";
import { warningText } from "./moderation.js";

let connection: DuckDBConnection;
let instance: DuckDBInstance;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bouncerDuckDBFileName = "bouncer_duckdb.db";

// DuckDB transactions are per connection, so overlapping writes sharing one
// connection would interleave. Run writes one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => { });
    return next;
}

type Bind = string | number | boolean | null;

// Binds positional parameters, mapping JS types onto DuckDB's typed bind methods.
function bindValues(prepared: DuckDBPreparedStatement, binds: Bind[]) {
    binds.forEach((bind, i) => {
        if (typeof bind === "number") prepared.bindBigInt(i + 1, BigInt(bind));
        else if (typeof bind === "boolean") prepared.bindBoolean(i + 1, bind);
        else if (bind === null) prepared.bindNull(i + 1);
        else prepared.bindVarchar(i + 1, bind);
    });
}

async function rows(sql: string, ...binds: Bind[]): Promise<Record<string, unknown>[]> {
    const prepared = await connection.prepare(sql);
    bindValues(prepared, binds);
    const result = await prepared.run();
    return await result.getRowObjects() as Record<string, unknown>[];
}

async function run(sql: string, ...binds: Bind[]) {
    await withWriteLock(async () => {
        const prepared = await connection.prepare(sql);
        bindValues(prepared, binds);
        await prepared.run();
    });
}

// Insert+delete inside one transaction (used by the list-replace endpoints).
async function replaceRows(table: string, roomId: string, list: { binds: Bind[] }[]) {
    await withWriteLock(async () => {
        await connection.run("BEGIN TRANSACTION;");
        try {
            const del = await connection.prepare(`DELETE FROM ${table} WHERE room_id = $1;`);
            del.bindVarchar(1, roomId);
            await del.run();
            for (const entry of list) {
                const prepared = await connection.prepare(`INSERT INTO ${table} VALUES (${entry.binds.map((_, i) => `$${i + 1}`).join(", ")});`);
                bindValues(prepared, entry.binds);
                await prepared.run();
            }
            await connection.run("COMMIT;");
        } catch (error) {
            await connection.run("ROLLBACK;");
            throw error;
        }
    });
}

// JSON round-trip helpers: lists/objects are stored as serialized VARCHAR columns.
const parse = <T,>(value: unknown, fallback: T): T => {
    if (value === null || value === undefined || value === "") return fallback;
    try { return JSON.parse(String(value)) as T; } catch { return fallback; }
};

const stringify = (value: unknown): string => JSON.stringify(value);

// --- table schema ---------------------------------------------------------

const TABLES: { name: string; creationCommand: string }[] = [
    {
        name: "Settings",
        creationCommand: "CREATE TABLE Settings (room_id VARCHAR NOT NULL, country VARCHAR NOT NULL, exempt_user_ids VARCHAR NOT NULL, auto_kick VARCHAR NOT NULL, is_demo BOOLEAN NOT NULL, imports VARCHAR NOT NULL, roster_sync VARCHAR)",
    },
    {
        name: "Approved",
        creationCommand: "CREATE TABLE Approved (room_id VARCHAR NOT NULL, entry_id VARCHAR NOT NULL, name VARCHAR NOT NULL, phone_raw VARCHAR NOT NULL, phone VARCHAR, user_id VARCHAR NOT NULL, reference VARCHAR NOT NULL, issues VARCHAR NOT NULL, source VARCHAR NOT NULL, membership VARCHAR NOT NULL)",
    },
    {
        name: "Participants",
        creationCommand: "CREATE TABLE Participants (room_id VARCHAR NOT NULL, participant_id VARCHAR NOT NULL, user_id VARCHAR NOT NULL, name VARCHAR NOT NULL, phone_raw VARCHAR NOT NULL, phone VARCHAR, phone_error VARCHAR, phone_source VARCHAR NOT NULL, source VARCHAR NOT NULL, reference VARCHAR NOT NULL, issues VARCHAR NOT NULL, membership VARCHAR NOT NULL, event_id VARCHAR, event_ts BIGINT NOT NULL, kick VARCHAR)",
    },
    {
        name: "Decisions",
        creationCommand: "CREATE TABLE Decisions (room_id VARCHAR NOT NULL, participant_id VARCHAR NOT NULL, outcome VARCHAR NOT NULL, note VARCHAR NOT NULL, signature VARCHAR NOT NULL, linked_reference VARCHAR, expires_at VARCHAR, decided_at VARCHAR NOT NULL)",
    },
    {
        name: "ModerationConfig",
        creationCommand: "CREATE TABLE ModerationConfig (room_id VARCHAR NOT NULL, mode VARCHAR NOT NULL, warning VARCHAR NOT NULL, cooldown_seconds BIGINT NOT NULL, exempt_senders VARCHAR NOT NULL, rules VARCHAR NOT NULL)",
    },
    {
        name: "Incidents",
        creationCommand: "CREATE TABLE Incidents (room_id VARCHAR NOT NULL, incident_id VARCHAR NOT NULL, event_id VARCHAR NOT NULL, sender VARCHAR NOT NULL, display_name VARCHAR NOT NULL, text VARCHAR NOT NULL, matches VARCHAR NOT NULL, exceptions VARCHAR NOT NULL, status VARCHAR NOT NULL, note VARCHAR NOT NULL, mode VARCHAR NOT NULL, warning VARCHAR, removal VARCHAR, received_at VARCHAR NOT NULL, reviewed_at VARCHAR)",
    },
    {
        name: "Seen",
        creationCommand: "CREATE TABLE Seen (room_id VARCHAR NOT NULL, digest VARCHAR NOT NULL, kind VARCHAR NOT NULL, seen_at BIGINT NOT NULL)",
    },
    {
        name: "Audit",
        creationCommand: "CREATE TABLE Audit (room_id VARCHAR NOT NULL, audited_at VARCHAR NOT NULL, action VARCHAR NOT NULL, detail VARCHAR)",
    },
];

export async function startDuckDB() {
    const dataDir = process.env.DUCKDB_DATA_DIR ?? path.resolve(__dirname, "../..");
    const dbPath = path.join(dataDir, bouncerDuckDBFileName);
    instance = await DuckDBInstance.create(dbPath);
    connection = await instance.connect();
    const existingTablesRows = await connection.run("SHOW TABLES;");
    const existingTables = await existingTablesRows.getRowObjects();
    for (const table of TABLES) {
        const tableExists = existingTables.some(existingTable => existingTable.name === table.name);
        if (tableExists) console.log(`${table.name} already exists`);
        else {
            await connection.run(table.creationCommand);
            console.log(`${table.name} created`);
        }
    }
}

// --- Settings -------------------------------------------------------------

export async function getSettings(roomId: string): Promise<Settings | null> {
    const found = await rows("SELECT * FROM Settings WHERE room_id = $1;", roomId);
    if (!found.length) return null;
    const s = found[0];
    return {
        roomId: s.room_id as string,
        country: s.country as Settings["country"],
        exemptUserIds: parse<string[]>(s.exempt_user_ids, []),
        autoKick: s.auto_kick as Settings["autoKick"],
        isDemo: s.is_demo === true,
        imports: parse<Settings["imports"]>(s.imports, {}),
        rosterSync: parse<Settings["rosterSync"]>(s.roster_sync, undefined),
    };
}

export async function ensureSettings(roomId: string): Promise<Settings> {
    const existing = await getSettings(roomId);
    if (existing) return existing;
    const fresh: Settings = { roomId, country: "GB", exemptUserIds: [], autoKick: "off", isDemo: false, imports: {} };
    await run(
        "INSERT INTO Settings VALUES ($1, $2, $3, $4, $5, $6, $7);",
        roomId, fresh.country, stringify(fresh.exemptUserIds), fresh.autoKick, false, stringify(fresh.imports), null,
    );
    return fresh;
}

export async function updateSettings(settings: Settings) {
    await run(
        "UPDATE Settings SET country = $2, exempt_user_ids = $3, auto_kick = $4, is_demo = $5, imports = $6, roster_sync = $7 WHERE room_id = $1;",
        settings.roomId, settings.country, stringify(settings.exemptUserIds), settings.autoKick, settings.isDemo, stringify(settings.imports), settings.rosterSync ? stringify(settings.rosterSync) : null,
    );
}

// --- Approved list --------------------------------------------------------

function approvedFromRow(row: Record<string, unknown>): ApprovedEntry {
    return {
        id: row.entry_id as string,
        name: row.name as string,
        phoneRaw: row.phone_raw as string,
        phone: (row.phone as string) || null,
        userId: row.user_id as string,
        reference: row.reference as string,
        issues: parse<string[]>(row.issues, []),
        source: row.source as string,
        membership: row.membership as ApprovedEntry["membership"],
    };
}

function approvedBinds(roomId: string, a: ApprovedEntry): Bind[] {
    return [roomId, a.id, a.name, a.phoneRaw, a.phone, a.userId, a.reference, stringify(a.issues), a.source, a.membership];
}

export async function getApproved(roomId: string): Promise<ApprovedEntry[]> {
    const found = await rows("SELECT * FROM Approved WHERE room_id = $1;", roomId);
    return found.map(approvedFromRow);
}

export async function replaceApproved(roomId: string, list: ApprovedEntry[]) {
    await replaceRows("Approved", roomId, list.map(a => ({ binds: approvedBinds(roomId, a) })));
}

// --- Participants ---------------------------------------------------------

function participantFromRow(row: Record<string, unknown>): Participant {
    return {
        id: row.participant_id as string,
        userId: row.user_id as string,
        name: row.name as string,
        phoneRaw: row.phone_raw as string,
        phone: (row.phone as string) || null,
        phoneError: (row.phone_error as string) || null,
        phoneSource: row.phone_source as string,
        source: row.source as string,
        reference: row.reference as string,
        issues: parse<string[]>(row.issues, []),
        membership: row.membership as Participant["membership"],
        eventId: (row.event_id as string) || undefined,
        eventTs: Number(row.event_ts ?? 0),
        kick: parse<Participant["kick"]>(row.kick, undefined),
    };
}

function participantBinds(roomId: string, p: Participant): Bind[] {
    return [roomId, p.id, p.userId, p.name, p.phoneRaw, p.phone, p.phoneError, p.phoneSource, p.source, p.reference, stringify(p.issues), p.membership, p.eventId ?? null, p.eventTs ?? 0, p.kick ? stringify(p.kick) : null];
}

export async function getParticipants(roomId: string): Promise<Participant[]> {
    const found = await rows("SELECT * FROM Participants WHERE room_id = $1;", roomId);
    return found.map(participantFromRow);
}

export async function upsertParticipant(roomId: string, participant: Participant) {
    await run("DELETE FROM Participants WHERE room_id = $1 AND participant_id = $2;", roomId, participant.id);
    await run(`INSERT INTO Participants VALUES (${participantBinds(roomId, participant).map((_, i) => `$${i + 1}`).join(", ")});`, ...participantBinds(roomId, participant));
}

export async function replaceParticipants(roomId: string, list: Participant[]) {
    await replaceRows("Participants", roomId, list.map(p => ({ binds: participantBinds(roomId, p) })));
}

// --- Decisions ------------------------------------------------------------

function decisionFromRow(row: Record<string, unknown>): Decision {
    return {
        outcome: row.outcome as Decision["outcome"],
        note: row.note as string,
        signature: row.signature as string,
        linkedReference: (row.linked_reference as string) || undefined,
        expiresAt: (row.expires_at as string) || null,
        at: row.decided_at as string,
    };
}

function decisionBinds(roomId: string, participantId: string, d: Decision): Bind[] {
    return [roomId, participantId, d.outcome, d.note, d.signature, d.linkedReference ?? null, d.expiresAt ?? null, d.at];
}

export async function getDecisions(roomId: string): Promise<Record<string, Decision>> {
    const found = await rows("SELECT * FROM Decisions WHERE room_id = $1;", roomId);
    const out: Record<string, Decision> = {};
    for (const row of found) out[row.participant_id as string] = decisionFromRow(row);
    return out;
}

export async function setDecision(roomId: string, participantId: string, decision: Decision | null) {
    await withWriteLock(async () => {
        const del = await connection.prepare("DELETE FROM Decisions WHERE room_id = $1 AND participant_id = $2;");
        del.bindVarchar(1, roomId);
        del.bindVarchar(2, participantId);
        await del.run();
        if (!decision) return;
        const binds = decisionBinds(roomId, participantId, decision);
        const ins = await connection.prepare(`INSERT INTO Decisions VALUES (${binds.map((_, i) => `$${i + 1}`).join(", ")});`);
        bindValues(ins, binds);
        await ins.run();
    });
}

// --- ModerationConfig -----------------------------------------------------

function defaultsConfig(roomId: string): ModerationConfig {
    return {
        mode: "live",
        rooms: [roomId],
        exemptSenders: [],
        cooldownSeconds: 300,
        warning: warningText,
        rules: [
            { id: "personal-insult", phrase: "idiot", action: "warn", enabled: true, exceptions: [] },
            { id: "aggressive-language", phrase: "shut up", action: "review", enabled: true, exceptions: [] },
        ],
    };
}

export async function getModerationConfig(roomId: string): Promise<ModerationConfig> {
    const found = await rows("SELECT * FROM ModerationConfig WHERE room_id = $1;", roomId);
    if (!found.length) return defaultsConfig(roomId);
    const c = found[0];
    return {
        mode: c.mode as ModerationConfig["mode"],
        rooms: [roomId],
        exemptSenders: parse<string[]>(c.exempt_senders, []),
        cooldownSeconds: Number(c.cooldown_seconds ?? 300),
        warning: c.warning as string,
        rules: parse<ModerationConfig["rules"]>(c.rules, []),
    };
}

export async function setModerationConfig(roomId: string, config: ModerationConfig) {
    await run("DELETE FROM ModerationConfig WHERE room_id = $1;", roomId);
    await run(
        "INSERT INTO ModerationConfig VALUES ($1, $2, $3, $4, $5, $6);",
        roomId, config.mode, config.warning, config.cooldownSeconds, stringify(config.exemptSenders), stringify(config.rules),
    );
}

// --- Incidents ------------------------------------------------------------

function incidentFromRow(row: Record<string, unknown>): Incident {
    return {
        id: row.incident_id as string,
        eventId: row.event_id as string,
        roomId: row.room_id as string,
        sender: row.sender as string,
        displayName: row.display_name as string,
        text: row.text as string,
        matches: parse<Incident["matches"]>(row.matches, []),
        exceptions: parse<Incident["exceptions"]>(row.exceptions, []),
        status: row.status as Incident["status"],
        note: row.note as string,
        mode: row.mode as Incident["mode"],
        warning: (row.warning as string) || null,
        removal: (row.removal as string) || null,
        receivedAt: row.received_at as string,
        reviewedAt: (row.reviewed_at as string) || undefined,
    };
}

function incidentBinds(roomId: string, i: Incident): Bind[] {
    return [roomId, i.id, i.eventId, i.sender, i.displayName, i.text, stringify(i.matches), stringify(i.exceptions), i.status, i.note, i.mode, i.warning, i.removal, i.receivedAt, i.reviewedAt ?? null];
}

export async function getIncidents(roomId: string): Promise<Incident[]> {
    const found = await rows("SELECT * FROM Incidents WHERE room_id = $1 ORDER BY received_at DESC;", roomId);
    return found.map(incidentFromRow);
}

export async function getIncident(roomId: string, incidentId: string): Promise<Incident | null> {
    const found = await rows("SELECT * FROM Incidents WHERE room_id = $1 AND incident_id = $2;", roomId, incidentId);
    return found.length ? incidentFromRow(found[0]) : null;
}

export async function insertIncident(roomId: string, incident: Incident) {
    const binds = incidentBinds(roomId, incident);
    await run(`INSERT INTO Incidents VALUES (${binds.map((_, i) => `$${i + 1}`).join(", ")});`, ...binds);
}

export async function updateIncidentReview(roomId: string, incidentId: string, status: Incident["status"], note: string, reviewedAt: string) {
    await run(
        "UPDATE Incidents SET status = $3, note = $4, reviewed_at = $5 WHERE room_id = $1 AND incident_id = $2;",
        roomId, incidentId, status, note, reviewedAt,
    );
}

// --- Seen (dedup + cooldown claims) ----------------------------------------

// Claims a digest atomically: returns false when the row already exists, so
// concurrent duplicate webhook deliveries cannot both pass the duplicate check.
// Runs inside the write lock; must not call run() (which would re-enter the lock).
export async function markSeen(roomId: string, digestValue: string, kind: string, at: number) {
    let claimed = true;
    await withWriteLock(async () => {
        const found = await rows("SELECT digest FROM Seen WHERE room_id = $1 AND digest = $2 AND kind = $3;", roomId, digestValue, kind);
        if (found.length) { claimed = false; return; }
        const insert = await connection.prepare("INSERT INTO Seen VALUES ($1, $2, $3, $4);");
        insert.bindVarchar(1, roomId);
        insert.bindVarchar(2, digestValue);
        insert.bindVarchar(3, kind);
        insert.bindBigInt(4, BigInt(at));
        await insert.run();
    });
    return claimed;
}

export async function pruneSeen(roomId: string, now: number) {
    // Keep a week of history: enough to absorb Hub delivery retries, small enough to prune fast.
    await run("DELETE FROM Seen WHERE room_id = $1 AND seen_at < $2;", roomId, now - 7 * 86400000);
}

export async function getSeenByKind(roomId: string, kind: string): Promise<Record<string, number>> {
    const found = await rows("SELECT digest, seen_at FROM Seen WHERE room_id = $1 AND kind = $2;", roomId, kind);
    const out: Record<string, number> = {};
    for (const row of found) out[row.digest as string] = Number(row.seen_at ?? 0);
    return out;
}

// --- Audit ----------------------------------------------------------------

export async function appendAudit(roomId: string, entry: AuditEntry) {
    await run(
        "INSERT INTO Audit VALUES ($1, $2, $3, $4);",
        roomId, entry.at, entry.action, entry.detail ? stringify(entry.detail) : null,
    );
}

export async function getAudit(roomId: string): Promise<AuditEntry[]> {
    const found = await rows("SELECT * FROM Audit WHERE room_id = $1 ORDER BY audited_at DESC;", roomId);
    return found.map(a => {
        const entry: AuditEntry = { at: a.audited_at as string, action: a.action as string };
        if (a.detail) {
            try { return { ...entry, ...(JSON.parse(String(a.detail)) as object) }; } catch { return entry; }
        }
        return entry;
    });
}

// --- whole-room delete (demo reset) -----------------------------------------

export async function deleteRoomData(roomId: string) {
    for (const table of TABLES) {
        await run(`DELETE FROM ${table.name} WHERE room_id = $1;`, roomId);
    }
}
