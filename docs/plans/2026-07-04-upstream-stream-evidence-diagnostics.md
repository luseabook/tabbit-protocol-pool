# Upstream Stream Evidence Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make failed explicit upstream stream evidence capture attempts visible in `fixtures audit --scope upstream` without letting them satisfy readiness coverage.

**Architecture:** Keep the existing readiness gate unchanged: only sanitized real upstream fixtures with aggregate error-frame, cancellation, or backpressure evidence count as ready. Add a separate diagnostic count for `STREAM_EVIDENCE_NOT_CAPTURED` failed `sendMessage` fixtures so operators can tell the difference between "no capture attempted" and "capture attempted but evidence was incomplete". CLI plain output reads from the same audit object to avoid duplicate classification logic.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"upstream" })`, `tabbit-pool fixtures audit --scope upstream`, and Markdown docs.

---

### Task 1: RED Observability Diagnostic Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildProtocolFixtureAudit reports missed stream evidence captures without satisfying upstream coverage`.

The fixture should be a sanitized failed `sendMessage` protocol probe:

```js
{
  operation: "sendMessage",
  status: "failed",
  result: {
    raw: { kind: "stream", format: "sse", async: true },
    upstreamEvidence: { source: "tabbit-live", real: true, stream: true },
  },
  error: {
    category: "protocol_changed",
    code: "STREAM_EVIDENCE_NOT_CAPTURED",
    message: "stream evidence was requested but not captured",
  },
}
```

Expected:
- `audit.counts.streamEvidenceNotCaptured === 1`;
- upstream error-frame, cancellation, and backpressure coverage all remain `missing`;
- `missing` still includes all three real upstream fixture names;
- JSON output does not leak prompt, stream text, cookies, sessions, tokens, or real user data.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "missed stream evidence captures"
```

Expected before implementation: FAIL because `streamEvidenceNotCaptured` is not reported.

### Task 2: RED CLI Plain Diagnostic Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a sanitized failed fixture with `STREAM_EVIDENCE_NOT_CAPTURED` to the existing upstream plain-output audit test.

Expected:
- plain output includes `stream_evidence_not_captured	1`;
- output still reports all readiness coverage lines from the same `audit.coverage`;
- output does not print the diagnostic fixture's private stream text or prompt.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "upstream prints boundary counts"
```

Expected before implementation: FAIL because the plain output has no diagnostic line.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add a small predicate**

Add `fixtureMatchesStreamEvidenceNotCaptured(fixture)` in `src/observability.js`:

```js
function fixtureMatchesStreamEvidenceNotCaptured(fixture = {}) {
  const result = fixtureResult(fixture);
  return fixtureMatchesSendMessage(fixture)
    && fixture?.status === "failed"
    && (
      fixture?.error?.code === "STREAM_EVIDENCE_NOT_CAPTURED"
      || result?.error?.code === "STREAM_EVIDENCE_NOT_CAPTURED"
    );
}
```

**Step 2: Expose the count**

In `buildUpstreamFixtureAudit()`, compute:

```js
const streamEvidenceNotCaptured = fixtureList.filter(fixtureMatchesStreamEvidenceNotCaptured).length;
```

Add it under `counts` only. Do not add it to `coverage`, `missing`, or `nextActions`.

**Step 3: Keep missed captures out of readiness evidence**

Ensure `fixtureMatchesUpstreamErrorFrame()` returns false for `STREAM_EVIDENCE_NOT_CAPTURED`, even though the fixture is `status:"failed"` and may have stream metadata. A missed requested capture is a diagnostic, not an observed upstream error frame.

**Step 4: Print the count**

In `fixtures audit --scope upstream` plain output, add:

```js
"stream_evidence_not_captured	" + audit.counts.streamEvidenceNotCaptured,
```

near the existing upstream aggregate count lines.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document operator semantics**

State that `stream_evidence_not_captured` is diagnostic only. It means a bounded capture attempt ran but did not prove the requested real upstream marker, and it never satisfies `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, or `real_upstream_backpressure_fixture`.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\observability.test.js --test-name-pattern "missed stream evidence captures"
node --test test\ops-cli.test.js --test-name-pattern "upstream prints boundary counts"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files. Confirm sensitive paths remain untouched.

---

## Execution Status - 2026-07-04

- RED verified:
  - `node --test --test-name-pattern "missed stream evidence captures" test\observability.test.js` failed because `counts.streamEvidenceNotCaptured` was not reported.
  - `node --test --test-name-pattern "upstream prints boundary counts" test\ops-cli.test.js` failed because a `STREAM_EVIDENCE_NOT_CAPTURED` fixture was incorrectly counted as upstream error-frame evidence.
- GREEN implementation:
  - `src/observability.js` now reports `counts.streamEvidenceNotCaptured` for failed `sendMessage` captures with code `STREAM_EVIDENCE_NOT_CAPTURED`.
  - The same missed-capture diagnostic is explicitly excluded from upstream error-frame coverage.
  - `fixtures audit --scope upstream` plain output now prints `stream_evidence_not_captured`.
- Documentation:
  - README, real protocol acceptance docs, and M08 ops docs state that `stream_evidence_not_captured` is diagnostic only and does not satisfy real upstream readiness coverage.
- Focused verification:
  - `node --test --test-name-pattern "missed stream evidence captures" test\observability.test.js` -> pass.
  - `node --test --test-name-pattern "upstream prints boundary counts" test\ops-cli.test.js` -> pass.
  - `node --test --test-name-pattern "streamEvidence|bounded async stream|cancellation evidence|error-frame evidence|without a real async upstream marker|second delta is missing" test\protocol-probe.test.js` -> pass.
- Required verification:
  - `node --test test\ops-cli.test.js` -> 108/108 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 412/412 pass.
  - `git diff --check` -> exit 0; only LF/CRLF working-copy warnings.
- Safety:
  - Forbidden path scan checked 27 changed/untracked paths and found 0 hits.
  - Strict credential-shape scan checked 2978 added/untracked lines and found 0 hits. A broader first pass reported only synthetic test placeholders (`tabbit_session=secret`), not real credential shapes.
- Current audits:
  - `fixtures audit --scope session --json` remains blocked with `successful_verifySession_fixture`, `expired_verifySession_fixture`, and `automated_session_refresh_strategy` missing.
  - `fixtures audit --scope upstream --json` remains blocked with `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture` missing; `streamEvidenceNotCaptured` is 0 in the current default state.
