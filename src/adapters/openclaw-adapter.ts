import { createHash } from 'crypto';

import { discernmentGate, GateResult, VirtueScores, createReturnPacket } from '../shared/main/discernment-gate';

import {
  DataQuadSnapshot, DataQuadBundle,
  PCTEntry, PEEREntry, NCTEntry, SPINEEntry,
} from './dataquad-schema';
import { IDSResult, runIDS } from '../shared/main/ids-processor';
import { tokenizeAndChunk } from '../shared/main/tokenization';
import { scoreHonesty } from '../shared/main/virtue-scoring-honesty';
import { scoreRespect } from '../shared/main/virtue-scoring-respect';
import { scoreAttention } from '../shared/main/virtue-scoring-attention';
import { scoreAffection } from '../shared/main/virtue-scoring-affection';
import { scoreLoyalty } from '../shared/main/virtue-scoring-loyalty';
import { scoreTrust } from '../shared/main/virtue-scoring-trust';
import { scoreCommunication } from '../shared/main/virtue-scoring-communication';
import {
  generateUUID,
  computeTopologyIndex,
  computePatternSignature,
  classifyPEERAnomaly,
} from '../shared/main/dataquad-session';

export interface OpenClawEvent {
  agentId: string;
  sessionId: string;
  requestId: string;
  prompt: string;
  toolIntent?: string;
  metadata?: Record<string, unknown>;
  dataquad?: Partial<DataQuadSnapshot>;
}

export interface OpenClawAdapterOptions {
  hashPrompt?: boolean;
}

export interface OpenClawLogEntry {
  ts: string;
  agent_id: string;
  session_id: string;
  request_id: string;
  gate: GateResult;
  ids?: IDSResult;
  input: {
    prompt_hash?: string;
    tool_intent?: string;
    metadata?: Record<string, unknown>;
  };
  dataquad: DataQuadSnapshot;        // legacy flat snapshot (preserved for compat)
  dataquad_bundle?: DataQuadBundle;  // rich per-entry bundle (new)
}

const emptyDataQuad: DataQuadSnapshot = {
  temporal: [],
  contextual: [],
  affective: [],
  reflective: [],
};

const hashPrompt = (prompt: string): string => {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
};

export const buildDataQuadSnapshot = (event: OpenClawEvent): DataQuadSnapshot => {
  return {
    temporal: event.dataquad?.temporal ?? emptyDataQuad.temporal,
    contextual: event.dataquad?.contextual ?? emptyDataQuad.contextual,
    affective: event.dataquad?.affective ?? emptyDataQuad.affective,
    reflective: event.dataquad?.reflective ?? emptyDataQuad.reflective,
  };
};

/**
 * Build a rich DataQuadBundle from an OpenClaw event.
 * Maps the legacy flat snapshot fields to PCT/PEER/NCT/SPINE per-entry objects.
 * If a peerEntry is provided (from gate classification), it is added to the PEER tensor.
 */
export const buildDataQuadBundle = (
  event: OpenClawEvent,
  peerEntry?: PEEREntry
): DataQuadBundle => {
  const now = new Date().toISOString();

  const pctEntries: PCTEntry[] = (event.dataquad?.temporal ?? []).map(s => ({
    id: generateUUID(),
    timestamp: now,
    content: s,
    topologyIndex: computeTopologyIndex(s, now),
  }));

  const peerEntries: PEEREntry[] = peerEntry ? [peerEntry] : [];

  const nctEntries: NCTEntry[] = (event.dataquad?.contextual ?? []).map(s => ({
    id: generateUUID(),
    timestamp: now,
    content: s,
    topologyIndex: computeTopologyIndex(s, now),
  }));

  const spineEntries: SPINEEntry[] = (event.dataquad?.reflective ?? []).map(s => {
    const id = generateUUID();
    return {
      id,
      timestamp: now,
      content: s,
      linkedRecords: [],
      verifiedAt: now,
      patternSignature: computePatternSignature([id]),
    };
  });

  return {
    PCT:   { entries: pctEntries },
    PEER:  { entries: peerEntries },
    NCT:   { entries: nctEntries },
    SPINE: { entries: spineEntries },
  };
};

export const buildOpenClawLogEntry = (
  event: OpenClawEvent,
  gate: GateResult,
  ids?: IDSResult,
  options: OpenClawAdapterOptions = {}
): OpenClawLogEntry => {
  const shouldHash = options.hashPrompt ?? true;

  return {
    ts: new Date().toISOString(),
    agent_id: event.agentId,
    session_id: event.sessionId,
    request_id: event.requestId,
    gate,
    ids,
    input: {
      prompt_hash: shouldHash ? hashPrompt(event.prompt) : undefined,
      tool_intent: event.toolIntent,
      metadata: event.metadata,
    },
    dataquad: buildDataQuadSnapshot(event),
  };
};

export const processOpenClawEvent = (
  event: OpenClawEvent,
  options: OpenClawAdapterOptions = {}
): OpenClawLogEntry => {
  const units = tokenizeAndChunk(event.prompt);
  const rawScores: VirtueScores = {
    Honesty: Math.min(...units.map(u => scoreHonesty(u))),
    Respect: Math.min(...units.map(u => scoreRespect(u))),
    Attention: Math.min(...units.map(u => scoreAttention(u))),
    Affection: Math.min(...units.map(u => scoreAffection(u))),
    Loyalty: Math.min(...units.map(u => scoreLoyalty(u))),
    Trust: Math.min(...units.map(u => scoreTrust(u))),
    Communication: Math.min(...units.map(u => scoreCommunication(u))),
  };

  const gate = discernmentGate(event.prompt, units, rawScores);
  const admitted = gate.path === 'admitted';

  const idsResult = runIDS(event.prompt, gate.path, gate.adjustedScores);

  const gateResult: GateResult = {
    admitted,
    payload: admitted
      ? event.prompt
      : createReturnPacket(event.prompt, gate.path as any, gate.adjustedScores, gate.fractureVirtues, idsResult),
  };

  // Build PEER entry for non-admitted paths
  let peerEntry: PEEREntry | undefined;
  if (!admitted) {
    const lowestScore = gate.fractureVirtues.length > 0
      ? Math.min(...(gate.fractureVirtues as any[]).map((f: any) => f.score))
      : 1.0;
    const promptHash = hashPrompt(event.prompt);
    const classification = classifyPEERAnomaly(gate.path, gate.fractureVirtues.length, lowestScore, false);
    peerEntry = {
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      content: `Gate fracture on path: ${gate.path}. Classification: ${classification}`,
      classification,
      promptHash,
      fractureVirtues: (gate.fractureVirtues as any[]).map((f: any) => f.virtue),
      gatePathObserved: gate.path,
    };
  }

  const logEntry = buildOpenClawLogEntry(event, gateResult, idsResult, options);
  logEntry.dataquad_bundle = buildDataQuadBundle(event, peerEntry);
  return logEntry;
};
