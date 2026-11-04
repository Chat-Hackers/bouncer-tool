import { IncidentMatch, ModerationConfig, Rule, RuleAction } from "../types.js";

export const warningText = "Moderator note: please keep the conversation respectful. A message has been flagged for organiser review.";

export const defaults = (): ModerationConfig => ({
    mode: "demo",
    rooms: [],
    exemptSenders: [],
    cooldownSeconds: 300,
    warning: warningText,
    rules: [
        { id: "personal-insult", phrase: "idiot", action: "warn", enabled: true, exceptions: [] },
        { id: "aggressive-language", phrase: "shut up", action: "review", enabled: true, exceptions: [] }
    ]
});

export const normalize = (text: unknown) => String(text).normalize("NFKC").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/gu, " ").trim();
// Regex-escapes a literal phrase for whole-word matching.
function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsPhrase(text: unknown, phrase: string) {
    const needle = normalize(phrase);
    if (!needle) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`, "u").test(normalize(text));
}

const list = (value: unknown, label: string) => {
    if (!Array.isArray(value) || value.length > 100 || value.some(s => typeof s !== "string" || !s.trim() || s.length > 300)) throw Error(`${label}: use up to 100 nonempty entries`);
    return [...new Set(value.map(s => s.trim()))];
};

export type Evaluation = { ignored?: string; matches: IncidentMatch[]; exceptions: { ruleId: string; phrase: string }[]; text?: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
    (value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : null;

export function validateConfig(input: unknown): ModerationConfig {
    const raw = asRecord(input);
    if (!raw || !["demo", "live"].includes(raw.mode as string)) throw Error("Choose demo or live mode");
    const rooms = list(raw.rooms, "Room IDs");
    if (rooms.some(s => !s.startsWith("!"))) throw Error("Matrix room IDs must start with !");
    if (raw.mode === "live" && !rooms.length) throw Error("Add at least one allowed room before enabling live mode");
    const exemptSenders = list(raw.exemptSenders, "Exempt senders");
    if (!Number.isInteger(raw.cooldownSeconds) || (raw.cooldownSeconds as number) < 10 || (raw.cooldownSeconds as number) > 86400) throw Error("Warning cooldown must be 10–86,400 seconds");
    if (typeof raw.warning !== "string" || raw.warning.trim().length < 5 || raw.warning.length > 1000) throw Error("Warning must contain 5–1,000 characters");
    if (!Array.isArray(raw.rules) || raw.rules.length > 100) throw Error("Use up to 100 rules");
    const ids = new Set<string>();
    const rules: Rule[] = raw.rules.map((r: unknown) => {
        const rule = asRecord(r);
        if (!rule || typeof rule.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id)) throw Error("Each rule needs a unique id");
        ids.add(rule.id);
        if (typeof rule.phrase !== "string" || !normalize(rule.phrase) || rule.phrase.length > 200) throw Error("Each rule needs a phrase of 1–200 characters");
        if (!["review", "warn", "remove"].includes(rule.action as string)) throw Error("Supported actions: review, warn or remove");
        if (typeof rule.enabled !== "boolean") throw Error("Rule enabled must be true or false");
        return { id: rule.id, phrase: rule.phrase.trim(), action: rule.action as RuleAction, enabled: rule.enabled, exceptions: list(rule.exceptions, "Rule exceptions") };
    });
    return { mode: raw.mode as "demo" | "live", rooms, exemptSenders, cooldownSeconds: raw.cooldownSeconds as number, warning: raw.warning.trim(), rules };
}

export function evaluate(event: unknown, config: ModerationConfig, botUserId?: string): Evaluation {
    const e = asRecord(event);
    const content = asRecord(e?.content);
    if (!e || e.type !== "m.room.message" || !["m.text", "m.notice"].includes(String(content?.msgtype))) return { ignored: "Not a text message", matches: [], exceptions: [] };
    if (typeof e.room_id !== "string" || typeof e.sender !== "string" || typeof e.event_id !== "string" || !e.event_id || e.event_id.length > 500 || e.room_id.length > 300 || e.sender.length > 300) throw Error("Text events require room_id, sender and event_id");
    const context = asRecord(content?.context);
    if (e.sender === botUserId || context?.autoModerator === true || context?.moduleEvent === true || config.exemptSenders.includes(e.sender)) return { ignored: "Bot or exempt sender", matches: [], exceptions: [] };
    const relates = asRecord(content?.["m.relates_to"]);
    const edited = relates?.rel_type === "m.replace" ? asRecord(content?.["m.new_content"]) : content;
    if (typeof edited?.body !== "string" || edited.body.length > 20000) throw Error("Message body must be text under 20,000 characters");
    let text: string = edited.body;
    if (relates?.["m.in_reply_to"]) text = text.replace(/^(?:>[^\n]*\n)+\n?/, "");
    const matches: IncidentMatch[] = [], exceptions: { ruleId: string; phrase: string }[] = [];
    for (const rule of config.rules) {
        if (!rule.enabled || !containsPhrase(text, rule.phrase)) continue;
        const exception = rule.exceptions.find(phrase => containsPhrase(text, phrase));
        if (exception) exceptions.push({ ruleId: rule.id, phrase: exception });
        else matches.push({ ruleId: rule.id, phrase: rule.phrase, action: rule.action });
    }
    return { text, matches, exceptions };
}
