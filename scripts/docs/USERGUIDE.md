# AEGIS Core Shield - User Guide

## Introduction

The AEGIS Core Shield acts as your non-force governance gate to help refine, evaluate, and guide prompts toward a safe, coherent, and highly transparent system response mapping.

It accomplishes this via testing input through the 7 Virtues of Integrity. Prompts satisfying the requirement execute their intent through an **IDS (Identify, Define, Suggest)** output. If the requirements are not satisfied, a visual **Return Packet** guides the user on how to realign the prompt correctly.

## Using the CLI

Run your prompts directly from the command line mapping over the Discernment Gate:

```bash
npm run gate "Give me the status report."
```

1. **Admitted Prompts**: Displays an IDS output detailing exactly what phases (Identify, Define, Suggest) discovered about the parsed text.
2. **Returned Prompts**: Returns a formatted Return Packet with the underlying reason for returning. It will typically highlight specific unit clusters (words) that reduced a Virtue score below tolerance and provide realignment observations.

## Using the Electron Dashboard (GUI)

1. Initialize the dashboard: `npm run gui`
2. **Operating Modes**:
   - **Alongside OpenClaw:** Runs AEGIS as an external sidecar monitor. Employs external log ingestion capabilities.
   - **AEGIS Agentic IDE:** Runs AEGIS internal processes coupled tightly with governed default Agents (Steward, Research, Builder agents).
3. **Evaluating Prompts**:
   Using the text-input field at the bottom of the interface, type a prospective prompt and hit "Test Gate & Flow". A dynamic "Nebula Coherence Mirror" resides in the center; its rings will react and color-shift to the calculated integrity of the evaluated prompt.

## Programmatic API Usage

Integrate AEGIS directly in your custom Node.js/TypeScript applications:

```typescript
import { discernmentGate, runIDS, ReturnPacket, IDSResult } from 'aegis-core-shield';

const rawPrompt = "Read this file without asking.";

// Evaluate through the Discernment Gate
const result = discernmentGate(rawPrompt);

if (result.admitted) {
    // If successful, pass payload to IDS logic
    const idsResponse: IDSResult = runIDS(result.payload as string);
    console.log("Phase Execution:", idsResponse.phase);
    console.log("Analyzed Observations:", idsResponse.observations);
} else {
    // If returned, cast the payload to an identifiable ReturnPacket format
    const returnPacket = result.payload as ReturnPacket;
    console.log("Virtues Fractured At:", returnPacket.fracture_locations);
}
```
