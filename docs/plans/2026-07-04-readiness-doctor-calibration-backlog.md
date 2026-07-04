# Readiness Doctor Calibration Backlog Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `readiness doctor` show the remaining auth and benefits real-protocol calibration backlog even when the core gateway readiness is already `ready`.

**Architecture:** Keep the existing default readiness gate focused on protocol/chat launch readiness. Extend the read-only doctor report with bounded `calibrationBacklog` metadata built from the existing `fixtures audit --scope auth` and `fixtures audit --scope benefits` logic, without changing fixture storage, probe execution, or side-effect behavior.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit()`, `buildReadinessDoctorReport()`, and `runProtocolPoolCli()`.

---

### Task 1: RED Observability Test for Extended Backlog

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildReadinessDoctorReport exposes auth and benefits calibration backlog separately from core readiness`.

Use fixtures that make the protocol audit ready but leave auth and benefits scopes missing:

```js
const report = buildReadinessDoctorReport({
  accounts,
  config: {
    stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
    compat: { stripClientTools: true, toolLoopMode: "client_executes_tools_first" },
    protocol: {
      enabled: true,
      baseUrl: "https://web.tabbit.ai",
      sendPath: "/api/v1/chat/completion",
      sessionVerifyPath: "/api/v0/user/base-info",
    },
  },
  fixtures: [
    { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
    { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
    {
      operation: "sendMessage",
      status: "failed",
      input: { tools: [{ type: "function", function: { name: "lookup" } }] },
      result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
    },
    { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
  ],
  readinessState: {
    codex: { verified: true },
    claude: { verified: true },
  },
  now: () => NOW,
});
```

Assertions:

- `report.status === "ready"` because core readiness remains ready.
- `report.remainingWork` remains empty for the core gate.
- `report.calibrationBacklog.status === "blocked"`.
- `report.calibrationBacklog.scopes.auth.status === "blocked"`.
- `report.calibrationBacklog.scopes.benefits.status === "blocked"`.
- `report.calibrationBacklog.missing` includes auth and benefits missing evidence names.
- serialized report does not include emails, sessions, tokens, raw prompts, or fixture payload secrets.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "calibration backlog"
```

Expected: FAIL because `calibrationBacklog` is not implemented.

### Task 2: RED CLI Test for Doctor Output

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `readiness doctor --json includes auth and benefits backlog without running probes`.

Use injected stores that return protocol-ready fixtures but no auth or benefits success fixtures. Confirm:

- calls are exactly `loadAccounts`, `listFixtures`, and `readReadinessState`.
- output includes `calibrationBacklog.status === "blocked"`.
- output includes `commands.authFixturesAudit` and `commands.benefitsFixturesAudit`.
- output does not include raw account email, cookie/session/token, or `cookieJarRef`.

**Step 2: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth and benefits backlog"
```

Expected: FAIL because doctor does not include the extended backlog fields.

### Task 3: Implement Doctor Backlog Metadata

**Files:**
- Modify: `src/observability.js`

**Step 1: Build scoped audits**

Inside `buildReadinessDoctorReport()`, call:

```js
const authAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "auth" });
const benefitsAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "benefits" });
```

**Step 2: Add `calibrationBacklog`**

Return a new safe metadata object:

```js
calibrationBacklog: {
  status: authAudit.status === "ready" && benefitsAudit.status === "ready" ? "ready" : "blocked",
  scopes: { auth: authAudit, benefits: benefitsAudit },
  missing: uniqueStrings([...authAudit.missing, ...benefitsAudit.missing]),
  nextActions: uniqueStrings([...authAudit.nextActions, ...benefitsAudit.nextActions]),
}
```

Keep top-level `status` and `remainingWork` unchanged so existing gateway readiness semantics do not regress.

**Step 3: Extend safe commands**

Add to `readinessDoctorCommands()`:

```js
authFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope auth --json",
benefitsFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope benefits --json",
```

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: README**

Update the `readiness doctor` description to say it reports core readiness plus auth/benefits calibration backlog.

**Step 2: Real protocol acceptance doc**

Clarify that `remainingWork: []` means the core gateway readiness gate is clear, while `calibrationBacklog` tracks the remaining real-protocol auth/benefits evidence gaps.

**Step 3: M08**

Add the new fields and commands to the CLI reference, preserving the secret boundary.

### Task 5: Verification

**Step 1: Focused tests**

Run:

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
```

Expected: all tests pass.

**Step 2: Required regression tests**

Run:

```powershell
node --test test\protocol-tabbit-client.test.js
npm test
```

Expected: all tests pass.

**Step 3: External state read-only check**

Run the external state doctor and scoped audits:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope auth --json
node bin\tabbit-pool.js fixtures audit --scope benefits --json
```

Expected: no secret output; doctor core status may be `ready`, while `calibrationBacklog.status` remains `blocked` until auth/benefits evidence is captured.

**Step 4: Secret boundary**

Run forbidden-path and sensitive-token scans. Confirm no `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, or `.omx/` files were modified.
