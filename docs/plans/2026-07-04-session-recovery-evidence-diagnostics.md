# Session Recovery Evidence Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make rejected `recoverSession` / `session_recovery_strategy` evidence visible in session fixture audit without letting it satisfy automated session recovery readiness.

**Architecture:** Keep the existing session recovery gate unchanged: only fully sanitized evidence with `observedWindowMs`, `resultHash`, and post-recovery verifySession success can make `automated_session_refresh_strategy` ready. Add a separate diagnostic count for recovery evidence candidates that were present but rejected by the strict gate. CLI plain output reads this count from the same audit object and still keeps session scope blocked.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"session" })`, `tabbit-pool fixtures audit --scope session`, and Markdown docs.

---

### Task 1: RED Observability Diagnostic Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildProtocolFixtureAudit reports rejected session recovery evidence without satisfying recovery readiness`.

The fixture list should include:
- one successful `verifySession` fixture;
- one upstream `login_required` / 401 `verifySession` fixture;
- one marker-only `session_recovery_strategy` fixture with `safe:true`, `sanitized:true`, and `rawPayload:false`, but without `observedWindowMs`, `resultHash`, `expiredBeforeRecovery:true`, and `recoveredVerifySession:true`.

Expected:
- `audit.counts.recoveryStrategyEvidence === 0`;
- `audit.counts.rejectedRecoveryStrategyEvidence === 1`;
- `audit.recoveryStrategy.status === "blocked"`;
- `audit.missing === ["automated_session_refresh_strategy"]`;
- serialized audit does not include raw cookie, session, token, user id, or marker-only raw payload content.

**Step 2: Run RED**

```powershell
node --test --test-name-pattern "rejected session recovery evidence" test\observability.test.js
```

Expected before implementation: FAIL because `rejectedRecoveryStrategyEvidence` is not reported.

### Task 2: RED CLI Plain Diagnostic Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a marker-only `session_recovery_strategy` fixture to `fixtures audit --scope session prints refresh strategy gap in plain output`.

Expected:
- plain output includes `recovery_strategy_rejected	1`;
- `recovery_strategy` still prints `blocked	manual_reimport_then_probe	not_calibrated`;
- `missing` still includes only `automated_session_refresh_strategy`;
- raw fixture content is not printed.

**Step 2: Run RED**

```powershell
node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js
```

Expected before implementation: FAIL because the plain output has no rejected-evidence line.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add candidate predicate**

Add a small predicate in `src/observability.js`:

```js
function fixtureMatchesSessionRecoveryCandidate(fixture = {}) {
  return fixture?.kind === "session_recovery_strategy" || fixture?.operation === "recoverSession";
}
```

**Step 2: Count rejected candidates**

In `buildSessionFixtureAudit()`:

```js
const recoveryCandidates = fixtureList.filter(fixtureMatchesSessionRecoveryCandidate);
const recoveryEvidence = recoveryCandidates
  .map(sessionRecoveryStrategyEvidence)
  .filter(Boolean);
const rejectedRecoveryStrategyEvidence = Math.max(0, recoveryCandidates.length - recoveryEvidence.length);
```

Expose `rejectedRecoveryStrategyEvidence` under `counts`. Do not add it to `coverage` and do not remove `automated_session_refresh_strategy` from `missing`.

**Step 3: Print the count**

In `fixtures audit --scope session` plain output, add:

```js
"recovery_strategy_rejected	" + audit.counts.rejectedRecoveryStrategyEvidence,
```

near the existing `recovery_strategy` line.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document operator semantics**

State that `rejectedRecoveryStrategyEvidence` / `recovery_strategy_rejected` is diagnostic only. It means a recovery evidence fixture was present but failed the strict proof gate, and it never satisfies `automated_session_refresh_strategy`.

### Task 5: Verification

**Focused checks:**

```powershell
node --test --test-name-pattern "rejected session recovery evidence" test\observability.test.js
node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js
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
  - `node --test --test-name-pattern "rejected session recovery evidence" test\observability.test.js` failed because `counts.rejectedRecoveryStrategyEvidence` was not reported.
  - `node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js` failed because `fixtures audit --scope session` plain output had no `recovery_strategy_rejected` line.
- GREEN implementation:
  - `src/observability.js` now counts `recoverSession` / `session_recovery_strategy` candidates that fail the strict proof gate as `counts.rejectedRecoveryStrategyEvidence`.
  - `src/ops-cli.js` now prints `recovery_strategy_rejected` in session scope plain output.
  - The strict readiness gate is unchanged: rejected candidates do not satisfy `automated_session_refresh_strategy`.
- Documentation:
  - README, real protocol acceptance docs, and M08 ops docs document rejected recovery evidence as diagnostic only.
- Focused verification:
  - `node --test --test-name-pattern "rejected session recovery evidence|session recovery strategy evidence|marker-only session recovery evidence" test\observability.test.js` -> 3/3 pass.
  - `node --test --test-name-pattern "refresh strategy gap|calibrated recovery strategy evidence|real fixture store session recovery" test\ops-cli.test.js` -> 3/3 pass.
- Required verification:
  - `node --test test\ops-cli.test.js` -> 108/108 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 413/413 pass.
  - `git diff --check` -> exit 0; only LF/CRLF working-copy warnings.
- Safety:
  - Forbidden path scan checked 28 changed/untracked paths and found 0 hits.
  - Strict credential-shape scan checked 3224 added/untracked lines and found 0 hits.
- Current audits:
  - `fixtures audit --scope session --json` remains blocked with missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and `automated_session_refresh_strategy`; `rejectedRecoveryStrategyEvidence` is 0 in the current default state.
  - `fixtures audit --scope upstream --json` remains blocked with missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
