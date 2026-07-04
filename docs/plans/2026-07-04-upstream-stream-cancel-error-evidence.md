# Upstream Stream Cancellation And Error Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cover the remaining `sendMessage.streamEvidence` capture modes so real upstream cancellation and error-frame probes can produce safe aggregate fixture markers without storing raw stream content.

**Architecture:** Keep the existing opt-in `streamEvidence` gate and real-upstream marker requirement. Add runner-level tests for `cancel_after_first_delta` and `error_frame`; only adjust implementation if those tests expose gaps. Fixture sanitizer remains responsible for removing prompt, stream text, raw frame data, cookies, sessions, tokens, and real user data.

**Tech Stack:** Node.js ESM, native `node:test`, `ProtocolProbeRunner`, `buildProtocolProbeFixture()`, and `buildProtocolFixtureAudit({ scope:"upstream" })`.

---

### Task 1: RED Cancellation Capture Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Write the failing test**

Add `ProtocolProbeRunner captures async stream cancellation evidence without raw text`.

The test should:
- use a hydrated account and fake client returning real upstream `upstreamEvidence`;
- return `streamDeltas` as an async iterable that records yielded deltas and whether `return()` closed the generator;
- call `probeAccount({ operation:"sendMessage", input:{ stream:true, streamEvidence:{ mode:"cancel_after_first_delta", maxDeltas:2 } }, writeFixture:true })`;
- assert exactly one delta is consumed and the iterator is closed;
- assert the fixture has `result.upstreamEvidence.cancellation === true`;
- assert raw prompt, stream text, and session material are absent;
- assert `buildProtocolFixtureAudit({ scope:"upstream" })` marks cancellation ready.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "stream cancellation evidence"
```

Expected before a complete implementation: FAIL if cancellation mode is missing, over-consumes, does not close the iterator, or fails to mark upstream cancellation.

### Task 2: RED Error-Frame Capture Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Write the failing test**

Add `ProtocolProbeRunner captures async stream error-frame evidence without raw text`.

The test should:
- use a hydrated account and fake client returning real upstream `upstreamEvidence`;
- return `streamDeltas` as an async iterable that yields one private delta, then throws an error with safe protocol classification fields;
- include `raw:{ kind:"stream", format:"sse", async:true, events:[{ event:"error", data:"private error frame" }] }`;
- call `probeAccount({ operation:"sendMessage", input:{ stream:true, streamEvidence:{ mode:"error_frame", maxDeltas:2 } }, writeFixture:true })`;
- assert the probe status is `failed`;
- assert the fixture has `result.upstreamEvidence.streamErrorFrame === true`;
- assert raw prompt, stream text, raw frame data, and session material are absent;
- assert `buildProtocolFixtureAudit({ scope:"upstream" })` marks error-frame ready.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "stream error-frame evidence"
```

Expected before a complete implementation: FAIL if thrown async stream errors do not become sanitized failed fixtures with upstream error-frame markers.

### Task 3: Minimal Implementation

**Files:**
- Modify if needed: `src/protocol-probe.js`

**Step 1: Make cancellation pass**

Ensure `cancel_after_first_delta` consumes one delta, calls `iterator.return()` when available, and merges only `{ cancellation:true }` into `result.upstreamEvidence`.

**Step 2: Make error-frame pass**

Ensure `error_frame` catches async iterator errors, merges only `{ streamErrorFrame:true }`, finalizes the probe as failed, and lets the fixture sanitizer redact error text, raw frame data, and delta text.

### Task 4: Documentation

**Files:**
- Modify: `docs/08-测试用例.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/plans/2026-07-04-upstream-stream-cancel-error-evidence.md`

**Step 1: Document coverage**

State that cancellation/error-frame capture is still opt-in, bounded, and marker-only. It helps create safe fixtures from real async streams but does not by itself provide real Tabbit samples.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "stream cancellation evidence"
node --test test\protocol-probe.test.js --test-name-pattern "stream error-frame evidence"
node --test test\protocol-probe.test.js --test-name-pattern "bounded async stream backpressure"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files. Expected: no sensitive path edits and no raw credential shapes in added lines.

## Execution status

- Task 1 cancellation test added and verified: `cancel_after_first_delta` consumes one delta, closes the iterator, writes `cancellation:true`, and keeps fixture output sanitized.
- Task 2 error-frame test added as RED: existing implementation leaked the async iterator error message into fixture `error.message`.
- Task 3 implementation fixed in `src/protocol-probe.js`: error-frame capture now uses a fixed safe message while preserving category/code/status.
- Focused GREEN checks run after implementation:
  - `node --test test\protocol-probe.test.js --test-name-pattern "stream cancellation evidence"` -> pass
  - `node --test test\protocol-probe.test.js --test-name-pattern "stream error-frame evidence"` -> pass
  - `node --test test\protocol-probe.test.js --test-name-pattern "bounded async stream backpressure"` -> pass

### Final Gate Evidence - 2026-07-04

- Startup aggregate checks:
  - `git rev-parse HEAD` -> `d2bd5ff477fd6134874d78c35dedc79cb577700b`
  - `node bin\tabbit-pool.js readiness doctor --json` with configured send/session paths -> blocked because the default state dir has 0 calibration fixtures.
  - `node bin\tabbit-pool.js fixtures audit --scope session --json` -> blocked; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and `automated_session_refresh_strategy`.
  - `node bin\tabbit-pool.js fixtures audit --scope upstream --json` -> blocked; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
- Regression checks:
  - `node --test test\ops-cli.test.js` -> 106/106 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `node --test test\protocol-probe.test.js` -> 28/28 pass.
  - `npm test` -> 406/406 pass.
- Diff and safety checks:
  - `git diff --check` -> pass; Windows line-ending warnings only.
  - Forbidden-path scan over tracked and untracked changed paths -> `scannedPaths=21`, `forbiddenHits=0`.
  - Credential-shape scan over added diff and untracked plan docs -> `scannedAddedOrUntrackedLines=1723`, `credentialShapeHits=0`.

No raw stream text, prompt, payload, cookie, session, token, bearer credential, browser profile, local state fixture, or real user data was printed or persisted by this increment.
