# Observability Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an offline-testable M08 observability foundation that summarizes account-pool health, redacts account display data, records maintenance action logs, produces protocol probe advice, and wires gateway `/health` to safe account summaries.

**Status:** Implemented on 2026-07-02. `test/observability.test.js` covers account summaries, alerts, redacted account display, health snapshots, maintenance action logs, probe advice, and gateway health provider output. `test/protocol-pool-gateway.test.js` covers default `/health` account summary wiring and secret redaction. `test/smoke.test.js` covers package entry exports.

**Architecture:** Introduce `src/observability.js` as pure functions plus a gateway health-provider factory. Keep raw account secrets out of every output, derive health from account metadata and optional model-cache metadata, and let `createProtocolPoolGateway()` use the provider by default unless callers inject their own `health`.

**Tech Stack:** Node.js ESM, native `node:test`, existing `redactSensitiveValue`, existing `AccountPool`/`StoredAccountPool` list shape, existing `createProtocolPoolServer()` health injection.

---

### Task 1: Account summary and redacted display

**Files:**
- Create: `test/observability.test.js`
- Create: `src/observability.js`

**Step 1: Write failing tests**

Add tests for:

- `summarizeAccounts(accounts)` returns total count, by-status count, active count, unavailable count, and health status.
- No active accounts produces an alert `no_active_accounts`.
- All accounts quota exhausted produces an alert `all_accounts_quota_exhausted`.
- Repeated `protocol_changed` last errors produce an alert `protocol_changed_errors`.
- `redactAccountForDisplay(account)` includes useful status/quota/error fields but removes cookie/session/token/cookieJarRef and redacts email/error message.

**Step 2: Run RED**

Run: `node --test test/observability.test.js`

Expected: FAIL because `src/observability.js` does not exist.

**Step 3: Implement minimal code**

Implement:

- `summarizeAccounts(accounts, options)`
- `redactAccountForDisplay(account)`
- `redactAccountsForDisplay(accounts)`

**Step 4: Run GREEN**

Run: `node --test test/observability.test.js`

Expected: PASS.

---

### Task 2: Health snapshot, action log, and probe advice

**Files:**
- Modify: `test/observability.test.js`
- Modify: `src/observability.js`

**Step 1: Write failing tests**

Add tests for:

- `buildHealthSnapshot(input)` combines account summary, model-cache metadata, uptime, and alerts without exposing raw accounts.
- `formatMaintenanceActionLog(input)` emits one redacted event per action with accountId, action, status, changed, observedAt, and sanitized error.
- `protocolProbeAdvice(error)` maps categories/statuses to actionable next steps.

**Step 2: Run RED**

Run: `node --test test/observability.test.js`

Expected: FAIL until functions exist.

**Step 3: Implement minimal code**

Implement the three helpers. Keep all outputs JSON-serializable and deterministic under injected `now`.

**Step 4: Run GREEN**

Run: `node --test test/observability.test.js`

Expected: PASS.

---

### Task 3: Gateway health wiring and exports/docs

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `test/smoke.test.js`
- Modify: `src/protocol-pool-gateway.js`
- Modify: `src/index.js`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `README.md`

**Step 1: Write failing tests**

Add tests for:

- `createProtocolPoolGateway()` default `/health` includes account summary.
- Gateway health response does not expose email, cookie, cookieHeader, token, session, or cookieJarRef.
- `src/index.js` exports M08 helpers.

**Step 2: Run RED**

Run:

- `node --test test/protocol-pool-gateway.test.js`
- `node --test test/smoke.test.js`

Expected: FAIL until gateway wiring and exports are added.

**Step 3: Implement minimal code**

Wire `createGatewayHealthProvider({ accountPool, startedAt, now })` into `createProtocolPoolGateway()` when `options.health` is undefined, and export observability helpers from `src/index.js`.

**Step 4: Document**

Update M08 and shared docs to mark the foundation layer implemented while keeping CLI commands and real protocol probes as pending.

**Step 5: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`.
- `npm test` in repository root.
- Markdown local-link scan.
- Markdown sensitive placeholder scan.
