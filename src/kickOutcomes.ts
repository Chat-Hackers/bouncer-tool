import { getParticipants, upsertParticipant } from "./duckdb.js";

// Records sent/failed on each participant after the Hub has answered kick requests.
// `by` labels the origin ("organiser", "auto-remove", "message rule") for the audit trail.
export async function recordKickOutcomes(roomId: string, outcomes: { userId: string; ok: boolean; error?: string }[], by: string) {
    for (const outcome of outcomes) {
        const participant = (await getParticipants(roomId)).find(p => p.userId === outcome.userId);
        if (!participant) continue;
        participant.kick = { status: outcome.ok ? "sent" : "failed", at: new Date().toISOString(), by, ...(outcome.ok ? {} : { error: outcome.error }) };
        await upsertParticipant(roomId, participant);
    }
}
