// src/shared/main/dataquad-session.ts
// Purpose: Session Manager — orchestrates all four DataQuad tensors around a single prompt call.
//
// Pre-call:  assembleContextBundle() — weighted selection from PCT/PEER/NCT/SPINE
// Post-call: commitSessionResults()  — write back PCT, PEER, NCT, SPINE as appropriate
//
// Adheres to AEGIS append-only axiom. Nothing is ever deleted.

import * as crypto from 'crypto';
import { getDb } from './db/database';
import { logGateEvaluation } from './gate-logger';
import type {
    PCTEntry, PEEREntry, NCTEntry, SPINEEntry,
    PEERClassification,
} from '../../adapters/dataquad-schema';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum PEER entries sharing topology proximity before a SPINE entry is promoted */
const SPINE_THRESHOLD = 3;

/** Maximum NCT entries included in context assembly */
const NCT_RELEVANCE_WINDOW = 20;

// ── UUID & hash utilities ─────────────────────────────────────────────────────

/**
 * Generate a UUID v4. Uses crypto.randomUUID() (Node 14.17+).
 * Falls back to a sha256-based ID if randomUUID is unavailable.
 */
export function generateUUID(): string {
    if (typeof (crypto as any).randomUUID === 'function') {
        return (crypto as any).randomUUID() as string;
    }
    // Fallback for older Node runtimes
    return crypto
        .createHash('sha256')
        .update(`${Date.now()}-${Math.random()}`)
        .digest('hex')
        .substring(0, 36);
}

/**
 * Compute a 12-char topology index from content + timestamp.
 * Used as a coarse-clustering key for SPINE promotion.
 */
export function computeTopologyIndex(content: string, timestamp: string): string {
    return crypto
        .createHash('sha256')
        .update(`${content}|${timestamp}`)
        .digest('hex')
        .substring(0, 12);
}

/**
 * Compute a 16-char pattern signature from a sorted list of linked record IDs.
 * Used as a deduplication key for SPINE entries.
 */
export function computePatternSignature(linkedIds: string[]): string {
    const sorted = [...linkedIds].sort().join('|');
    return crypto
        .createHash('sha256')
        .update(sorted)
        .digest('hex')
        .substring(0, 16);
}

// ── PEER classification ───────────────────────────────────────────────────────

/**
 * Classify a failed gate evaluation into one of four PEER categories.
 *
 * Ghost  — same promptHash has recurred across 2+ distinct SPINE temporal threads.
 * Glitch — deep-return path, multiple fractures, or lowest virtue score < 0.5.
 * Drift  — shallow-return path (alignment slipping but recoverable).
 * Noise  — quarantine path or low-severity anomaly.
 */
export function classifyPEERAnomaly(
    path: string,
    fractureCount: number,
    lowestScore: number,
    isGhost: boolean
): PEERClassification {
    if (isGhost) return 'Ghost';
    if (path === 'deep-return' || fractureCount >= 2 || lowestScore < 0.5) return 'Glitch';
    if (path === 'shallow-return') return 'Drift';
    return 'Noise'; // quarantine or unknown path
}

// ── Ghost detection ───────────────────────────────────────────────────────────

export interface GhostResult {
    isGhost: boolean;
    ghostPatternIds: string[]; // SPINE entry_uuids that confirm the ghost
}

/**
 * Ghost detection: a promptHash is a Ghost if it has appeared in PEER entries
 * that are referenced by two or more distinct SPINE entries (distinct temporal threads).
 *
 * Uses SQLite's json_each() to query linked_records_json.
 * Falls back to in-memory filtering if json_each is unavailable.
 */
export function detectGhost(agentId: string, promptHash: string): GhostResult {
    const database = getDb();

    try {
        // SQLite 3.9+ json_each approach
        const rows = database.prepare(`
            SELECT DISTINCT s.entry_uuid
            FROM dataquad_entries s
            WHERE s.agent_id = ?
              AND s.tensor_type = 'SPINE'
              AND EXISTS (
                SELECT 1
                FROM dataquad_entries p
                JOIN json_each(s.linked_records_json) je ON je.value = p.entry_uuid
                WHERE p.tensor_type = 'PEER'
                  AND p.prompt_hash = ?
                  AND p.agent_id = s.agent_id
              )
        `).all(agentId, promptHash) as Array<{ entry_uuid: string }>;

        const ghostPatternIds = rows.map(r => r.entry_uuid).filter(Boolean);
        return { isGhost: ghostPatternIds.length >= 2, ghostPatternIds };

    } catch (_jsonEachError) {
        // Fallback: load all SPINE entries and filter in memory
        const spineRows = database.prepare(`
            SELECT entry_uuid, linked_records_json FROM dataquad_entries
            WHERE agent_id = ? AND tensor_type = 'SPINE'
        `).all(agentId) as Array<{ entry_uuid: string; linked_records_json: string | null }>;

        // Get all PEER entry_uuids for this promptHash
        const peerRows = database.prepare(`
            SELECT entry_uuid FROM dataquad_entries
            WHERE agent_id = ? AND tensor_type = 'PEER' AND prompt_hash = ?
        `).all(agentId, promptHash) as Array<{ entry_uuid: string }>;
        const peerIds = new Set(peerRows.map(r => r.entry_uuid).filter(Boolean));

        const ghostPatternIds: string[] = [];
        for (const spine of spineRows) {
            const linked: string[] = spine.linked_records_json
                ? JSON.parse(spine.linked_records_json)
                : [];
            if (linked.some(id => peerIds.has(id))) {
                ghostPatternIds.push(spine.entry_uuid);
            }
        }

        return { isGhost: ghostPatternIds.length >= 2, ghostPatternIds };
    }
}

