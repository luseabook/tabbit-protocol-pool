# Session Recovery Proof Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent `fixtures audit --scope session` from treating marker-only `recoverSession` evidence as calibrated automated session recovery.

**Architecture:** Keep `recoverSession` as an offline evidence flow. Tighten both the CLI validator and the audit predicate so a recovery strategy only becomes ready when the sanitized evidence includes an observed expiration window, a post-recovery verifySession success signal, and a redacted recovery result hash. Do not introduce any live refresh behavior until real protocol evidence exists.

**Tech Stack:** Node.js ESM, native `node:test`, existing `probe validate --operation recoverSession`, `buildProtocolFixtureAudit({ scope:"session" })`, and Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildProtocolFixtureAudit rejects marker-only session recovery evidence`.

Use fixtures with:
- one successful `verifySession`;
- one failed 401/login_required `verifySession`;
- one `session_recovery_strategy` fixture with only `strategy`, `automatedRefresh`, `safe:true`, `sanitized:true`, `rawPayload:false`.

Expected:
- `successful_verifySession_fixture` and `expired_verifySession_fixture` are ready;
- `recoveryStrategy.status === "blocked"`;
- `counts.recoveryStrategyEvidence === 0`;
- `missing` remains `["automated_session_refresh_strategy"]`;
- serialized audit does not contain raw user/session text.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "marker-only session recovery"
```

Expected: FAIL before implementation because marker-only recovery evidence is currently accepted.

### Task 2: RED CLI Validator Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add `probe validate --operation recoverSession rejects marker-only evidence`.

Input should match the current old-style valid payload:

```json
{
  "kind": "session_recovery_strategy",
  "operation": "recoverSession",
  "status": "success",
  "evidence": {
    "strategy": "automated_reauth",
    "automatedRefresh": "calibrated_reauth_probe",
    "safe": true,
    "sanitized": true,
    "rawPayload": false
  }
}
```

Expected:
- exit code `2`;
- dependencies are not touched;
- stderr mentions `observedWindowMs`, `resultHash`, and post-recovery verifySession evidence;
- raw ignored fields are not printed.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "marker-only evidence"
```

Expected: FAIL before implementation because the old payload currently validates.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`
- Modify: `src/observability.js`

**Step 1: Extend recoverSession evidence shape**

Require `evidence.observedWindowMs` to be a positive integer and `evidence.resultHash` to be a safe `sha256:` value.

**Step 2: Require post-recovery verification**

Require `result.expiredBeforeRecovery === true` and `result.recoveredVerifySession === true` for both CLI validation and audit readiness.

**Step 3: Preserve only safe evidence**

When writing offline fixtures, preserve `observedWindowMs`, `resultHash`, and the two boolean result signals. Continue dropping any raw cookie/session/token/prompt fields.

### Task 4: Update Existing Tests and Docs

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`
- Modify: `README.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Update valid recovery evidence tests**

Add `observedWindowMs`, `resultHash`, and post-recovery result booleans to existing valid `recoverSession` test fixtures.

**Step 2: Document the stricter proof gate**

State that `recoverSession` evidence cannot be marker-only. It must prove a safe observed expiration window and successful post-recovery `verifySession` with only hash/boolean evidence.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\observability.test.js --test-name-pattern "session recovery"
node --test test\ops-cli.test.js --test-name-pattern "recoverSession|session recovery"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked files.

---

## Execution Status - 2026-07-04

Completed in this continuation turn.

### RED Evidence

- `node --test test\observability.test.js --test-name-pattern "marker-only session recovery"` failed before implementation because marker-only recovery evidence made `recoveryStrategy.status` ready.
- `node --test test\ops-cli.test.js --test-name-pattern "marker-only evidence"` failed before implementation because old-style recovery evidence returned exit code 0.

### GREEN Implementation

- `src/ops-cli.js` now requires `recoverSession` evidence to include positive `observedWindowMs`, `resultHash` with a `sha256:` value, and `result.expiredBeforeRecovery:true` plus `result.recoveredVerifySession:true`.
- `src/ops-cli.js` preserves only the safe recovery proof fields when writing offline fixtures.
- `src/observability.js` now ignores marker-only `session_recovery_strategy` / `recoverSession` fixtures in session scope audit.

### Documentation

- README, data dictionary, real protocol acceptance docs, API reference, development tracking, and M08 ops docs now describe the stricter recovery proof gate.

### Verification Evidence

- `node --test test\observability.test.js --test-name-pattern "session recovery"`: 39/39 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "recoverSession|session recovery"`: 104/104 pass.
- Full regression, diff, forbidden-path, and credential-shape scans are tracked in the final turn summary for this increment.
