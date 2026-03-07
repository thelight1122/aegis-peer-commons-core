// src/main/discernment-gate.ts
// Purpose: Core Discernment Gate – complete v0.1 implementation
// Assembles: tokenization → Honesty scoring → tolerance → binary Integrity → branch → return packet
// Locked invariants: observation-only, agency preserved, all-or-nothing Integrity, append-only logging
// Run: import and call discernmentGate(prompt) from CLI/GUI/API

import { Unit, tokenizeAndChunk } from './tokenization';
import { scoreHonesty } from './virtue-scoring-honesty';
import { scoreRespect } from './virtue-scoring-respect';
import { scoreAttention } from './virtue-scoring-attention';
import { scoreAffection } from './virtue-scoring-affection';
import { scoreLoyalty } from './virtue-scoring-loyalty';
import { scoreTrust } from './virtue-scoring-trust';
import { scoreCommunication } from './virtue-scoring-communication';
import { initGateLogger, logGateEvaluation, GateLogEntry } from './gate-logger';
import { processIDR, processIDQRA } from './reflection-engine';
import * as crypto from 'crypto';

export interface VirtueScores {
  Honesty: number;
  Respect: number;
  Attention: number;
  Affection: number;
  Loyalty: number;
  Trust: number;
  Communication: number;
  [key: string]: number;  // Allow indexing by string for logger compatibility
}

export interface GateResult {
  admitted: boolean;
  payload: string | ReturnPacket;
}

import { ReflectionSequence } from './reflection-engine';
import type { IDSResult } from './ids-processor';

export interface ReturnPacket {
  source: 'IDS'; // I-06
  status: 'discernment_gate_return';
  path: 'shallow-return' | 'deep-return'; // I-08
  depth: 'shallow' | 'deep'; // I-08
  integrity: 0;
  message: string;
  observed_alignment: Record<string, { score: number; passed_tolerance: boolean; min_unit?: string }>;
  fracture_locations: Array<{ unit: string; virtues_affected: string[]; observation: string }>;
  realignment_observations: string[];
  original_prompt: string;
  action_taken: 'none – prompt not processed further';
  reflection_sequence?: ReflectionSequence;
  ids_observations: IDSResult; // I-06
}

// Config (append-only – add new constants below if needed)
const TOLERANCE_BAND = 0.10;  // 10% tolerance for non-force context

export type IDSPath = 'admitted' | 'shallow-return' | 'deep-return';

export function discernmentGate(raw: string, units: Unit[], scores: VirtueScores): {
  path: IDSPath,
  integrity: number,
  adjustedScores: VirtueScores,
  fractureVirtues: any[]
} {
  // Apply tolerance band
  const adjustedScores: VirtueScores = {} as VirtueScores;
  for (const [virtue, score] of Object.entries(scores)) {
    adjustedScores[virtue as keyof VirtueScores] = score >= 1 - TOLERANCE_BAND ? 1.0 : score;
  }

  // Count fractures
  const fractureVirtues = Object.entries(adjustedScores)
    .filter(([_, score]) => score < 1.0)
    .map(([virtue, score]) => {
      let minUnit = '(not located)';
      let minScore = 1.0;
      units.forEach(u => {
        let uScore = 1.0;
        // Logic to find min unit for this virtue
        switch (virtue) {
          case 'Honesty': uScore = scoreHonesty(u); break;
          case 'Respect': uScore = scoreRespect(u); break;
          case 'Attention': uScore = scoreAttention(u); break;
          case 'Affection': uScore = scoreAffection(u); break;
          case 'Loyalty': uScore = scoreLoyalty(u); break;
          case 'Trust': uScore = scoreTrust(u); break;
          case 'Communication': uScore = scoreCommunication(u); break;
        }
        if (uScore < minScore) {
          minScore = uScore;
          minUnit = u.text;
        }
      });
      return { virtue, score, minUnit };
    });

  const n = fractureVirtues.length;
  const path: IDSPath = n === 0 ? 'admitted' : n === 1 ? 'shallow-return' : 'deep-return';
  const integrity = n === 0 ? 1 : 0;

  return { path, integrity, adjustedScores, fractureVirtues };
}

export function createReturnPacket(
  raw: string,
  path: 'shallow-return' | 'deep-return',
  adjustedScores: VirtueScores,
  fractureVirtues: any[],
  idsResult: IDSResult
): ReturnPacket {
  const lowestScore = Math.min(...fractureVirtues.map(f => f.score));
  const sequenceProcessor = lowestScore < 0.5 ? processIDR : processIDQRA;
  const reflectionSequence = sequenceProcessor(
    fractureVirtues.map(f => f.minUnit).join(' | '),
    [raw]
  );

  return {
    source: 'IDS',
    status: 'discernment_gate_return',
    path,
    depth: path === 'shallow-return' ? 'shallow' : 'deep',
    integrity: 0,
    message: 'Resonance not fully achieved. Prompt returned for optional realignment.',
    observed_alignment: Object.fromEntries(
      Object.entries(adjustedScores).map(([v, s]) => [
        v,
        { score: s, passed_tolerance: s >= 1 - TOLERANCE_BAND, min_unit: s < 1 ? fractureVirtues.find(f => f.virtue === v)?.minUnit : undefined }
      ])
    ),
    fracture_locations: fractureVirtues.map(f => ({
      unit: f.minUnit,
      virtues_affected: [f.virtue],
      observation: `score below threshold after tolerance (${f.score.toFixed(2)})`,
    })),
    realignment_observations: fractureVirtues.map(f =>
      `For ${f.virtue}: consider reviewing phrasing where minimum score occurred`
    ),
    original_prompt: raw,
    action_taken: 'none – prompt not processed further',
    reflection_sequence: reflectionSequence,
    ids_observations: idsResult
  };
}

// Cryptographic hash for prompt logging (SHA-256)
function createPromptHash(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
}

// Initialize logger on module load
initGateLogger();