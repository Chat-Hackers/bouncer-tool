import { Request } from "express";
import { AuditEntry, ImportEntry, ModerationConfig, ReportRow, Settings } from "../types.js";

// All dashboard routes are room-scoped via ?roomId= (the Hub proxies under /bouncer).
export type AppRequest = Request & { roomId: string };

export type StateResponse = {
    settings: Settings;
    rows: ReportRow[];
    moderation: {
        config: Omit<ModerationConfig, "rooms">;
        incidents: {
            id: string; eventId: string; sender: string; displayName: string; text: string;
            matches: { ruleId: string; phrase: string; action: string }[];
            exceptions: { ruleId: string; phrase: string }[];
            status: string; note: string; warning: string | null; removal: string | null;
            receivedAt: string; reviewedAt?: string;
        }[];
    };
    audit: AuditEntry[];
    isDemo: boolean;
};

export type ReportResponse = {
    roomId: string; generatedAt: string; settings: Settings;
    rows: ReportRow[]; approved: ImportEntry[]; audit: AuditEntry[];
};

export type OperateResult = { code: number; data: unknown; changed?: boolean; kicks?: { userId: string; reason: string }[] };

// Room id validated at the entry boundary; callers can rely on roomId being set.
export function roomIdFrom(req: Request): string {
    const raw = (req.query.roomId ?? "") as string;
    if (typeof raw !== "string" || !raw.startsWith("!") || raw.length > 300) throw Object.assign(Error("Provide the Matrix room ID in ?roomId="), { status: 400 });
    return raw;
}

