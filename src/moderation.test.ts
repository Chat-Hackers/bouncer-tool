import { describe, expect, it } from "vitest";
import { containsPhrase, defaults, evaluate, validateConfig } from "./moderation.js";
import type { RuleAction } from "../types.js";
const event = (text: string) => ({ event_id: "$test", room_id: "!room:test", sender: "@person:test", type: "m.room.message", content: { msgtype: "m.text", body: text } });

describe("containsPhrase", () => {
    it("whole words prevent substring false positives and rules handle Unicode", () => {
        expect(containsPhrase("You are an IDIOT!", "idiot")).toBe(true);
        expect(containsPhrase("An idiotic suggestion", "idiot")).toBe(false);
        expect(containsPhrase("ＳＨＵＴ　ＵＰ", "shut up")).toBe(true);
        expect(containsPhrase("i\u200Bdiot", "idiot")).toBe(true);
        expect(containsPhrase("special C++ example", "C++")).toBe(true);
        expect(containsPhrase("Scunthorpe", "cunt")).toBe(false);
    });
});

describe("evaluate", () => {
    it("applies exceptions per rule and skips disabled rules", () => {
        const config = defaults();
        config.rules[0].exceptions = ["don’t call people"];
        const result = evaluate(event("Please don’t call people an idiot. Shut up."), config);
        expect(result.matches.map(m => m.ruleId)).toEqual(["aggressive-language"]);
        expect(result.exceptions.length).toBe(1);
        config.rules[1].enabled = false;
        expect(evaluate(event("shut up"), config).matches.length).toBe(0);
    });

    it("keeps the context false positive rather than claiming semantic judgement", () => {
        expect(evaluate(event("Please don’t call people an idiot."), defaults()).matches.length).toBe(1);
    });

    it("ignores bots and exemptions; strips quoted reply fallback; handles edits", () => {
        const config = defaults();
        config.exemptSenders = ["@person:test"];
        expect(evaluate(event("idiot"), config).ignored).toBe("Bot or exempt sender");
        expect(evaluate(event("idiot"), defaults(), "@person:test").ignored).toBeTruthy();
        const reply = event("> <@other:test> idiot\n\nThanks for explaining.") as Record<string, any>;
        reply.content["m.relates_to"] = { "m.in_reply_to": { event_id: "$old" } };
        expect(evaluate(reply, defaults()).matches.length).toBe(0);
        const edit = event("* old body") as Record<string, any>;
        edit.content["m.relates_to"] = { rel_type: "m.replace", event_id: "$old" };
        edit.content["m.new_content"] = { msgtype: "m.text", body: "You are an idiot" };
        expect(evaluate(edit, defaults()).matches.length).toBe(1);
    });
});

describe("validateConfig", () => {
    it("rejects unsupported actions or unconstrained live rooms", () => {
        expect(() => validateConfig({ ...defaults(), mode: "live" })).toThrow(/room/);
        const config = defaults();
        config.rules[0].action = "ban" as RuleAction;
        expect(() => validateConfig(config)).toThrow(/review, warn or remove/);
        expect(() => validateConfig({ ...defaults(), cooldownSeconds: 0 })).toThrow(/cooldown/);
    });
});
