# Session Audit Manual Cookie Release Blockers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `fixtures audit --scope session` explicitly distinguish current manual-cookie release blockers from automated session refresh backlog.

**Architecture:** Keep existing audit gates unchanged. Session scope should still report `automated_session_refresh_strategy` in `missing` until real safe recovery evidence exists. Add explicit manual-cookie fields so operators can see that automated refresh is a later enhancement and not required for the current manual cookie operations release.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing `buildProtocolFixtureAudit({ scope:"session" })`, and `tabbit-pool fixtures audit --scope session`.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: JSON audit fields**

Extend session audit tests to expect:

```js
manualCookieOperations.blockingMissing
manualCookieOperations.backlogMissing
```

For a session audit with successful and expired `verifySession` evidence but no recovery evidence:

```js
manualCookieOperations.status === "ready"
manualCookieOperations.blockingMissing === []
manualCookieOperations.backlogMissing === ["automated_session_refresh_strategy"]
audit.missing === ["automated_session_refresh_strategy"]
```

For missing success/expired evidence, `blockingMissing` must include the missing manual-cookie evidence while `backlogMissing` still carries only automated refresh.

**Step 2: Plain output**

Extend `fixtures audit --scope session` plain output to expect the `manual_cookie_mode` line to include:

```text
release_blocking_missing=<csv>
backlog_missing=automated_session_refresh_strategy
```

Expected RED command:

```powershell
node --test test\observability.test.js --test-name-pattern "session lifecycle"
node --test test\ops-cli.test.js --test-name-pattern "refresh strategy gap"
```

Expected before implementation: FAIL because the new JSON fields/plain columns are absent.

### Task 2: Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1:** Add `blockingMissing` and `backlogMissing` to `manualCookieOperations`.

**Step 2:** Keep top-level session `missing` unchanged so `automated_session_refresh_strategy` remains visible as backlog.

**Step 3:** Extend session plain output with release/backlog columns without printing raw fixture content.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: this plan

Document that `manualCookieOperations.blockingMissing` / plain `release_blocking_missing` are current-release blockers, while `manualCookieOperations.backlogMissing` / plain `backlog_missing` are later enhancements.

### Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "session lifecycle"
node --test test\ops-cli.test.js --test-name-pattern "refresh strategy gap"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then run readiness doctor/session/upstream aggregate audits, forbidden-path scan, and strict credential-shape diff scan.

---

## Execution Status

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "session lifecycle"` initially failed because `manualCookieOperations.blockingMissing` / `backlogMissing` were absent.
  - `node --test test\ops-cli.test.js --test-name-pattern "refresh strategy gap"` initially failed because the plain `manual_cookie_mode` line lacked `release_blocking_missing` and `backlog_missing`.
- GREEN implemented:
  - `src/observability.js` now returns `manualCookieOperations.blockingMissing` for manual-cookie release blockers and `manualCookieOperations.backlogMissing` for automated-refresh backlog while keeping top-level session `missing` unchanged.
  - `src/ops-cli.js` now prints `release_blocking_missing=<csv>` and `backlog_missing=<csv>` on the session `manual_cookie_mode` line.
- Focused verification:
  - `node --test test\observability.test.js --test-name-pattern "session lifecycle"` -> 46/46 pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "refresh strategy gap"` -> 114/114 pass.
- Documentation updated:
  - README, API docs, test cases, implementation reference, real protocol acceptance doc, and M08 ops doc now explain release-blocking vs backlog session audit fields.
- Full verification:
  - `node --test test\observability.test.js` -> 46/46 pass.
  - `node --test test\ops-cli.test.js` -> 114/114 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 425/425 pass.
  - `git diff --check` -> exit 0, with LF/CRLF working-copy warnings only.
  - `readiness doctor --json` aggregate -> blocked because default stateDir lacks real sanitized fixtures.
  - `fixtures audit --scope session --json` aggregate -> blocked; `blockingMissing=successful_verifySession_fixture,expired_verifySession_fixture`, `backlogMissing=automated_session_refresh_strategy`.
  - `fixtures audit --scope upstream --json` aggregate -> blocked; missing real upstream error-frame, cancellation, and backpressure fixtures.
  - Forbidden path scan -> 45 changed/untracked paths, 0 hits.
  - Strict credential-shape scan -> 5552 added/untracked lines, 0 hits.
