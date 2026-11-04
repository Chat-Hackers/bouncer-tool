// Minimal Matrix event shape actually consumed by this tool; the Hub forwards
// full Matrix events but Bouncer only reads these fields.
export type MatrixEvent = {
    type?: string;
    room_id?: string;
    event_id?: string;
    sender?: string;
    state_key?: string;
    origin_server_ts?: number;
    content?: {
        membership?: string;
        displayname?: string;
        msgtype?: string;
        body?: string;
        context?: { autoModerator?: boolean; moduleEvent?: boolean };
        "m.relates_to"?: { rel_type?: string; "m.in_reply_to"?: unknown; [key: string]: unknown };
        "m.new_content"?: { body?: string; msgtype?: string };
    };
};

// The Hub envelope posted to the tool webhook.
export type HubPayload = {
    event: MatrixEvent;
    botUserId?: string;
    displayName?: string;
    participant?: { userId: string; name?: string; phoneNumber?: string | null; phoneSource?: string };
};

export type Country = "GB" | "international";

export type AutoKickMode = "off" | "unlisted" | "strict";

export type RuleAction = "review" | "warn" | "remove";

export type Rule = {
    id: string;
    phrase: string;
    action: RuleAction;
    enabled: boolean;
    exceptions: string[];
};

export type ModerationConfig = {
    mode: "demo" | "live";
    rooms: string[];
    exemptSenders: string[];
    cooldownSeconds: number;
    warning: string;
    rules: Rule[];
};

export type ModerationMode = "demo" | "live";

export type IncidentStatus = "pending" | "confirmed" | "false-positive" | "dismissed";

export type IncidentMatch = { ruleId: string; phrase: string; action: RuleAction };

export type Incident = {
    id: string;
    eventId: string;
    roomId: string;
    sender: string;
    displayName: string;
    text: string;
    matches: IncidentMatch[];
    exceptions: { ruleId: string; phrase: string }[];
    receivedAt: string;
    status: IncidentStatus;
    note: string;
    mode: ModerationMode;
    warning: string | null;
    removal: string | null;
    reviewedAt?: string;
};

export type PhoneInfo = { number: string | null; error: string | null };

export type ImportEntry = {
    id: string;
    name: string;
    phoneRaw: string;
    phone: string | null;
    phoneError: string | null;
    userId: string;
    reference: string;
    row: number;
    issues: string[];
    source: string;
    membership: "join";
};

export type ApprovedEntry = {
    id: string;
    name: string;
    phoneRaw: string;
    phone: string | null;
    userId: string;
    reference: string;
    issues: string[];
    source: string;
    membership: "join";
};

export type ParticipantSource = "csv" | "csv + Hub roster" | "Hub roster" | "Hub membership event" | "observed event" | "seen in chat" | string;

export type Participant = {
    id: string;
    userId: string;
    name: string;
    phoneRaw: string;
    phone: string | null;
    phoneError: string | null;
    phoneSource: string;
    source: ParticipantSource;
    reference: string;
    issues: string[];
    membership: "join" | "leave" | "ban";
    eventId?: string;
    eventTs: number;
    kick?: { status: "requested" | "sent" | "failed"; at: string; by: string; error?: string };
};

export type DecisionOutcome = "guest-exception" | "changed-number" | "awaiting-check" | "not-approved";

export type Decision = {
    outcome: DecisionOutcome;
    note: string;
    signature: string;
    linkedReference?: string;
    expiresAt: string | null;
    at: string;
};

export type Settings = {
    roomId: string;
    country: Country;
    exemptUserIds: string[];
    autoKick: AutoKickMode;
    isDemo: boolean;
    imports: { approved?: ImportInfo; participants?: ImportInfo };
    rosterSync?: RosterSync;
};

export type ImportInfo = { at: string; rows: number; issues?: number };

export type RosterSync = { observedAt: string; at: string; count: number; missingNumbers: number };

export type ReportRow = Participant & {
    status: string;
    reason: string;
    signature: string;
    approvedMatches: { name: string; reference: string; phone: string | null }[];
    decision: Decision | null;
    previousDecision: Decision | null;
};

export type AuditEntry = { at: string; action: string; [key: string]: unknown };

export type HubSnapshotMember = {
    userId: string;
    name?: string;
    phoneNumber?: string | null;
    phoneSource?: string;
};

export type HubSnapshot = {
    roomId: string;
    complete: boolean;
    observedAt: string;
    members: HubSnapshotMember[];
};
