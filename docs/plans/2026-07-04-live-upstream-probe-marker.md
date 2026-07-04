# Live Upstream Probe Marker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure real `ProtocolProbeRunner` sendMessage fixtures can carry a safe live-upstream evidence marker for upstream audit without making generic fake stream fixtures count as calibrated Tabbit evidence.

**Architecture:** Keep the stricter upstream audit gate from `2026-07-04-upstream-explicit-marker-gate.md`. Add marker generation only in the real restored `/api/v1/chat/completion` async SSE/NDJSON branch, then rely on the existing fixture sanitizer and runner write path to preserve that safe marker. Do not infer real upstream evidence from `kind:"protocol_probe"` or stream metadata alone.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolProbeRunner`, `buildProtocolProbeFixture()`, and `buildProtocolFixtureAudit({ scope:"upstream" })`.

---

### Task 1: RED Restored Stream Marker Test

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Extend `sendMessage returns async streamDeltas before the upstream stream completes`.

The test should:
- use restored send path `/api/v1/chat/completion`;
- make `sendMessage({ stream:true, chatSessionId, model:"tabbit/priority" })` return before the stream completes;
- assert the result contains `upstreamEvidence:{ source:"tabbit-live", real:true, stream:true, format:"sse" }`;
- assert the marker does not contain cookie or prompt text.

**Step 2: Run RED**

```powershell
node --test test\protocol-tabbit-client.test.js --test-name-pattern "returns async streamDeltas"
```

Expected: FAIL before implementation because restored async stream results do not include `upstreamEvidence`.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/protocol-tabbit-client.js`

**Step 1: Add safe marker generation**

When `sendMessage()` uses the restored `/api/v1/chat/completion` branch and returns an async SSE/NDJSON stream, attach `upstreamEvidence:{ source:"tabbit-live", real:true, stream:true, format }`.

**Step 2: Avoid broad inference**

Do not add markers to old explicit sendPath, local/fake streams, or generic protocol probe fixtures.

### Task 3: Audit Integration Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Extend the test**

After writing the fixture, call `buildProtocolFixtureAudit({ scope:"upstream", fixtures:[storedFixture] })` or add a small companion assertion that the resulting marker shape is compatible with the existing upstream audit predicate.

**Step 2: Run GREEN**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "upstream evidence markers"
```

Expected: PASS.

### Task 4: Documentation

**Files:**
- Modify: `docs/06-数据字典.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`

**Step 1: Document marker source**

Document that `ProtocolTabbitClient` adds `result.upstreamEvidence` only for restored live async streams, and `ProtocolProbeRunner` preserves that sanitized marker in written fixtures; generic stream fixtures still do not count.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "upstream evidence markers"
node --test test\observability.test.js --test-name-pattern "explicit upstream marker|upstream stream boundary"
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

---

## Execution Status - 2026-07-04

Completed for this increment.

### RED Evidence

- `node --test test\protocol-tabbit-client.test.js --test-name-pattern "returns async streamDeltas"` failed before implementation because the restored async stream result had `upstreamEvidence === undefined`.

### GREEN Implementation

- `src/protocol-tabbit-client.js` now attaches safe `upstreamEvidence:{ source:"tabbit-live", real:true, stream:true, format }` only for restored `/api/v1/chat/completion` async SSE/NDJSON results.
- `ProtocolProbeRunner` already preserves sanitized `result.upstreamEvidence`; `test/protocol-probe.test.js` now verifies the runner fixture can be accepted by `buildProtocolFixtureAudit({ scope:"upstream" })` without leaking prompt, stream text, session, cookie, token, or user data.

### Documentation

- README, data dictionary, API reference, real protocol acceptance docs, M08 ops docs, test-case docs, and development tracking now document the marker boundary.

### Verification Evidence

- Focused, full regression, diff, forbidden-path, and credential-shape scans are tracked in the final turn summary for this increment.
