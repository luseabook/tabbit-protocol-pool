# Session Verify Real Calibration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Calibrate the real Tabbit session verification endpoint, preserve redacted evidence, and make readiness/fixture audit report that coverage.

**Architecture:** Keep the endpoint explicit via `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH`, but update the verified runtime configuration and observability checks once a sanitized `verifySession` fixture exists. Reuse `ProtocolTabbitClient.verifySession()` and the existing protocol fixture store so secrets stay only in local state.

**Tech Stack:** Node.js ESM, native `node:test`, existing protocol probe CLI, local `output/tabbit-live-state` fixtures.

---

### Task 1: Discover and preserve endpoint evidence

**Files:**
- Inspect only: `output/tabbit-live-state/**`
- Create local fixture: `output/tabbit-live-state/fixtures/protocol-probes/*.json`

**Step 1: Enumerate local evidence safely**

Use a redacting script that prints only URL paths, statuses, and fixture metadata.

**Step 2: Probe candidate endpoint**

Run `probe protocol --operation verifySession --write-fixture` with the configured state dir and candidate path.

**Step 3: Confirm fixture safety**

Inspect the saved JSON for `operation:"verifySession"`, no cookie/session/token values, and useful status/result metadata.

### Task 2: RED tests for verify-session coverage

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Add failing tests**

Add tests that expect `buildProtocolFixtureAudit()` and `buildCalibrationReadinessSnapshot()` to count a successful `verifySession` fixture.

**Step 2: Run RED**

Run:

```powershell
node --test test/observability.test.js test/ops-cli.test.js
```

Expected: FAIL because verify-session fixture coverage is not part of the audit/readiness output yet.

### Task 3: Minimal implementation

**Files:**
- Modify: `src/observability.js`
- Modify as needed: `src/ops-cli.js`

**Step 1: Add verify fixture matcher**

Recognize `operation:"verifySession"` and `status:"success"` as session verification evidence.

**Step 2: Add coverage and readiness evidence**

Expose `coverage.sessionVerify` in fixture audit and require a successful verify fixture for protocol calibration readiness.

**Step 3: Run GREEN**

Run the same focused tests and then `node --test test/ops-cli.test.js`.

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/_M01-Tabbit协议客户端.md`
- Modify: `docs/modules/M07-配置密钥/_M07-配置密钥.md`
- Modify related module docs only if touched behavior requires it.

**Step 1: Document the calibrated path**

Record the endpoint, method, opt-in env var, and fixture/readiness expectation without real account values.

**Step 2: Verify**

Run:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test\ops-cli.test.js
npm test
cd E:\tabbit2api
npm test
```

Then run Markdown link and secret scans, and confirm `output/`, `tabbit-cookie.txt`, browser profiles, and secrets are not in the commit boundary.
