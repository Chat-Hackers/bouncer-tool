import { describe, expect, it } from "vitest";
import { normalizePhone, parseCSV, prepareImport, reportOf, participantFromEvent } from "./bouncer.js";
import type { ApprovedEntry, Decision, Participant, Settings } from "../types.js";

const settings = (): Settings => ({ roomId: "!room:test", country: "GB", exemptUserIds: [], autoKick: "off", isDemo: false, imports: {} });

const state = () => {
    const approved = prepareImport("approved", "phone,name,reference\n07700900101,A,A\n+447700900102,B,B") as ApprovedEntry[];
    const participants = prepareImport("participants", "phone,name,matrix_user_id\n00447700900101,A,@a:test\n07700900199,Unknown,@unknown:test\n,Opaque,@lid:test").map(entry => ({
        id: entry.id, userId: entry.userId, name: entry.name, phoneRaw: entry.phoneRaw, phone: entry.phone,
        phoneError: entry.phoneError, phoneSource: entry.phone || "unavailable", source: entry.source,
        reference: entry.reference, issues: entry.issues, membership: "join" as const, eventTs: 0,
    })) as Participant[];
    return { settings: settings(), approved, participants, decisions: {} as Record<string, Decision> };
};

const report = (data: ReturnType<typeof state>) => reportOf(data.participants, data.settings, data.approved, data.decisions);

describe("normalizePhone", () => {
    it("normalises UK local/international formats without guessing opaque identities", () => {
        for (const input of ["07700 900101", "+44 (0)7700 900101", "0044-7700-900101", "+44 7700 900101", "44 7700 900101", "447700900101"]) {
            expect(normalizePhone(input).number).toBe("+447700900101");
        }
        expect(normalizePhone("+1 (202) 555-0101", "international").number).toBe("+12025550101");
        for (const input of ["@whatsapp_1234:matrix.test", "07700900101 ext 2", "123", "", "+4407700900101"]) {
            expect(normalizePhone(input).error).toBeTruthy();
        }
        expect(normalizePhone("07700900101", "international").error).toBeTruthy();
    });
});

describe("parseCSV / prepareImport", () => {
    it("handles quoted fields, missing values and duplicate diagnostics", () => {
        expect(parseCSV("\uFEFFphone,name\r\n07700900101,\"A, \"\"Example\"\"\"").rows[0].name).toBe("A, \"Example\"");
        expect(() => parseCSV("phone,name\n123,\"open")).toThrow();
        expect(() => parseCSV("phone,phone\n123,456")).toThrow();
        const entries = prepareImport("approved", "phone,reference\n07700900101,A\n+447700900101,B\n,C");
        expect(entries[0].issues.some(i => i.includes("more than once"))).toBe(true);
        expect(entries[2].issues.length).toBeGreaterThan(0);
    });
});

describe("reportOf", () => {
    it("distinguishes exact match, unmatched, missing and duplicate records", () => {
        const data = state();
        expect(report(data).map(p => p.status)).toEqual(["on-list", "needs-review", "missing-number"]);
        data.approved.push({ ...data.approved[0] });
        expect(report(data)[0].status).toBe("ambiguous");
        data.approved.pop();
        data.participants.push({ ...data.participants[0], id: "duplicate" });
        expect(report(data)[0].status).toBe("ambiguous");
    });

    it("expires or stales changed-number and guest decisions on list or identity change", () => {
        const data = state();
        const row = report(data)[1];
        data.decisions[row.id] = { outcome: "changed-number", linkedReference: "B", signature: row.signature, expiresAt: "2099-01-01T00:00:00Z", at: new Date().toISOString(), note: "" };
        expect(report(data)[1].status).toBe("changed-number");
        data.approved[0].name = "Updated";
        expect(report(data)[1].status).toBe("needs-review");
        expect(report(data)[1].previousDecision).toBeTruthy();
        const current = report(data)[1];
        data.decisions[current.id] = { outcome: "guest-exception", signature: current.signature, expiresAt: "2000-01-01T00:00:00Z", at: new Date().toISOString(), note: "" };
        expect(report(data)[1].status).toBe("needs-review");
    });
});

describe("participantFromEvent", () => {
    it("uses state_key, reads the number from the bridge ID and never from display names", () => {
        const data = state();
        const event = { type: "m.room.member", room_id: "!room:test", sender: "@admin:test", state_key: "@whatsapp_447700900101:test", event_id: "$join", content: { membership: "join", displayname: "+447700900199" } };
        const participant = participantFromEvent(event, data.settings, []);
        expect(participant!.userId).toBe(event.state_key);
        expect(participant!.phone).toBe("+447700900101");
        expect(participant!.phoneSource).toBe("bridge-id");
        const lidEvent = { ...event, state_key: "@whatsapp_lid-123456:test" };
        expect(participantFromEvent(lidEvent, data.settings, [])!.phone).toBeNull();
        const knownEvent = { ...event, state_key: "@a:test" };
        expect(participantFromEvent(knownEvent, data.settings, data.participants)!.phone).toBe("+447700900101");
        const otherRoom = { ...event, room_id: "!other:test" };
        expect(participantFromEvent(otherRoom, data.settings, [])).toBeNull();
    });
});
