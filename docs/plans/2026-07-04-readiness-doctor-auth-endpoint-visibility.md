# Readiness Doctor Auth Endpoint Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `readiness doctor` show whether auth send-code and submit-code endpoints are explicitly configured, so registration/login calibration can distinguish missing endpoint wiring from missing success evidence.

**Architecture:** Extend the existing read-only doctor protocol summary and plain renderer with boolean auth endpoint configuration fields. Keep readiness and calibration backlog semantics unchanged: configured auth paths prove only runtime wiring visibility, while `fixtures audit --scope auth` still gates readiness on delivery success and importable session-material fixtures.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `protocolDoctorSummary()`, `runProtocolPoolCli()`, and Markdown docs.

---

### Task 1: RED Tests for Doctor Auth Endpoint Visibility

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

- [ ] **Step 1: Add JSON report test coverage**

Add assertions to the existing `buildReadinessDoctorReport combines readiness and fixture audit without leaking secrets` or auth backlog doctor test:

```js
const report = buildReadinessDoctorReport({
  config: {
    stateDir: "E:/state",
    protocol: {
      enabled: true,
      baseUrl: "https://web.tabbit.ai",
      sendPath: "/api/v1/chat/completion",
      sessionVerifyPath: "/api/v0/user/base-info",
      authSendCodePath: "/api/auth/send-code",
      authSubmitCodePath: "/api/auth/submit-code",
    },
  },
});

assert.equal(report.protocol.authSendCodePathConfigured, true);
assert.equal(report.protocol.authSubmitCodePathConfigured, true);
```

- [ ] **Step 2: Add CLI JSON/plain test coverage**

Extend `readiness doctor --json includes auth and benefits backlog without running probes` so injected config includes auth send/submit paths and asserts:

```js
assert.equal(body.protocol.authSendCodePathConfigured, true);
assert.equal(body.protocol.authSubmitCodePathConfigured, true);
```

Extend `readiness doctor prints calibration backlog in plain output` with auth path config and assert lines:

```js
assert.match(text, /^auth_send_endpoint\tconfigured/m);
assert.match(text, /^auth_submit_endpoint\tconfigured/m);
```

- [ ] **Step 3: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "ReadinessDoctor|readiness doctor|buildReadinessDoctorReport"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because the doctor protocol summary and plain output do not expose auth endpoint fields yet.

### Task 2: Implement Minimal Read-Only Summary Fields

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

- [ ] **Step 1: Extend protocol summary**

In `protocolDoctorSummary(config)`, add:

```js
authSendCodePathConfigured: Boolean(protocol.authSendCodePath),
authSubmitCodePathConfigured: Boolean(protocol.authSubmitCodePath),
```

- [ ] **Step 2: Extend plain doctor output**

In `handleReadinessDoctor()`, print:

```text
auth_send_endpoint	configured|missing
auth_submit_endpoint	configured|missing
```

Use only booleans, never endpoint paths.

- [ ] **Step 3: Run GREEN**

```powershell
node --test test\observability.test.js --test-name-pattern "buildReadinessDoctorReport"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`

- [ ] **Step 1: Document JSON fields**

State that `readiness doctor --json` now includes `protocol.authSendCodePathConfigured` and `protocol.authSubmitCodePathConfigured`.

- [ ] **Step 2: Document plain fields**

State that non-JSON doctor prints `auth_send_endpoint` and `auth_submit_endpoint` as `configured` or `missing`.

- [ ] **Step 3: Preserve gate wording**

Clarify that endpoint configured status is not auth calibration readiness; auth fixtures still need delivery success and session-material evidence.

### Task 4: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

- [ ] **Step 1: Focused verification**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

- [ ] **Step 2: Full verification**

```powershell
npm test
git diff --check
```

- [ ] **Step 3: State and secret boundary checks**

Run aggregate-only external state doctor/readiness/audit checks and forbidden path / credential-shape scans. Expected: no raw fixture output, no sensitive file edits, no credential-shaped values in changed docs or source.
