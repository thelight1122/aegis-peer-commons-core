// ── Legacy snapshot (preserved for backward compat) ────────────────────────
/** @deprecated Use DataQuadBundle. Kept for OpenClaw serialization compat. */
export interface DataQuadSnapshot {
  temporal: string[];
  contextual: string[];
  affective: string[];
  reflective: string[];
}

// ── PCT/PEER/NCT/SPINE — Rich per-entry interfaces ──────────────────────────

/** Base entry shared by all four tensors */
export interface DataQuadEntry {
  id: string;        // UUID v4, generated at write time
  timestamp: string; // ISO 8601
  content: string;   // human-readable observation/record
}

// PCT – Present Context Tensor
// Immediate observational records. Always delivered in full to the model.
// Maps from: temporal (snapshot) / context (DB)
export interface PCTEntry extends DataQuadEntry {
  topologyIndex?: string; // sha256 fingerprint, 12-char prefix
}

// PEER – Patterned Experiential Evidence Repository
// Anomaly log with four-class classification. Append-only JSONL + DB.
// Maps from: affective (snapshot) / affect (DB)
export type PEERClassification = 'Noise' | 'Drift' | 'Ghost' | 'Glitch';

export interface PEEREntry extends DataQuadEntry {
  classification: PEERClassification;
  promptHash: string;          // sha256:... of the originating prompt
  fractureVirtues?: string[];  // virtue names that caused fracture
  gatePathObserved?: string;   // admitted | shallow-return | deep-return | quarantine
}

// NCT – Nostalgic Context Tensor
// Long-term pattern memory. Queried by topology proximity.
// Maps from: contextual (snapshot) / memory (DB)
export interface NCTEntry extends DataQuadEntry {
  topologyIndex: string;    // required for NCT (pattern matching key)
  sequenceData?: unknown;   // reserved for structured reflection data
}

// SPINE – Stabilized Patterned Interpretive Nexus of Evidence
// Append-only verified patterns with temporal threading.
// Maps from: reflective (snapshot) / learning (DB)
export interface SPINEEntry extends DataQuadEntry {
  linkedRecords: string[];   // IDs of PCT/PEER/NCT entries that compose this pattern
  verifiedAt: string;        // ISO 8601 — when the threshold was reached
  patternSignature: string;  // sha256 of sorted linkedRecords — dedup key
}

// Unified bundle replacing DataQuadSnapshot for internal use
export interface DataQuadBundle {
  PCT: { entries: PCTEntry[] };
  PEER: { entries: PEEREntry[] };
  NCT: { entries: NCTEntry[] };
  SPINE: { entries: SPINEEntry[] };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Draft JSON Schema for DataQuad snapshots.
 * Kept as a plain object to avoid adding external validation dependencies.
 */
export const DATAQUAD_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://aegis-core-shield.dev/schemas/dataquad-snapshot.json',
  title: 'DataQuadSnapshot',
  type: 'object',
  additionalProperties: false,
  required: ['temporal', 'contextual', 'affective', 'reflective'],
  properties: {
    temporal: {
      type: 'array',
      items: { type: 'string' },
      description: 'Time-ordered events, intervals, or recurrence markers',
    },
    contextual: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workspace, dependency, and tool-context signals',
    },
    affective: {
      type: 'array',
      items: { type: 'string' },
      description: 'Affect or sentiment resonance markers',
    },
    reflective: {
      type: 'array',
      items: { type: 'string' },
      description: 'Self-observed outcomes, lessons, and constraints',
    },
  },
} as const;

const REQUIRED_KEYS: ReadonlyArray<keyof DataQuadSnapshot> = [
  'temporal',
  'contextual',
  'affective',
  'reflective',
];

export const isDataQuadSnapshot = (value: unknown): value is DataQuadSnapshot => {
  return validateDataQuadSnapshot(value).valid;
};

export const validateDataQuadSnapshot = (value: unknown): ValidationResult => {
  const errors: string[] = [];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['DataQuad must be an object'] };
  }

  const recordValue = value as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in recordValue)) {
      errors.push(`Missing required field: ${key}`);
      continue;
    }

    const fieldValue = recordValue[key];
    if (!Array.isArray(fieldValue)) {
      errors.push(`Field ${key} must be an array`);
      continue;
    }

    if (!fieldValue.every((item) => typeof item === 'string')) {
      errors.push(`Field ${key} must only contain strings`);
    }
  }

  const unexpectedKeys = Object.keys(recordValue).filter(
    (key) => !REQUIRED_KEYS.includes(key as keyof DataQuadSnapshot)
  );

  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected fields: ${unexpectedKeys.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};
