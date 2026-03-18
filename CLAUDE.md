# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install           # install dependencies
npm test              # run all Jest tests
npm run test:watch    # run tests in watch mode
npm run typecheck     # type-check without emitting
npm run build         # compile main (tsc) + renderer (vite build)
npm run gate "prompt" # test a prompt through the CLI gate
npm run dev           # full dev mode: vite renderer + tsc watch + electron
npm run gui           # build then open Electron GUI
npm run steward       # run the OpenClaw sidecar server (port 3636)
```

To run a single test file:
```bash
npx jest src/shared/main/discernment-gate.test.ts
```

## Architecture

This is a **TypeScript/Electron** project structured as three layers:

### 1. Core Library (`src/shared/main/`, `src/adapters/`, `src/index.ts`)
The public npm package surface. Entry point is `src/index.ts`.

**Pipeline order** (canonical — must not be reordered):
1. `gate-logger.ts` — PEER_CAPTURE (SHA-256 hash of raw input, before any processing)
2. `tokenization.ts` — raw string → `Unit[]` objects
3. `virtue-scoring-*.ts` — seven deterministic scorers, each returns 0.0–1.0
4. `ids-processor.ts` — IDS pipeline: Identify → Define → Suggest (runs on ALL inputs)
5. `discernment-gate.ts` — applies tolerance band, counts fractures, routes to `admitted` / `shallow-return` / `deep-return` / `quarantine`
6. `reflection-engine.ts` — IDR or IDQRA reflection sequences for returned prompts
7. `adapters/dataquad-schema.ts` — DataQuad-compliant persistence
8. `adapters/openclaw-adapter.ts` + `adapters/openclaw-ingest.ts` — OpenClaw event integration

**Routing paths:**
- 0 fractures → `admitted`
- 1 fracture, score ≥ 0.7 → `quarantine`
- 1 fracture, score < 0.7 → `shallow-return`
- 2+ fractures → `deep-return`

### 2. Electron Main Process (`src/main/`)
`main.ts` — creates the BrowserWindow, registers all `ipcMain.handle` channels (`aegis:processPrompt`, `aegis:fetchStewardLogs`, `aegis:selectWorkspace`, `aegis:readWorkspaceFile`, `aegis:writeWorkspaceFile`, `aegis:executeTerminal`, `aegis:saveAgent`, `aegis:loadAgent`, `aegis:getMetrics`, etc.). Workspace file writes automatically create backups in `.aegis/backups/`.

`ids.ts` — thin wrapper called by the IPC `aegis:processPrompt` handler.

`preload.ts` — contextBridge exposing `window.aegis` to the renderer.

`db/database.ts` — SQLite via `better-sqlite3`, used for agent persistence and system metrics.

### 3. Renderer (`src/renderer/`)
Vite + React, served on `localhost:3000` in dev mode. Root component is `Dashboard.tsx`. Components include: `AgenticIDE`, `SwarmManager`, `MirrorPrimeDashboard`, `QuarantineHUD`, `CrucibleLogs`, `OpenClawSidecar`, and others.

Communicates with the main process exclusively through `window.aegis.*` (the preload bridge) — never import Node/Electron APIs directly in renderer files.

### 4. CLI (`src/cli/`)
- `index.ts` — `npm run gate` entry point
- `steward-server.ts` — Express sidecar server (`npm run steward`)
- `mirror-prime.ts` — primed during `npm run dev`

## Canonical Rules (from `.agent/rules/aegis-bm-rules.md`)

These apply to all code and documentation in this repo:

**Forbidden words** — never use these; use the replacements instead:
| Forbidden | Use instead |
|-----------|-------------|
| `enforce` | `maintain`, `preserve`, `sustain` |
| `mandate` | `require the presence of` |
| `evaluate` | `observe`, `reflect`, `surface` |
| `reject` | `return` (inputs) / `route` (logic) |
| `coercive` | `containing force-pattern indicators` |
| `correctly` | the specific criterion |
| `guide toward` | `surface awareness of` |
| `require alignment` | `observe alignment patterns` |

**Non-force posture** — all outputs are observations or optional offerings. No output directs or compels action.

**Append-only** — audit records and memory are additive only; nothing is deleted or overwritten.

**IDS is universal** — every input must produce an `IDSResult`. No gate result may be emitted without one attached.

**UI severity signaling** — UI must not use colour, icon, or label to imply pass/fail or good/bad. Single-hue luminance/saturation variation is permitted; hue variation correlated with integrity scores is not.

**Test discipline** — architectural changes require Jest tests with the issue ID in the `describe` name: `describe('I-XX: ...', ...)`. Tests live adjacent to the modified file.

## Agent Workflow Cycle

The `.agent/` directory contains structured cycle records used by the Build Master agent team. The canonical cycle order is:

`BM-OBS-OPEN` → `BM-DIAG` → `BM-DEV` → `BM-QA` → `BM-ARCH` + `BM-SEC` (parallel) → `BM-OBS-CLOSE`

Cycle records follow the naming pattern `cycle-N-<role>-<type>.md`. OBS-OPEN and OBS-CLOSE are load-bearing checkpoints — a cycle cannot start or close without them.

## Key Files

| File | Purpose |
|------|---------|
| `src/shared/types.ts` | Canonical shared types: `VirtueScores`, `ReturnPacket`, `IDSResult`, `GovernancePolicy`, `AgentEvent`, `IDSPath` |
| `src/shared/main/discernment-gate.ts` | Core gate logic; `TOLERANCE_BAND = 0.10` |
| `src/shared/main/ids-processor.ts` | IDS three-phase pipeline |
| `src/shared/main/reflection-engine.ts` | IDR (deep) and IDQRA (shallow) reflection sequences |
| `src/shared/main/gate-logger.ts` | PEER tensor — JSONL append-only log with SHA-256 hashing |
| `src/adapters/dataquad-schema.ts` | DataQuad JSON schema and validation |
| `scripts/docs/AEGIS Canon (Locked).md` | Canonical axioms and locked specifications |
| `.agent/rules/aegis-bm-rules.md` | Build master canonical rules (authoritative) |
| `.aegis/.daemon_token` | Daemon authentication token (runtime, not committed) |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AEGIS_ADAPTER_LOG_DIR` | `./data/adapter-logs` | OpenClaw JSONL log directory |
| `AEGIS_PRIME_URL` | `http://localhost:8888` | Mirror Prime sidecar URL |
| `NODE_ENV` | — | Set to `development` for Electron dev mode |
