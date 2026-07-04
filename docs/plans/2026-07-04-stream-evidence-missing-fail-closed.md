# Stream Evidence Missing Fail Closed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make explicit `sendMessage.streamEvidence` probes fail closed when the requested real upstream stream boundary evidence was not actually captured.

**Architecture:** Keep ordinary `sendMessage` probes unchanged. When `streamEvidence` is present, `ProtocolProbeRunner` must require a real Tabbit async stream marker and the requested aggregate marker. If the marker, async stream, error frame, cancellation, or two-delta backpressure evidence is missing, the probe writes a sanitized failed fixture with a stable `STREAM_EVIDENCE_NOT_CAPTURED` code instead of returning a misleading success.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolProbeRunner`, `buildProtocolFixtureAudit({ scope:"upstream" })`, and Markdown docs.

---

### Task 1: RED Missing Marker Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Write the failing test**

Add `ProtocolProbeRunner fails streamEvidence probes without a real async upstream marker`.

The fake `sendMessage` result should return `ok:true`, stream metadata, and an async iterator, but no `upstreamEvidence:{ source:"tabbit-live", real:true, stream:true }`.

Expected:
- `result.status === "failed"`;
- written fixture has `error.code === "STREAM_EVIDENCE_NOT_CAPTURED"`;
- audit does not count real upstream evidence;
- raw prompt, session, and stream text are absent.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "without a real async upstream marker"
```

Expected before implementation: FAIL because the probe currently returns success.

### Task 2: RED Incomplete Backpressure Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Write the failing test**

Add `ProtocolProbeRunner fails backpressure streamEvidence when the second delta is missing`.

The fake `sendMessage` result should include the real upstream marker but only yield one async delta before completion.

Expected:
- `result.status === "failed"`;
- written fixture has `error.code === "STREAM_EVIDENCE_NOT_CAPTURED"`;
- no `backpressure`, `firstTokenFlush`, or `delayedSecondChunk` marker is written;
- raw text and session material are absent.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "second delta is missing"
```

Expected before implementation: FAIL because the probe currently returns success without the requested marker.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/protocol-probe.js`

**Step 1: Fail closed for missing capture prerequisites**

If `streamEvidence` is present but the result is not a real Tabbit async stream, return `protocolError("stream evidence was requested but not captured", { category:"protocol_changed", code:"STREAM_EVIDENCE_NOT_CAPTURED" })`.

**Step 2: Fail closed for incomplete mode-specific evidence**

- `first_token_backpressure`: require at least two deltas.
- `cancel_after_first_delta`: require at least one delta and successful iterator cancellation.
- `error_frame`: require an async stream throw/error frame.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document failure semantics**

State that `streamEvidence` probes fail with `STREAM_EVIDENCE_NOT_CAPTURED` when the requested aggregate evidence is not captured, and that such failed fixtures are safe and do not persist raw stream text.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "streamEvidence|bounded async stream|cancellation evidence|error-frame evidence"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files.

---

## Execution Status - 2026-07-04

- RED verified:
  - `node --test test\protocol-probe.test.js --test-name-pattern "without a real async upstream marker"` failed because the streamEvidence probe returned `success`.
  - `node --test test\protocol-probe.test.js --test-name-pattern "second delta is missing"` failed because incomplete backpressure evidence returned `success`.
- GREEN implementation:
  - `src/protocol-probe.js` now returns a sanitized `STREAM_EVIDENCE_NOT_CAPTURED` error when explicit stream evidence is requested but not captured.
  - Existing successful backpressure, cancellation, and error-frame capture paths remain green.
- Documentation:
  - README, real protocol acceptance docs, and M08 ops docs document fail-closed streamEvidence behavior.
