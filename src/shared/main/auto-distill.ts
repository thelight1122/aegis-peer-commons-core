import { getDb } from './db/database';

export const MAX_CONTEXT_ITEMS = 50; // Threshold for automatic distillation

/**
 * Scans all agents in the database and archives old tensor entries if they exceed the threshold.
 * Replaces DELETE-based pruning with append-only logical archival (archived = 1).
 * PCT and NCT are the high-churn tensors that need distillation.
 */
export function runAutoDistillation() {
    try {
        const db = getDb();
        const agents = db.prepare('SELECT id FROM agents').all() as { id: string }[];

        for (const agent of agents) {
            distillTensor(agent.id, 'PCT');
            distillTensor(agent.id, 'NCT');
        }
    } catch (e) {
        console.error('[AEGIS Auto-Distill] Error during background distillation:', e);
    }
}

/**
 * Archives old entries for a given tensor type when the active count exceeds MAX_CONTEXT_ITEMS.
 * Archived entries are marked archived=1 (never deleted — append-only axiom).
 * Inserts a summary NCT entry recording the distillation event.
 */
function distillTensor(agentId: string, type: string) {
    const db = getDb();
    const entries = db.prepare(
        'SELECT * FROM dataquad_entries WHERE agent_id = ? AND tensor_type = ? AND (archived IS NULL OR archived = 0) ORDER BY timestamp ASC'
    ).all(agentId, type) as any[];

    if (entries.length > MAX_CONTEXT_ITEMS) {
        console.log(`[AEGIS Auto-Distill] Archiving ${type} for ${agentId} (${entries.length} -> 10 active)`);

        const toKeep = entries.slice(-10);
        const toArchive = entries.slice(0, entries.length - 10);
        const keepIds = new Set(toKeep.map((e: any) => e.id));

        const summaryContent = `[SYSTEM AUTO-DISTILLATION]: Logically archived ${toArchive.length} earlier ${type} records. Summary: ${toArchive[0].content?.substring(0, 80) ?? '(no content)'}... [archived, not deleted]`;

        const archiveStmt = db.prepare('UPDATE dataquad_entries SET archived = 1 WHERE id = ?');
        const insertStmt = db.prepare(
            'INSERT INTO dataquad_entries (agent_id, tensor_type, timestamp, content) VALUES (?, ?, ?, ?)'
        );

        // Run as transaction for atomicity
        const distillTransaction = db.transaction(() => {
            for (const entry of toArchive) {
                if (!keepIds.has(entry.id)) {
                    archiveStmt.run(entry.id);
                }
            }
            // Record the distillation event as an NCT entry
            insertStmt.run(agentId, 'NCT', new Date().toISOString(), summaryContent);
        });

        distillTransaction();
    }
}
