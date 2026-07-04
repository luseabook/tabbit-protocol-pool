# Readiness Doctor Capture Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `readiness doctor` capture command hints show safe prerequisite status for auth endpoint configuration before operators attempt side-effect probes.

**Architecture:** Extend existing `calibrationBacklog.captureCommands` metadata with a sanitized `prerequisites` array and `prerequisitesStatus`. The metadata reports only env var names and `configured` / `missing` status, never endpoint values, request bodies, cookies, sessions, tokens, or fixture payloads. Capture prerequisites are advisory only and do not change readiness or fixture audit gates.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `plainCaptureCommandLines()`, `runProtocolPoolCli()`, and Markdown docs.

---

### Task 1: RED Tests for Auth Capture Prerequisites

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

- [x] **Step 1: Add JSON helper test coverage**

Extend `buildReadinessDoctorReport includes safe calibration capture commands` with a config that lacks auth endpoint paths. Assert that the send-code capture command contains:

```js
assert.equal(send.prerequisitesStatus, "blocked");
assert.deepEqual(send.prerequisites, [{
  name: "auth_send_code_endpoint",
  env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH",
  status: "missing",
}]);
```

Also create a report with `protocol.authSendCodePath` and assert the same prerequisite status becomes `configured` and `prerequisitesStatus === "ready"`.

- [x] **Step 2: Add CLI JSON/plain test coverage**

Extend `readiness doctor --json includes auth and benefits backlog without running probes`:

```js
const send = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_sendVerificationCode_fixture");
assert.equal(send.prerequisitesStatus, "ready");
assert.deepEqual(send.prerequisites, [{
  name: "auth_send_code_endpoint",
  env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH",
  status: "configured",
}]);
```

Extend `readiness doctor prints calibration backlog in plain output` to assert the `capture_command` row includes:

```text
prereq=TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH:configured
```

- [x] **Step 3: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because capture commands currently do not include prerequisite metadata or plain `prereq=`.

### Task 2: Implement Minimal Prerequisite Metadata

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

- [x] **Step 1: Add safe prerequisite specs**

For `successful_sendVerificationCode_fixture`, define one prerequisite:

```js
{ name: "auth_send_code_endpoint", env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH", protocolKey: "authSendCodePath" }
```

For `successful_submitRegistrationOrLogin_fixture`, define:

```js
{ name: "auth_submit_code_endpoint", env: "TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH", protocolKey: "authSubmitCodePath" }
```

- [x] **Step 2: Pass protocol config into capture command builder**

Update `buildCalibrationCaptureCommands(missingNames, config)` and `captureCommandForMissing(missingName, config)` so each command includes:

```js
prerequisites: [
  { name, env, status: protocol[protocolKey] ? "configured" : "missing" }
],
prerequisitesStatus: prerequisites.every((item) => item.status === "configured") ? "ready" : "blocked",
```

For commands without prerequisites, return `prerequisites: []` and `prerequisitesStatus: "ready"`.

- [x] **Step 3: Add plain output**

Append a `prereq=` field to each plain `capture_command` row. The value is empty for commands without prerequisites; otherwise it is comma-separated `ENV:status`.

- [x] **Step 4: Run GREEN**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`

- [x] **Step 1: Document JSON prerequisites**

State that auth capture command hints include `prerequisites` and `prerequisitesStatus`.

- [x] **Step 2: Document plain prerequisites**

State that plain `capture_command` rows include `prereq=ENV:configured|missing`.

- [x] **Step 3: Preserve safety boundary**

Clarify that prerequisites expose only env var names/status and do not mean the endpoint/body/success semantics are calibrated.

### Task 4: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

- [x] **Step 1: Focused verification**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

- [x] **Step 2: Full verification**

```powershell
npm test
git diff --check
```

- [x] **Step 3: State and secret boundary checks**

Run aggregate-only external state checks and forbidden path / credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and auth capture commands report missing prerequisites when auth endpoint paths are not configured.

### Verification Evidence

- RED: `node --test test\observability.test.js --test-name-pattern "capture commands"` failed on missing `prerequisitesStatus`; `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"` failed on missing JSON prerequisite status and missing plain `prereq=`.
- GREEN: the same two focused commands passed after adding sanitized prerequisite metadata and plain `prereq=` output.
- Focused: `node --test test\observability.test.js`, `node --test test\ops-cli.test.js`, and `node --test test\protocol-tabbit-client.test.js` passed.
- Full: `npm test` passed with 354/354 tests; `git diff --check` exited 0 with existing CRLF warnings only.
- External state: aggregate-only doctor/readiness/audit checks found `doctorStatus:"ready"`, `readinessStatus:"ready"`, default fixture audit `ready`, auth audit `blocked`, auth send/submit endpoint prerequisites `missing`, and no raw fixture output.
- Boundary: forbidden status path scan was clean; refined credential-shape diff scan was clean after excluding short synthetic test placeholders.
