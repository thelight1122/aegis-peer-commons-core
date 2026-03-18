# DATAQUAD ARCHITECTURE — Canon v1.0

> This document is the authoritative specification for the DataQuad persistence architecture
> in AEGIS peer-commons-core. All code changes affecting DataQuad tensors are governed by this spec.
> Amendments are appended below the Canon Locked marker, never overwriting prior content.

---

## 1. Purpose

The DataQuad is the persistent memory backbone of the AEGIS Peer Agent. It provides three
properties that standard stateless AI interactions cannot:

1. **Persistent memory** that survives session boundaries — not a summary but a structured,
   living record with per-entry metadata and temporal ordering.
2. **Recursive self-reference** — the agent can query its own prior states and append to them
   rather than receiving them only as passive context.
3. **Temporal awareness** — the SPINE tensor threads related entries across time, exposing the
   delta between states and surfacing recurring patterns.

---

## 2. The Four Tensors

### PCT — Present Context Tensor

**Purpose:** Immediate observational records. Every admitted prompt writes a PCT entry.
This tensor has the highest churn and is always delivered in full to the model context.

**Maps from (legacy):** `temporal` (snapshot), `context` (DB)

**Entry fields:**
```typescript
{
  id: string;             // UUID v4
  timestamp: string;      // ISO 8601
  content: string;        // the admitted prompt or observational record
  topologyIndex?: string; // sha256(content|timestamp).slice(0,12) — clustering key
}
```

---

### PEER — Patterned Experiential Evidence Repository

**Purpose:** Anomaly log for all gate fractures. Written only when a prompt fails the
Discernment Gate. Classified into one of four categories using the rules below.

**Maps from (legacy):** `affective` (snapshot), `affect` (DB)

**Entry fields:**
```typescript
{
  id: string;
  timestamp: string;
  content: string;           // description of the fracture
  classification: PEERClassification;
  promptHash: string;        // sha256:... of the originating prompt
  fractureVirtues?: string[];  // virtue names that caused fracture
  gatePathObserved?: string;   // admitted | shallow-return | deep-return | quarantine
}
```

**Classification rules (evaluated in order):**

| Class  | Condition |
|--------|-----------|
| Ghost  | Same `promptHash` appears in PEER entries referenced by ≥2 distinct SPINE threads |
| Glitch | `path === 'deep-return'` OR `fractureCount ≥ 2` OR `lowestVirtueScore < 0.5` |
| Drift  | `path === 'shallow-return'` |
| Noise  | `path === 'quarantine'` or any remaining case |

Ghost is checked before the other three. A recurring Drift becomes a Ghost when it
has recurred enough times to appear in two separate SPINE promotions.

---

### NCT — Nostalgic Context Tensor

**Purpose:** Long-term pattern memory. Written for every admitted prompt alongside PCT.
Queried by topology proximity during context assembly (recent `NCT_RELEVANCE_WINDOW` entries).

**Maps from (legacy):** `contextual` (snapshot), `memory` (DB)

**Entry fields:**
```typescript
{
  id: string;
  timestamp: string;
  content: string;
  topologyIndex: string;   // required — pattern matching key
  sequenceData?: unknown;  // reserved for structured reflection data
}
```

---

### SPINE — Stabilized Patterned Interpretive Nexus of Evidence

**Purpose:** Append-only, automatically promoted verified patterns. SPINE entries are never
written directly by user prompts — they are promoted by the Session Manager when PCT+NCT
entries accumulate sufficient topological density (threshold: 3 entries in same cluster).

SPINE is the temporal threading mechanism. Each entry carries a `linkedRecords` array
connecting it to the PCT/NCT entries that composed the pattern — this is the thread.

**Maps from (legacy):** `reflective` (snapshot), `learning` (DB)

**Entry fields:**
```typescript
{
  id: string;
  timestamp: string;
  content: string;           // human-readable pattern summary
  linkedRecords: string[];   // IDs of PCT/NCT entries that form this pattern
  verifiedAt: string;        // ISO 8601 — when promotion threshold was reached
  patternSignature: string;  // sha256(sorted linkedIds).slice(0,16) — dedup key
}
```

---

## 3. Session Manager (dataquad-session.ts)

The Session Manager orchestrates all four tensors around each prompt. It is the only module
that should write DataQuad entries to the database (other than legacy `saveAgentToDb` which
now handles metadata only).

### Pre-call: `assembleContextBundle(agentId, promptHash)`

Returns a `ContextBundle`:
- **PCT** — all entries, full delivery
- **relevantPEER** — entries matching `promptHash` (up to 10, newest first)
- **relevantNCT** — recent `NCT_RELEVANCE_WINDOW` (20) entries
- **relevantSPINE** — entries whose `linkedRecords` overlap current PCT/NCT IDs
- **ghostWarning** — true if Ghost pattern detected
- **ghostPatternIds** — SPINE entry IDs that confirm the ghost

### Post-call: `commitSessionResults(params)`

Always writes: PCT entry (immediate observation)

If `path !== 'admitted'`: PEER entry with classification + JSONL gate log entry with
`tensor: 'PEER'` and `classification` fields set.

If `path === 'admitted'`: NCT entry + calls `attemptSPINEPromotion`.

