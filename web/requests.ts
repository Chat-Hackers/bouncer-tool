const { origin, pathname } = window.location;
// The Hub proxies this tool under its module id, so every dashboard call is
// same-origin and scoped to one room via ?roomId=.
const BASE_URL = origin + (pathname === "/" ? "" : pathname.replace(/\/+$/, ""));

export type Country = "GB" | "international";
export type AutoKickMode = "off" | "unlisted" | "strict";
export type RuleAction = "review" | "warn" | "remove";
export type ModerationMode = "demo" | "live";
export type IncidentStatus = "pending" | "confirmed" | "false-positive" | "dismissed";

export type Rule = { id: string; phrase: string; action: RuleAction; enabled: boolean; exceptions: string[] };

export type ModerationConfig = {
    mode: ModerationMode;
    cooldownSeconds: number;
    exemptSenders: string[];
    warning: string;
    rules: Rule[];
};

export type IncidentMatch = { ruleId: string; phrase: string; action: string };

export type Incident = {
    id: string;
    sender: string;
    displayName: string;
    text: string;
    matches: IncidentMatch[];
    exceptions: { ruleId: string; phrase: string }[];
    status: IncidentStatus;
    note: string;
    warning: string | null;
    removal: string | null;
    receivedAt: string;
};

export type KickInfo = { status: "requested" | "sent" | "failed"; at: string; by: string; error?: string };

export type ImportInfo = { at: string; rows: number; issues?: number };

export type Settings = {
    roomId: string;
    country: Country;
    exemptUserIds: string[];
    autoKick: AutoKickMode;
    isDemo: boolean;
    imports: { approved?: ImportInfo; participants?: ImportInfo };
    rosterSync?: { observedAt: string; at: string; count: number; missingNumbers: number };
};

export type ReportRow = {
    id: string;
    userId: string;
    name: string;
    phone: string | null;
    phoneRaw: string;
    phoneError: string | null;
    status: string;
    reason: string;
    membership: "join" | "leave" | "ban";
    eventTs: number;
    signature: string;
    kick?: KickInfo;
};

export type StateResponse = {
    settings: Settings;
    rows: ReportRow[];
    moderation: { config: ModerationConfig; incidents: Incident[] };
    isDemo: boolean;
};

export type ImportPreview = {
    entries: { row: number; issues: string[] }[];
    version: string;
    kind: string;
    issues: number;
};

async function parse<T>(res: Response): Promise<T> {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
}

function url(roomId: string, path: string): string {
    return `${BASE_URL}${path}?roomId=${encodeURIComponent(roomId)}`;
}

async function post<T>(roomId: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(url(roomId, path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return parse<T>(res);
}

export async function getState(roomId: string): Promise<StateResponse> {
    const res = await fetch(url(roomId, "/api/state"));
    return parse<StateResponse>(res);
}

export async function getReport(roomId: string): Promise<unknown> {
    const res = await fetch(url(roomId, "/api/report"));
    return parse<unknown>(res);
}

export function saveSettings(roomId: string, input: { country: Country; exemptUserIds: string[]; autoKick: AutoKickMode }): Promise<{ success: boolean }> {
    return post(roomId, "/api/settings", input);
}

export function previewImport(roomId: string, kind: "approved" | "participants", csv: string): Promise<ImportPreview> {
    return post(roomId, "/api/import/preview", { kind, csv });
}

export function applyImport(roomId: string, kind: "approved" | "participants", csv: string, expectedVersion: string): Promise<{ success: boolean }> {
    return post(roomId, "/api/import/apply", { kind, csv, expectedVersion });
}

export function reviewParticipant(roomId: string, id: string, input: { signature: string; outcome: string; note: string }): Promise<{ success: boolean }> {
    return post(roomId, `/api/participants/${encodeURIComponent(id)}/review`, input);
}

export function kickParticipant(roomId: string, id: string): Promise<{ success: boolean }> {
    return post(roomId, `/api/participants/${encodeURIComponent(id)}/kick`, {});
}

export function saveModerationConfig(roomId: string, input: { mode: ModerationMode; warning: string; cooldownSeconds: number; exemptSenders: string[]; rules: Rule[] }): Promise<{ success: boolean }> {
    return post(roomId, "/api/moderation/config", input);
}

export function reviewIncident(roomId: string, id: string, input: { status: IncidentStatus; note: string }): Promise<{ success: boolean }> {
    return post(roomId, `/api/moderation/incidents/${encodeURIComponent(id)}/review`, input);
}

export function loadDemo(roomId: string): Promise<{ success: boolean }> {
    return post(roomId, "/api/demo", {});
}

export function clearDemo(roomId: string): Promise<{ success: boolean }> {
    return post(roomId, "/api/demo/reset", {});
}