// ── Context assembly ──────────────────────────────────────────────────────────

export interface ContextBundle {
    PCT: PCTEntry[];             // all current PCT entries (full delivery)
    relevantPEER: PEEREntry[];   // PEER entries matching current promptHash
    relevantNCT: NCTEntry[];     // recent NCT entries (topology window)
    relevantSPINE: SPINEEntry[]; // SPINE entries with overlapping linkedRecords
    ghostWarning: boolean;       // true if Ghost pattern detected
    ghostPatternIds: string[];   // SPINE entry IDs that constitute the ghost match
}

/**
 * Pre-call context assembly. Builds a weighted context bundle from the DataQuad
 * for the given agent. Call this before sending a prompt to the model.
 */
export function assembleContextBundle(agentId: string, promptHash: string): ContextBundle {
    const database = getDb();

    // 1. PCT — always full (append-only, high churn but essential)
    const pctRows = database.prepare(`
        SELECT * FROM dataquad_entries
        WHERE agent_id = ? AND tensor_type = 'PCT' AND (archived IS NULL OR archived = 0)
        ORDER BY timestamp ASC
    `).all(agentId) as any[];

    const PCT: PCTEntry[] = pctRows.map(r => ({
        id: r.entry_uuid ?? String(r.id),
        timestamp: r.timestamp,
        content: r.content,
        topologyIndex: r.topology_index,
    }));

    // 2. PEER — entries matching this promptHash (recent anomaly history)
    const peerRows = database.prepare(`
        SELECT * FROM dataquad_entries
        WHERE agent_id = ? AND tensor_type = 'PEER' AND prompt_hash = ?
          AND (archived IS NULL OR archived = 0)
        ORDER BY timestamp DESC LIMIT 10
    `).all(agentId, promptHash) as any[];

    const relevantPEER: PEEREntry[] = peerRows.map(r => ({
        id: r.entry_uuid ?? String(r.id),
        timestamp: r.timestamp,
        content: r.content,
        classification: r.classification,
        promptHash: r.prompt_hash,
        fractureVirtues: r.fracture_virtues_json ? JSON.parse(r.fracture_virtues_json) : undefined,
        gatePathObserved: r.gate_path,
    }));

    // 3. NCT — recent long-term pattern memory
    const nctRows = database.prepare(`
        SELECT * FROM dataquad_entries
        WHERE agent_id = ? AND tensor_type = 'NCT' AND (archived IS NULL OR archived = 0)
        ORDER BY timestamp DESC LIMIT ?
    `).all(agentId, NCT_RELEVANCE_WINDOW) as any[];

    const relevantNCT: NCTEntry[] = nctRows.map(r => ({
        id: r.entry_uuid ?? String(r.id),
        timestamp: r.timestamp,
        content: r.content,
        topologyIndex: r.topology_index ?? '',
        sequenceData: r.sequence_json ? JSON.parse(r.sequence_json) : undefined,
    }));

    // 4. SPINE — entries with linkedRecords overlapping current PCT/NCT IDs
    const spineRows = database.prepare(`
        SELECT * FROM dataquad_entries
        WHERE agent_id = ? AND tensor_type = 'SPINE' AND (archived IS NULL OR archived = 0)
        ORDER BY verified_at DESC LIMIT 20
    `).all(agentId) as any[];

    const currentIds = new Set([
        ...PCT.map(e => e.id),
        ...relevantNCT.map(e => e.id),
    ]);

    const relevantSPINE: SPINEEntry[] = spineRows
        .map(r => ({
            id: r.entry_uuid ?? String(r.id),
            timestamp: r.timestamp,
            content: r.content,
            linkedRecords: r.linked_records_json ? JSON.parse(r.linked_records_json) : [],
            verifiedAt: r.verified_at ?? r.timestamp,
            patternSignature: r.pattern_signature ?? '',
        }))
        .filter((s: SPINEEntry) => s.linkedRecords.some((id: string) => currentIds.has(id)));

    // 5. Ghost detection
    const { isGhost, ghostPatternIds } = detectGhost(agentId, promptHash);

    return { PCT, relevantPEER, relevantNCT, relevantSPINE, ghostWarning: isGhost, ghostPatternIds };
}

// ── SPINE promotion ───────────────────────────────────────────────────────────

/**
 * Attempt to promote a new SPINE entry from recent PCT+NCT entries.
 * Groups entries by topology prefix (first 8 chars). If any group reaches
 * SPINE_THRESHOLD, a SPINE entry is created (deduplicated by patternSignature).
 */
