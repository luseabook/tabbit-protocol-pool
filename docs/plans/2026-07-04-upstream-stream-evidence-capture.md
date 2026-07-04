# Upstream Stream Evidence Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a real `sendMessage` protocol probe capture safe upstream stream-boundary evidence markers from an async stream without persisting raw stream text, prompt, cookies, sessions, tokens, or payloads.

**Architecture:** Keep normal `probe protocol --operation sendMessage` behavior unchanged. Add an explicit, opt-in `streamEvidence` input object for `sendMessage` probes. When enabled and the protocol client returns an async `streamDeltas` result with real upstream marker, `ProtocolProbeRunner` consumes only a bounded number of deltas and preserves aggregate booleans such as `backpressure`, `firstTokenFlush`, `delayedSecondChunk`, `cancellation`, or `streamErrorFrame`; the existing fixture sanitizer still redacts stream text and raw frame data.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolProbeRunner`, `buildProtocolProbeFixture()`, `buildProtocolFixtureAudit({ scope:"upstream" })`, and `probe validate` schema checks.

---

### Task 1: RED ProtocolProbeRunner Backpressure Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Write the failing test**

Add `ProtocolProbeRunner captures bounded async stream backpressure evidence without raw text`.

The test should:
- use a hydrated account and fake client returning `streamDeltas` as an async iterable;
- return `upstreamEvidence:{ source:"tabbit-live", real:true, stream:true, format:"sse" }` and `raw:{ kind:"stream", format:"sse", async:true, events:[] }`;
- call `probeAccount({ operation:"sendMessage", input:{ stream:true, streamEvidence:{ mode:"first_token_backpressure", maxDeltas:2 } }, writeFixture:true })`;
- assert exactly two deltas are consumed;
- assert the written fixture has `result.upstreamEvidence.backpressure === true`, `firstTokenFlush === true`, and `delayedSecondChunk === true`;
- assert raw prompt, stream text, and session material are absent;
- assert `buildProtocolFixtureAudit({ scope:"upstream" })` marks backpressure ready.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "bounded async stream backpressure"
```

Expected: FAIL before implementation because `ProtocolProbeRunner` does not consume async streams or add boundary markers.

### Task 2: RED Cancellation/Error Input Validation

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write schema tests**

Add `probe validate --operation sendMessage accepts streamEvidence capture options` and invalid input cases.

Expected accepted shape:

```json
{
  "model": "tabbit/priority",
  "messages": [{ "role": "user", "content": "<redacted-message-content>" }],
  "stream": true,
  "streamEvidence": {
    "mode": "first_token_backpressure",
    "maxDeltas": 2
  }
}
```

Invalid cases:
- `streamEvidence.mode` not one of `first_token_backpressure`, `cancel_after_first_delta`, `error_frame`;
- `maxDeltas` not a positive integer or greater than 5.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "streamEvidence"
```

Expected: FAIL before implementation because schema preview does not understand `streamEvidence`.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/protocol-probe.js`
- Modify: `src/ops-cli.js`

**Step 1: Add streamEvidence validation**

Validate `sendMessage.streamEvidence` as an object with:
- `mode`: `first_token_backpressure`, `cancel_after_first_delta`, or `error_frame`;
- optional `maxDeltas`: integer 1..5, default 2.

**Step 2: Add bounded async capture**

After `client.sendMessage()` returns a success result:
- if `operation === "sendMessage"`, `input.streamEvidence` is valid, and `result.streamDeltas` is async iterable, consume at most `maxDeltas`;
- do not store consumed delta values outside the existing redacted `streamDeltas` path;
- merge only safe booleans into `result.upstreamEvidence`.

Mode behavior:
- `first_token_backpressure`: mark `backpressure:true`, `firstTokenFlush:true`, `delayedSecondChunk:true` when two deltas are observed;
- `cancel_after_first_delta`: call iterator `return()` after the first delta and mark `cancellation:true`;
- `error_frame`: if iteration throws after at least one stream event/error marker, mark `streamErrorFrame:true` and keep the probe failed with sanitized error evidence.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document safe capture usage**

Document that `streamEvidence` is opt-in, bounded, and only records aggregate markers. It never prints or persists raw stream text, prompt, payload, cookie, session, token, or real user data.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "bounded async stream backpressure"
node --test test\ops-cli.test.js --test-name-pattern "streamEvidence"
node --test test\observability.test.js --test-name-pattern "upstream"
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

- Task 1 RED verified before implementation: `ProtocolProbeRunner` did not consume async `streamDeltas`; implementation now consumes only the bounded async iterator path when a real upstream marker exists.
- Task 2 RED verified before implementation: `probe validate` did not understand `streamEvidence`; implementation now validates allowed modes and `maxDeltas` bounds.
- Task 3 implemented in `src/protocol-probe.js` and `src/ops-cli.js`.
- Task 4 documentation updated in README, test cases, implementation reference, real protocol acceptance, M08 ops docs, data dictionary, and development tracking.
- Focused GREEN checks run after implementation:
  - `node --test test\protocol-probe.test.js --test-name-pattern "bounded async stream backpressure"` -> pass
  - `node --test test\ops-cli.test.js --test-name-pattern "streamEvidence"` -> pass
