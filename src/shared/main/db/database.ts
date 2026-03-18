import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { pruneOldBackups } from '../backup-pruner';

let db: Database.Database | null = null;

/**
 * Safely adds a column to a table — no-op if the column already exists.
 * SQLite throws on duplicate columns; we catch and swallow that specific error.
 */
function safeAddColumn(database: Database.Database, table: string, column: string, type: string): void {
    try {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e: any) {
        if (!e.message?.includes('duplicate column name')) throw e;
    }
}

export function initDatabase(workspacePath: string) {
    const aegisDir = path.join(workspacePath, '.aegis');
    if (!fs.existsSync(aegisDir)) {
        fs.mkdirSync(aegisDir, { recursive: true });
    }

    const dbPath = path.join(aegisDir, 'aegis_vault.db');
    db = new Database(dbPath);

    // Prune old backups on init
    pruneOldBackups(workspacePath);

    // Initial schema setup
    db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT,
            role TEXT,
            status TEXT,
            tools_json TEXT,
            swarm_id TEXT -- I-15: grouping for collective coherence
        );

        CREATE TABLE IF NOT EXISTS dataquad_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT,
            tensor_type TEXT, -- PCT, PEER, NCT, SPINE (migrated from context/affect/memory/learning)
            timestamp TEXT,
            content TEXT,
            sequence_json TEXT, -- for reflection data
            topology_index TEXT, -- I-12: structural index
            FOREIGN KEY(agent_id) REFERENCES agents(id)
        );
    `);

    // ── Migration 001: Rename tensor types to canonical PCT/PEER/NCT/SPINE names ──
    // Safe to run repeatedly — only updates rows that still have old names.
    db.exec(`
        UPDATE dataquad_entries SET tensor_type = 'PCT'   WHERE tensor_type = 'context';
        UPDATE dataquad_entries SET tensor_type = 'PEER'  WHERE tensor_type = 'affect';
        UPDATE dataquad_entries SET tensor_type = 'NCT'   WHERE tensor_type = 'memory';
        UPDATE dataquad_entries SET tensor_type = 'SPINE' WHERE tensor_type = 'learning';
    `);

    // ── Migration 002: Add new columns for rich entry metadata ──
    safeAddColumn(db, 'dataquad_entries', 'entry_uuid', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'classification', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'prompt_hash', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'fracture_virtues_json', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'gate_path', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'linked_records_json', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'verified_at', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'pattern_signature', 'TEXT');
    safeAddColumn(db, 'dataquad_entries', 'archived', 'INTEGER DEFAULT 0');
}

export function isDatabaseInitialized() {
    return db !== null;
}

export function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDatabase(workspacePath) first.');
    return db as any;
}

export function saveAgentToDb(agent: any) {
    const database = getDb();

    // 1. Upsert Agent metadata (name, role, status, tools, swarm)
    const upsertAgent = database.prepare(`
        INSERT INTO agents (id, name, role, status, tools_json, swarm_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            role=excluded.role,
            status=excluded.status,
            tools_json=excluded.tools_json,
            swarm_id=excluded.swarm_id
    `);

    upsertAgent.run(
        agent.id,
        agent.name,
        agent.role,
        agent.status,
        JSON.stringify(agent.tools || []),
        agent.swarmId || null
    );

    // 2. Append-only DataQuad inserts — no DELETE.
    // The Session Manager (dataquad-session.ts) handles structured writes.
    // This path handles legacy agent objects that still carry the old quad shape.
    const insertEntry = database.prepare(`
        INSERT INTO dataquad_entries (agent_id, tensor_type, timestamp, content, sequence_json, topology_index)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertTensor = (type: string, entries: any[]) => {
        for (const entry of entries) {
            insertEntry.run(
                agent.id,
                type,
                entry.timestamp,
                entry.content,
                entry.sequenceData ? JSON.stringify(entry.sequenceData) : null,
                entry.topologyIndex || null
            );
        }
    };

    // Support both legacy (context/affect/memory/learning) and new (PCT/PEER/NCT/SPINE) shapes.
    // Legacy keys are mapped to new tensor type names on insert.
    if (agent.dataQuad) {
        const dq = agent.dataQuad;
        insertTensor('PCT',   dq.PCT?.entries   ?? dq.context   ?? []);
        insertTensor('PEER',  dq.PEER?.entries  ?? dq.affect    ?? []);
        insertTensor('NCT',   dq.NCT?.entries   ?? dq.memory    ?? []);
        insertTensor('SPINE', dq.SPINE?.entries ?? dq.learning  ?? []);
    }
}

