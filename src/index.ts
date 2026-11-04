import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { startDuckDB } from "./duckdb.js";
import { registrationFor } from "./registration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = 5059;

async function start() {
    await startDuckDB();
    const app = createApp(path.resolve(__dirname, "../../web/dist"));
    app.listen(port, () => console.log(`Auto Bouncer & Moderator listening on http://localhost:${port}`));

    const registration = registrationFor(port, randomUUID());
    fs.writeFileSync(`./${registration.id}.json`, JSON.stringify(registration, null, 2));
    console.log(`Registration JSON (share privately):\n${JSON.stringify(registration, null, 2)}\nSaved to ${registration.id}.json`);
}

start();
