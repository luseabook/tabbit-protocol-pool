# Readiness State Evidence Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the remaining launch-readiness work explicit and give operators a safe, local way to diagnose why `readiness` is blocked or ready for a selected state directory.

**Architecture:** Keep real protocol evidence in local state, not in the repository. Add a read-only `readiness doctor` CLI path that reuses the existing account store, fixture audit, readiness snapshot, and redaction boundaries, then update docs so the known sanitized evidence state can be selected with `TABBIT_POOL_STATE_DIR` without copying secrets.

**Tech Stack:** Node.js ESM, native `node:test`, existing `JsonAccountStore`, `FileProtocolFixtureStore`, `FileReadinessStateStore`, `buildCalibrationReadinessSnapshot()`, and `buildProtocolFixtureAudit()`.

---

### Task 1: Document Remaining Work and Operator Flow

**Files:**
- Create: `docs/plans/2026-07-03-readiness-state-evidence-integration.md`

**Step 1: Capture the blocker**

Write down that the standalone repo is functional, but the default state directory can report `blocked` when it has no local protocol fixtures. The existing sanitized evidence state must stay outside the repo and be selected explicitly.

**Step 2: Define the acceptance gate**

The final workflow must let an operator run:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js readiness --json
node bin\tabbit-pool.js fixtures audit --json
```

Expected: the doctor output explains current `stateDir`, protocol env coverage, readiness status, fixture audit status, remaining work, and safe commands without exposing cookies, sessions, API keys, prompt contents, or raw fixture payloads.

**Step 3: Preserve secret boundaries**

Document that `tabbit-cookie.txt`, `output/`, browser profiles, raw captures, local `fixtures/protocol-probes/*.json` under a private state directory, and `readiness.json` remain local unless explicitly sanitized and reviewed.

### Task 2: RED Test for `readiness doctor`

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add a failing test**

Add a test named `readiness doctor --json explains state, protocol env, and remaining work without touching network`.

The injected dependencies should include:

```js
config: {
  stateDir: path.join(tmpdir(), "tabbit-readiness-doctor-test"),
  compat: { stripClientTools: true, toolLoopMode: "client_executes_tools_first" },
  protocol: {
    enabled: true,
    baseUrl: "https://web.tabbit.ai",
    sendPath: "/api/v1/chat/completion",
    sessionVerifyPath: "/api/v0/user/base-info",
  },
},
accountStore: memoryStore(baseAccounts(), calls),
protocolFixtureStore: {
  async listFixtures() {
    calls.push(["listFixtures"]);
    return [
      { operation: "verifySession", status: "success" },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
    ];
  },
},
readinessStateStore: memoryReadinessStore({}, calls),
```

Assertions:

- exit code is `0`.
- calls are only `loadAccounts`, `listFixtures`, and `readReadinessState`.
- JSON has `stateDir`, `protocol.enabled`, `protocol.sendPathConfigured`, `protocol.sessionVerifyPathConfigured`, `readiness.status`, `fixtureAudit.status`, `remainingWork`, and `commands`.
- output does not include raw cookie/session/token values or full account email.

**Step 2: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because `readiness doctor` is not implemented.

### Task 3: Implement Minimal Read-Only Doctor Command

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add help text and dispatch**

Add:

```text
tabbit-pool readiness doctor [--json]
```

Dispatch it before the generic `readiness` handler.

**Step 2: Reuse existing snapshot helpers**

Implement `handleReadinessDoctor(args, deps, stdout)` by reading:

- `loadAccounts(deps.accountStore)`
- `readProtocolFixtureDetails(deps.protocolFixtureStore)`
- `deps.readinessStateStore.readState()`

Then build both:

- `buildCalibrationReadinessSnapshot({ accounts, config: deps.config, fixtures, codexVerified, claudeVerified, now })`
- `buildProtocolFixtureAudit({ fixtures, now: deps.now })`

**Step 3: Return a bounded JSON shape**

The JSON should include only safe metadata:

```js
{
  status,
  stateDir,
  protocol: {
    enabled,
    baseUrlConfigured,
    sendPathConfigured,
    sessionVerifyPathConfigured,
    compatStripClientTools,
    toolLoopMode,
  },
  readiness,
  fixtureAudit,
  remainingWork,
  commands,
}
```

`remainingWork` is the union of readiness and fixture audit `nextActions`. `commands` contains non-secret PowerShell command examples for setting `TABBIT_POOL_STATE_DIR`, running readiness, auditing fixtures, and starting the gateway.

**Step 4: Run GREEN**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: PASS.

### Task 4: Update Operator Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: README status**

Mention `readiness doctor` in the current implementation summary and CLI list.

**Step 2: Real protocol acceptance doc**

Add a short section under local readiness precheck explaining:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js readiness --json
node bin\tabbit-pool.js fixtures audit --json
```

State that this selects an external local evidence state and does not commit it.

**Step 3: M08 CLI reference**

Add a `tabbit-pool readiness doctor [--json]` section describing its read-only scope, output fields, and secret boundary.

### Task 5: Full Verification and Delivery

**Files:**
- Inspect: `git status --short`

**Step 1: Focused tests**

Run:

```powershell
node --test test\ops-cli.test.js
```

Expected: all `ops-cli` tests pass.

**Step 2: Full tests**

Run:

```powershell
npm test
```

Expected: all repository tests pass.

**Step 3: Local evidence state verification**

If `E:\tabbit2api\output\tabbit-live-state` exists locally, run:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js readiness --json
node bin\tabbit-pool.js fixtures audit --json
```

Expected: no secret output; readiness and fixture audit reflect the selected state directory.

**Step 4: Git boundary**

Confirm:

```powershell
git status --short
```

Expected: only intended docs, test, and CLI files changed. No `tabbit-cookie.txt`, `output/`, `.omx/`, `.agents/`, raw captures, or local state fixtures are staged or committed.
