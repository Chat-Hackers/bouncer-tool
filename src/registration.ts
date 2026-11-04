const moduleSecret = () => process.env.bouncer_secret || process.env.MODULE_SECRET || "";

export type HubRegistration = {
    id: string; uuid: string; url: string; emoji: string; introduction: string; title: string;
    description: string; secret: string; event_types: { passive: string[] };
};

// Hub registration: passive member + message events, webhook at the tool root.
export function registrationFor(port: number, uuid: string): HubRegistration {
    return {
        id: "bouncer",
        uuid,
        url: `http://localhost:${port}`,
        emoji: "🛡️",
        introduction: "Checks new members against the approved list and can remove anyone not on it. Flags, warns or removes for words you choose.",
        title: "Auto Bouncer & Moderator",
        description: "Approved-number checks, auto-remove and message rules",
        secret: moduleSecret(),
        event_types: {
            passive: [
                "m.room.member",
                "m.room.message"
            ]
        }
    };
}
