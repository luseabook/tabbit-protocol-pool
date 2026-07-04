# Session Recovery Strategy Evidence Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let `fixtures audit --scope session` recognize a sanitized, explicit automated session recovery strategy evidence fixture, while keeping session scope blocked without that evidence.

**Architecture:** Keep `verifySession` success and expired lifecycle evidence separate from recovery readiness. Add a conservative recovery evidence predicate that only accepts non-raw, explicit session recovery strategy fixtures with `status:"success"` and a safe calibrated mode. The audit must not infer refresh readiness from cookies, successful verifies, expired verifies, or local `session_missing`.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"session" })`, `tabbit-pool fixtures audit --scope session`, and Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Add a failing ready-path test**

Add `buildProtocolFixtureAudit accepts explicit session recovery strategy evidence`.

Fixture set:

```js
[
  {
    operation: "verifySession",
    status: "success",
    observedAt: "2026-07-02T03:00:00.000Z",
    result: { ok: true, userId: "user_123" },
  },
  {
    operation: "verifySession",
    status: "failed",
    observedAt: "2026-07-03T03:00:00.000Z",
    error: { category: "login_required", status: 401, message: "expired token=secret" },
  },
  {
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
  },
]
```

Expected:
- session scope `status === "ready"`;
- lifecycle coverage remains ready;
- `recoveryStrategy.status === "ready"`;
- `recoveryStrategy.current === "automated_reauth"`;
- `recoveryStrategy.automatedRefresh === "calibrated_reauth_probe"`;
- `missing === []`;
- serialized output does not contain `user_123` or `token=secret`.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "session recovery strategy evidence"
```

Expected: FAIL because session audit currently hardcodes recovery strategy as blocked.

### Task 2: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add a CLI JSON test**

Add `fixtures audit --scope session reports calibrated recovery strategy evidence`.

Use fixture store entries for successful verify, expired verify, one recovery strategy fixture, and one unrelated `sendMessage` fixture. Assert the CLI reads only session-relevant refs, returns `status:"ready"`, and does not leak raw payload-like text.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "calibrated recovery strategy"
```

Expected: FAIL until session audit reads and recognizes explicit recovery strategy evidence.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js` if scoped fixture filtering needs to include the new operation.

**Step 1: Add recovery evidence predicate**

Accept only fixtures where:
- `kind === "session_recovery_strategy"` or `operation === "recoverSession"`;
- `status === "success"`;
- evidence has `safe === true` and `sanitized === true`;
- evidence declares either `strategy:"automated_reauth"` or `strategy:"refresh_token"` / equivalent safe calibrated mode;
- no raw payload/session material is returned by the audit.

**Step 2: Include recovery evidence in session scope**

Session audit should include `recoverSession` fixture refs in scoped CLI reads and count only explicit safe evidence. Keep default protocol audit unchanged.

**Step 3: Preserve blocked defaults**

Without recovery evidence, current behavior stays blocked with `automated_session_refresh_strategy` missing.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document the evidence gate**

State that session scope becomes fully ready only when success/expired `verifySession` lifecycle evidence and an explicit sanitized automated recovery strategy evidence fixture are present. Successful/expired lifecycle evidence alone remains insufficient.

### Task 5: Verification

**Step 1: Focused tests**

```powershell
node --test test\observability.test.js --test-name-pattern "session recovery strategy evidence"
node --test test\ops-cli.test.js --test-name-pattern "calibrated recovery strategy"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Step 3: Aggregate and safety checks**

Run external aggregate-only readiness/audit checks plus forbidden-path and credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and external session scope remains blocked until real sanitized recovery evidence exists.

---

## Execution Status - 2026-07-04

Completed.

### RED Evidence

- `node --test test\observability.test.js --test-name-pattern "session recovery strategy evidence"` failed as expected before implementation: session scope stayed `blocked` instead of `ready`.
- `node --test test\ops-cli.test.js --test-name-pattern "calibrated recovery strategy"` failed as expected before implementation: session scoped CLI read only `verifySession` fixtures and skipped the `recoverSession` fixture.

### GREEN Implementation

- `src/observability.js` now recognizes explicit session recovery strategy evidence only when the fixture is `kind:"session_recovery_strategy"` or `operation:"recoverSession"`, has `status:"success"`, and declares `safe:true`, `sanitized:true`, `rawPayload:false`, plus an allowed calibrated recovery mode.
- `src/observability.js` exposes `counts.recoveryStrategyEvidence` and keeps `automated_session_refresh_strategy` missing unless safe recovery evidence is present.
- `src/ops-cli.js` now lets `fixtures audit --scope session` read both `verifySession` and `recoverSession` fixture refs.
- Default session behavior remains blocked with `manual_reimport_then_probe` when no recovery evidence exists.

### Verification Evidence

- `node --test test\observability.test.js --test-name-pattern "session recovery strategy evidence"`: 35/35 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "calibrated recovery strategy"`: 83/83 pass.
- `node --test test\observability.test.js`: 35/35 pass.
- `node --test test\ops-cli.test.js`: 83/83 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 359/359 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings.
- Forbidden path scan: clean.
- Credential-shape diff scan: clean after excluding explicit test placeholders.

### External Aggregate State

External state was checked with `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and protocol env configured. Only aggregate status was printed.

- doctor: ready.
- readiness: ready.
- default fixture audit: ready.
- calibration backlog: blocked.
- auth missing: `successful_sendVerificationCode_fixture`, `successful_submitRegistrationOrLogin_fixture`.
- benefits missing: `successful_daily_sign_in_fixture`, `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, `successful_lottery_draw_fixture`.
- session remains blocked: `recoveryStrategy.status=blocked`, `counts.recoveryStrategyEvidence=0`, missing `automated_session_refresh_strategy`.
- upstream remains blocked: `realUpstream=3`, `upstreamErrorFrame=0`, `upstreamCancellation=0`, `upstreamBackpressure=0`.
