import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "./app.js";
import { registrationFor } from "./registration.js";
import { defaults } from "./moderation.js";
import { startDuckDB } from "./duckdb.js";

const ROOM = "!combined-test:local";

const event = (id: string, text = "You are an idiot.", sender = "@speaker:local", roomId = ROOM) => ({
    botUserId: "@bot:local",
    displayName: "Test speaker",
    event: { type: "m.room.message", room_id: roomId, event_id: id, sender, content: { msgtype: "m.text", body: text } },
});

let app: Express;
let server: ReturnType<Express["listen"]>;
let port = 0;

const call = async (route: string, data?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: data === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { code: res.status, data: await res.json() };
};

beforeAll(async () => {
    fs.mkdirSync("data", { recursive: true });
    // Unique DB path per run: a live DuckDB instance caches by path within the
    // process, so reusing data/test-combined across runs would resurrect old rows.
    const dir = fs.mkdtempSync("data/test-combined-");
    process.env.DUCKDB_DATA_DIR = dir;
    await startDuckDB();
    app = createApp();
    server = app.listen(0);
    port = (server.address() as { port: number }).port;
});

afterAll(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    return promise;
});

describe("registration", () => {
    it("subscribes to both event types and preserves module identity", () => {
        const registration = registrationFor(1234, "test-id");
        expect(registration.id).toBe("bouncer");
        expect(registration.url).toBe("http://localhost:1234");
        expect(registration.event_types).toEqual({ passive: ["m.room.member", "m.room.message"] });
    });
});

describe("combined webhook and dashboard", () => {
    it("runs demo load, live rules, reviews, concurrency and persistence end to end", async () => {
        expect((await call(`/api/demo?roomId=${encodeURIComponent(ROOM)}`, {})).code).toBe(200);
        let snapshot = (await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data;
        expect(snapshot.rows.length).toBe(6);
        expect(snapshot.moderation.incidents.length).toBe(3);
        expect(snapshot.moderation.incidents.filter((i: { status: string }) => i.status === "false-positive").length).toBe(1);

        // A labelled demo cannot enable live mode (rejects before validation).
        expect((await call(`/api/moderation/config?roomId=${encodeURIComponent(ROOM)}`, { ...defaults(), mode: "live" })).code).toBe(400);

        await call(`/api/demo/reset?roomId=${encodeURIComponent(ROOM)}`, {});
        expect((await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data.moderation.incidents.length).toBe(0);

        await call(`/api/settings?roomId=${encodeURIComponent(ROOM)}`, { country: "GB", autoKick: "off", exemptUserIds: ["@service:local"] });
        // Rooms scope always comes from the request room, ignoring browser-supplied lists.
        const scoped = await call(`/api/moderation/config?roomId=${encodeURIComponent(ROOM)}`, { ...defaults(), mode: "live", rooms: [] });
        expect(scoped.code).toBe(200);
        expect((await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data.moderation.config.mode).toBe("live");

        // Simulated exempt sender is ignored and records no incident.
        const simulated = await call(`/api/moderation/simulate?roomId=${encodeURIComponent(ROOM)}`, { text: "idiot", sender: "@service:local" });
        expect(simulated.data.ignored).toBeTruthy();
        expect((await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data.moderation.incidents.length).toBe(0);

        // Duplicate webhook deliveries yield exactly one warning reply.
        const duplicate = await Promise.all([call("/", event("$same")), call("/", event("$same"))]);
        expect(duplicate.every(r => r.code === 200)).toBe(true);
        expect(duplicate.filter(r => r.data.response.message).length).toBe(1);

        // Two fresh events in the same room are within the warning cooldown: no replies.
        const concurrent = await Promise.all([call("/", event("$next")), call("/", event("$third"))]);
        expect(concurrent.filter(r => r.data.response.message).length).toBe(0);
        expect((await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data.moderation.incidents.length).toBe(3);

        // Membership events add the sender as a participant.
        const member = { event: { type: "m.room.member", room_id: ROOM, event_id: "$join", state_key: "@speaker:local", sender: "@admin:local", content: { membership: "join" } } };
        expect((await call("/", member)).code).toBe(200);
        snapshot = (await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data;
        expect(snapshot.rows.some((r: { userId: string }) => r.userId === "@speaker:local")).toBe(true);

        // Reviews require a note and then persist.
        const id = snapshot.moderation.incidents[0].id;
        expect((await call(`/api/moderation/incidents/${id}/review?roomId=${encodeURIComponent(ROOM)}`, { status: "false-positive", note: "" })).code).toBe(400);
        expect((await call(`/api/moderation/incidents/${id}/review?roomId=${encodeURIComponent(ROOM)}`, { status: "false-positive", note: "Reviewed in context; acceptable quotation." })).code).toBe(200);
        const persisted = (await call(`/api/state?roomId=${encodeURIComponent(ROOM)}`)).data;
        expect(persisted.moderation.incidents.find((i: { id: string }) => i.id === id).status).toBe("false-positive");
        expect((await call("/", event("$same"))).data.reason).toBe("Duplicate event");

        const exported = (await call(`/api/report?roomId=${encodeURIComponent(ROOM)}`)).data;
        expect(exported.audit.some((a: { action: string }) => a.action === "moderation-review")).toBe(true);
        expect(exported.moderation).toBeUndefined();
    });
});