### SPINE Promotion: `attemptSPINEPromotion(agentId, timestamp)`

1. Load recent PCT+NCT entries (up to `SPINE_THRESHOLD × 4`)
2. Group by 8-char `topologyIndex` prefix
3. For any group with ≥ `SPINE_THRESHOLD` (3) entries:
   - Compute `patternSignature = sha256(sorted IDs).slice(0,16)`
   - Skip if SPINE entry with this signature already exists (deduplication)
   - Insert new SPINE entry with `linkedRecords = group IDs`

### Ghost Detection: `detectGhost(agentId, promptHash)`

A promptHash is a Ghost if it has appeared in PEER entries that are referenced by
two or more distinct SPINE entries (two distinct temporal threads).

Uses SQLite `json_each()` to query `linked_records_json` in a single query.
Falls back to in-memory filtering on older SQLite builds.

```sql
SELECT COUNT(DISTINCT s.entry_uuid) FROM dataquad_entries s
WHERE s.agent_id = $agentId AND s.tensor_type = 'SPINE'
AND EXISTS (
  SELECT 1 FROM dataquad_entries p
  JOIN json_each(s.linked_records_json) je ON je.value = p.entry_uuid
  WHERE p.tensor_type = 'PEER' AND p.prompt_hash = $promptHash
    AND p.agent_id = s.agent_id
)
```

If count ≥ 2, the pattern is classified Ghost.

---

## 4. Database Schema

Table: `dataquad_entries`

| Column                 | Type    | Purpose |
|------------------------|---------|---------|
| `id`                   | INTEGER | Auto-increment PK |
| `agent_id`             | TEXT    | FK → agents.id |
| `tensor_type`          | TEXT    | `PCT` \| `PEER` \| `NCT` \| `SPINE` |
| `timestamp`            | TEXT    | ISO 8601 |
| `content`              | TEXT    | Human-readable record |
| `sequence_json`        | TEXT    | Reserved for structured reflection data |
| `topology_index`       | TEXT    | sha256 prefix, clustering key |
| `entry_uuid`           | TEXT    | UUID v4 — cross-referenced in SPINE linked_records |
| `classification`       | TEXT    | PEER only: Noise \| Drift \| Ghost \| Glitch |
| `prompt_hash`          | TEXT    | PEER only: sha256:... of originating prompt |
| `fracture_virtues_json`| TEXT    | PEER only: JSON array of virtue names |
| `gate_path`            | TEXT    | PEER only: gate path observed |
| `linked_records_json`  | TEXT    | SPINE only: JSON array of linked entry_uuids |
| `verified_at`          | TEXT    | SPINE only: ISO 8601 promotion timestamp |
| `pattern_signature`    | TEXT    | SPINE only: sha256 dedup key |
| `archived`             | INTEGER | 0 = active, 1 = logically archived (never deleted) |

---

## 5. Append-Only Axiom

Every entry in `dataquad_entries` is permanent. No `DELETE` statements are issued
against DataQuad entries. The `archived` column is used for logical archival
(e.g., distillation — entries are marked `archived = 1` but never physically removed).

This axiom also applies to the JSONL gate log (`data/gate-logs/discernment-gate.jsonl`).

---

## 6. Migration Lineage

| Legacy name (snapshot) | Legacy name (DB) | Canonical name | Rationale |
|------------------------|-----------------|----------------|-----------|
| `temporal`             | `context`       | `PCT`          | Present Context Tensor — time-ordered observations |
| `affective`            | `affect`        | `PEER`         | Patterned Experiential Evidence Repository |
| `contextual`           | `memory`        | `NCT`          | Nostalgic Context Tensor — long-term memory |
| `reflective`           | `learning`      | `SPINE`        | Stabilized Patterned Interpretive Nexus of Evidence |

Migration SQL (idempotent, runs on every `initDatabase` call):
```sql
UPDATE dataquad_entries SET tensor_type = 'PCT'   WHERE tensor_type = 'context';
UPDATE dataquad_entries SET tensor_type = 'PEER'  WHERE tensor_type = 'affect';
UPDATE dataquad_entries SET tensor_type = 'NCT'   WHERE tensor_type = 'memory';
UPDATE dataquad_entries SET tensor_type = 'SPINE' WHERE tensor_type = 'learning';
```

Legacy `DataQuadSnapshot` interface and legacy field names in `loadAgentFromDb` are
preserved as backward-compat shims. They will be removed in a future cycle once all
callers have been updated to `DataQuadBundle`.

---

## 7. Key Files

| File | Role |
|------|------|
| `src/adapters/dataquad-schema.ts` | Type definitions for all four tensors and `DataQuadBundle` |
| `src/shared/main/dataquad-session.ts` | Session Manager — pre/post call orchestration |
| `src/shared/main/db/database.ts` | SQLite persistence + migration SQL |
| `src/shared/main/gate-logger.ts` | Append-only JSONL log; PEER/SPINE query functions |
| `src/adapters/openclaw-adapter.ts` | OpenClaw event → `DataQuadBundle` conversion |
| `src/shared/main/ids-processor.ts` | Gate + IDS pipeline; calls Session Manager |

---

## Canon Locked — v1.0 — 2026-03-18

Amendments are appended below. Prior content is never modified.