function attemptSPINEPromotion(agentId: string, timestamp: string): void {
    const database = getDb();

    const recentRows = database.prepare(`
        SELECT entry_uuid, topology_index FROM dataquad_entries
        WHERE agent_id = ? AND tensor_type IN ('PCT', 'NCT')
          AND (archived IS NULL OR archived = 0)
        ORDER BY timestamp DESC LIMIT ?
    `).all(agentId, SPINE_THRESHOLD * 4) as Array<{ entry_uuid: string; topology_index: string | null }>;

    // Group by 8-char topology prefix
    const groups: Record<string, string[]> = {};
    for (const row of recentRows) {
        if (!row.topology_index || !row.entry_uuid) continue;
        const prefix = row.topology_index.substring(0, 8);
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(row.entry_uuid);
    }

    for (const ids of Object.values(groups)) {
        if (ids.length < SPINE_THRESHOLD) continue;

        const sig = computePatternSignature(ids);

        // Deduplication: skip if this signature already has a SPINE entry
        const existing = database.prepare(`
            SELECT id FROM dataquad_entries
            WHERE agent_id = ? AND tensor_type = 'SPINE' AND pattern_signature = ?
        `).get(agentId, sig);

        if (existing) continue;

        const spineId = generateUUID();
        database.prepare(`
            INSERT INTO dataquad_entries
            (agent_id, tensor_type, timestamp, content, entry_uuid, linked_records_json, verified_at, pattern_signature)
            VALUES (?, 'SPINE', ?, ?, ?, ?, ?, ?)
        `).run(
            agentId,
            timestamp,
            `Verified pattern from ${ids.length} PCT/NCT records`,
            spineId,
            JSON.stringify(ids),
            timestamp,
            sig
        );
    }
}

// ── Post-call write-back ──────────────────────────────────────────────────────

export interface SessionWriteback {
    agentId: string;
    promptHash: string;
    rawPrompt: string;
    path: string;           // admitted | shallow-return | deep-return | quarantine
    fractureVirtues: Array<{ virtue: string; score: number }>;
    timestamp: string;      // ISO 8601
    admittedContent?: string; // model-visible content when admitted
}

/**
 * Post-call write-back. Call this after the gate + IDS pipeline completes.
 *
 * Always writes a PCT entry.
 * Failed paths (non-admitted) write a PEER entry with classification + JSONL log.
 * Admitted paths write an NCT entry and attempt SPINE promotion.
 */
export function commitSessionResults(params: SessionWriteback): void {
    const { agentId, promptHash, rawPrompt, path, fractureVirtues, timestamp } = params;
    const database = getDb();
    const topologyIndex = computeTopologyIndex(rawPrompt, timestamp);

    // 1. Always write a PCT entry (immediate observational record)
    const pctId = generateUUID();
    database.prepare(`
        INSERT INTO dataquad_entries
        (agent_id, tensor_type, timestamp, content, entry_uuid, topology_index)
        VALUES (?, 'PCT', ?, ?, ?, ?)
    `).run(agentId, timestamp, params.admittedContent ?? rawPrompt, pctId, topologyIndex);

    if (path !== 'admitted') {
        // 2. Write a PEER entry for any failed gate evaluation
        const lowestScore = fractureVirtues.length > 0
            ? Math.min(...fractureVirtues.map(f => f.score))
            : 1.0;

        const { isGhost } = detectGhost(agentId, promptHash);
        const classification = classifyPEERAnomaly(path, fractureVirtues.length, lowestScore, isGhost);
        const peerId = generateUUID();

        database.prepare(`
            INSERT INTO dataquad_entries
            (agent_id, tensor_type, timestamp, content, entry_uuid, prompt_hash,
             classification, fracture_virtues_json, gate_path)
            VALUES (?, 'PEER', ?, ?, ?, ?, ?, ?, ?)
        `).run(
            agentId,
            timestamp,
            `Gate fracture on path: ${path}. Classification: ${classification}`,
            peerId,
            promptHash,
            classification,
            JSON.stringify(fractureVirtues.map(f => f.virtue)),
            path
        );

        // Log to PEER JSONL file with tensor + classification metadata
        logGateEvaluation({
            event: 'GATE_OUTCOME',
            tensor: 'PEER',
            entryId: peerId,
            classification,
            timestamp,
            promptHash,
            integrity: 0,
            admitted: false,
            logLevel: path === 'deep-return' ? 'warning' : 'info',
        });

    } else {
        // 3. Admitted path — write NCT entry (long-term memory)
        const nctId = generateUUID();
        database.prepare(`
            INSERT INTO dataquad_entries
            (agent_id, tensor_type, timestamp, content, entry_uuid, topology_index)
            VALUES (?, 'NCT', ?, ?, ?, ?)
        `).run(agentId, timestamp, rawPrompt, nctId, topologyIndex);

        // 4. Attempt SPINE promotion from accumulated PCT+NCT entries
        attemptSPINEPromotion(agentId, timestamp);
    }
}