export function loadAgentFromDb(agentId: string) {
    const database = getDb();

    const agentRow = database.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
    if (!agentRow) return null;

    const entries = database.prepare(
        'SELECT * FROM dataquad_entries WHERE agent_id = ? AND (archived IS NULL OR archived = 0)'
    ).all(agentId) as any[];

    // Build the new DataQuadBundle shape as primary, with legacy keys as a compat shim.
    const agent: any = {
        id: agentRow.id,
        name: agentRow.name,
        role: agentRow.role,
        status: agentRow.status,
        swarmId: agentRow.swarm_id,
        tools: JSON.parse(agentRow.tools_json),
        dataQuad: {
            // New canonical tensors
            PCT:   { entries: [] as any[] },
            PEER:  { entries: [] as any[] },
            NCT:   { entries: [] as any[] },
            SPINE: { entries: [] as any[] },
            // Legacy compat keys (populated below for callers not yet updated)
            context:  [] as any[],
            affect:   [] as any[],
            memory:   [] as any[],
            learning: [] as any[],
        }
    };

    for (const row of entries) {
        const base = {
            id: row.entry_uuid ?? String(row.id),
            timestamp: row.timestamp,
            content: row.content,
            topologyIndex: row.topology_index,
            sequenceData: row.sequence_json ? JSON.parse(row.sequence_json) : undefined,
        };

        switch (row.tensor_type) {
            case 'PCT':
                agent.dataQuad.PCT.entries.push(base);
                agent.dataQuad.context.push(base);   // legacy compat
                break;
            case 'PEER': {
                const peerEntry = {
                    ...base,
                    classification: row.classification,
                    promptHash: row.prompt_hash,
                    fractureVirtues: row.fracture_virtues_json ? JSON.parse(row.fracture_virtues_json) : undefined,
                    gatePathObserved: row.gate_path,
                };
                agent.dataQuad.PEER.entries.push(peerEntry);
                agent.dataQuad.affect.push(peerEntry); // legacy compat
                break;
            }
            case 'NCT':
                agent.dataQuad.NCT.entries.push(base);
                agent.dataQuad.memory.push(base);    // legacy compat
                break;
            case 'SPINE': {
                const spineEntry = {
                    ...base,
                    linkedRecords: row.linked_records_json ? JSON.parse(row.linked_records_json) : [],
                    verifiedAt: row.verified_at ?? row.timestamp,
                    patternSignature: row.pattern_signature ?? '',
                };
                agent.dataQuad.SPINE.entries.push(spineEntry);
                agent.dataQuad.learning.push(spineEntry); // legacy compat
                break;
            }
        }
    }

    return agent;
}

export function getSystemMetrics() {
    const database = getDb();

    const agentsRow = database.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const entriesRow = database.prepare('SELECT COUNT(*) as count FROM dataquad_entries').get() as { count: number };

    return {
        totalAgents: agentsRow.count,
        totalEntries: entriesRow.count
    };
}

/**
 * Collective Memory Lookup for Swarms (I-15)
 * NCT = Nostalgic Context Tensor (formerly 'memory')
 */
export function loadSwarmMemories(swarmId: string): any[] {
    const database = getDb();
    const query = `
        SELECT e.* FROM dataquad_entries e
        JOIN agents a ON e.agent_id = a.id
        WHERE a.swarm_id = ? AND e.tensor_type = 'NCT'
        ORDER BY e.timestamp DESC
    `;
    const rows = database.prepare(query).all(swarmId) as any[];
    return rows.map(r => ({
        timestamp: r.timestamp,
        content: r.content,
        topologyIndex: r.topology_index
    }));
}

/**
 * Collective Learning Lookup for Swarms (I-21)
 * SPINE = Stabilized Patterned Interpretive Nexus of Evidence (formerly 'learning')
 */
export function loadSwarmLearnings(swarmId: string): any[] {
    const database = getDb();
    const query = `
        SELECT e.* FROM dataquad_entries e
        JOIN agents a ON e.agent_id = a.id
        WHERE a.swarm_id = ? AND e.tensor_type = 'SPINE'
        ORDER BY e.timestamp DESC
    `;
    const rows = database.prepare(query).all(swarmId) as any[];
    return rows.map(r => ({
        timestamp: r.timestamp,
        content: r.content,
        patternSignature: r.pattern_signature,
        linkedRecords: r.linked_records_json ? JSON.parse(r.linked_records_json) : [],
    }));
}

/**
 * Collective Affect Lookup for Swarms (I-23)
 * PEER = Patterned Experiential Evidence Repository (formerly 'affect')
 */
export function loadSwarmAffects(swarmId: string): any[] {
    const database = getDb();
    const query = `
        SELECT e.* FROM dataquad_entries e
        JOIN agents a ON e.agent_id = a.id
        WHERE a.swarm_id = ? AND e.tensor_type = 'PEER'
        ORDER BY e.timestamp DESC
    `;
    const rows = database.prepare(query).all(swarmId) as any[];
    return rows.map(r => ({
        timestamp: r.timestamp,
        content: r.content,
        classification: r.classification,
        promptHash: r.prompt_hash,
    }));
}
