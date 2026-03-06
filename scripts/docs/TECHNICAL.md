# AEGIS Core Shield - Technical Documentation

## Architecture Overview

The AEGIS Core Shield evaluates inputs (prompts) through a multi-stage validation system consisting of a Tokenizer, a set of Virtue Scorers, a Discernment Gate, and finally the IDS Pipeline.

```text
Raw Prompt → Tokenization → Seven Virtue Scoring → Discernment Gate
  [If Integrity = 1.0] → Admitted → IDS Pipeline (Identify, Define, Suggest) → Output
  [If Integrity < 1.0] → Returned → Return Packet (Fracture observations, alignment suggestions)
```

## System Components

### 1. Tokenization (`src/shared/main/tokenization.ts`)

Translates input strings into structured `Unit` objects. It is capable of detecting and isolating compound phrases along with individual words.

### 2. Seven Virtue Scorers (`src/shared/main/virtue-scoring-*.ts`)

Deterministic, rule-based scoring modules that evaluate tokenized units from 0.0 to 1.0 across seven distinct virtues:

- Honesty
- Respect
- Attention
- Affection
- Loyalty
- Trust
- Communication

### 3. Discernment Gate (Prism) (`src/shared/main/discernment-gate.ts`)

Computes the final binary Integrity value.
It applies a fixed `TOLERANCE_BAND` (default: 0.10) to all Virtue Scores, meaning any Virtue score ≥ 0.90 is rounded to 1.0.
**Binary Integrity Formula:** `Integrity = Object.values(adjustedScores).every(s => s === 1.0) ? 1 : 0;`

For inputs that do not pass, an observation-only **Return Packet** is generated mapping specific words (units) to fractured virtues. No judgments or directives are issued.

### 4. IDS Processing Pipeline (`src/shared/main/ids-processor.ts`)

A three-phase execution abstraction that executes only on admitted inputs:

- **Identify:** Utilizes heuristic pattern matching to observe length, detect imperative vs descriptive constraints, and extract entities.
- **Define:** Explains the structural composition and outlines the context of the user request (e.g., entity-centric inquiry, directive proposal).
- **Suggest:** Produces "optional, non-forced pathways" available for the system to execute, ensuring instructions remain observative.

### 5. Gate Logger (PEER Tensor) (`src/shared/main/gate-logger.ts`)

Persistent logging mechanism writing observations to a JSONL file format, establishing the Present Experiential Emotional Record (PEER). Uses SHA-256 to hash input contents, preserving immutable audit logs. It acts as an append-only contextual tensor without authority or deletion capabilities.

### 6. Stewarding & OpenClaw Ingestion (`src/adapters`)

Bridging integrations designed for OpenClaw agents. `openclaw-adapter.ts` maps OpenClaw events into the core AEGIS engine, persisting to DataQuad compliant schemas via `dataquad-schema.ts`. Employs an Express server `steward-server.ts` running locally (default port 3636) to continuously ingest log events. Employs SSSP (Stable State Snapshot Protocol) to capture pre-escalation configurations.

### 7. Electron Renderer GUI (`src/renderer`)

React GUI layer designed closely with styling modules (`Dashboard.css`). The main piece, `Dashboard.tsx`, constructs standard application interfaces featuring a dynamically colored "Nebula Vision" mirroring system depending on calculated coherence and virtue fractures. Includes governance toggles for Custodian Agent operations.
