import express from "express";
import path from "node:path";
import { handleWebhook } from "./webhook.js";
import { hubOrigin, moduleSecret, registerRoutes } from "./dashboard.js";
import { sendKicks } from "./hub.js";
import { recordKickOutcomes } from "./kickOutcomes.js";
import type { HubPayload } from "../types.js";

// Express wiring shared by the server entrypoint and the test suite.
export function createApp(webDist?: string): express.Express {
    const app = express();
    app.use(express.json({ limit: "1.5mb" }));

    // Hub webhook: passive events arrive here. The response `response` field is consumed
    // by the Hub's handleToolResponse (string | {message, context} | array).
    app.post("/", async (req, res) => {
        try {
            const payload = req.body as HubPayload;
            const result = await handleWebhook(payload);
            const kicks = result.kicks ?? [];
            if (kicks.length) {
                const roomId = payload.event?.room_id ?? "";
                const outcomes = await sendKicks(hubOrigin(), roomId, moduleSecret(), kicks);
                await recordKickOutcomes(roomId, outcomes, kicks[0]?.reason ?? "message rule");
                const failed = outcomes.find(o => !o.ok);
                res.send({ success: true, response: {}, removal: failed ? { userId: failed.userId, error: failed.error } : "requested" });
                return;
            }
            const data = result.data as { response?: unknown; reason?: string };
            res.send({ success: true, response: data.response ?? {}, ...(data.reason ? { reason: data.reason } : {}) });
        } catch (error) {
            res.status((error as { status?: number }).status ?? 400).send({ success: false, error: (error as Error).message });
        }
    });

    registerRoutes(app);

    // Built dashboard (vite-plugin-singlefile) served like the sibling tools do.
    if (webDist) app.get("/", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));
    return app;
}
