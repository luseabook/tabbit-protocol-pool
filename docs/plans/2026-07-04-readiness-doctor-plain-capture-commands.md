# Readiness Doctor Plain Capture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make non-JSON `tabbit-pool readiness doctor` output include safe calibration capture command hints for the remaining auth, benefits, and session backlog items.

**Architecture:** Reuse the existing `buildReadinessDoctorReport().calibrationBacklog.captureCommands` array and extend only the plain renderer in `src/ops-cli.js`. The output must remain aggregate and placeholder-only: no fixture bodies, cookies, sessions, API keys, emails, prompt text, user data, or generated input payloads.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()`, `buildReadinessDoctorReport()`, and Markdown docs.

---

### Task 1: Document Scope and Safety Boundary

**Files:**
- Create: `docs/plans/2026-07-04-readiness-doctor-plain-capture-commands.md`

**Step 1: Write this plan**

Record that the plain doctor enhancement is read-only and must not change readiness semantics.

**Step 2: Confirm no implementation files changed yet**

Run: `git diff -- docs/plans/2026-07-04-readiness-doctor-plain-capture-commands.md`

Expected: Only the plan document is present for this task.

### Task 2: RED Test for Plain Capture Commands

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Extend `readiness doctor prints calibration backlog in plain output` to expect:

```js
assert.match(text, /^capture_command\tsuccessful_sendVerificationCode_fixture\tauth\tside_effect=true\ttemplate=node bin\\tabbit-pool.js probe template --operation sendVerificationCode --json\tprobe=node bin\\tabbit-pool.js probe protocol --account <account-id> --operation sendVerificationCode --input-file <redacted-input.json> --write-fixture --json/m);
assert.match(text, /^capture_command\tsuccessful_reset_coupon_consumption_fixture\tbenefits\tside_effect=true\ttemplate=\tprobe=\treason=/m);
assert.match(text, /^capture_command\tautomated_session_refresh_strategy\tsession\tside_effect=false\ttemplate=\tprobe=\treason=/m);
```

Also assert the plain output still does not include raw account emails, tokens, API keys, `cookieJarRef`, or private tool names.

**Step 2: Run test to verify it fails**

Run: `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog in plain output"`

Expected: FAIL because the plain renderer does not print `capture_command` lines yet.

### Task 3: GREEN Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add a small formatter**

Add a helper near the readiness doctor renderer:

```js
function plainCaptureCommandLines(commands = []) {
  return (Array.isArray(commands) ? commands : []).map((item) => [
    "capture_command",
    item.missing || "",
    item.scope || "",
    "side_effect=" + Boolean(item.sideEffect),
    "template=" + (item.templateCommand || ""),
    "probe=" + (item.probeCommand || ""),
    "reason=" + (item.reason || ""),
  ].join("\t"));
}
```

**Step 2: Append command lines to plain doctor output**

In `handleReadinessDoctor()`, append `...plainCaptureCommandLines(backlog.captureCommands)` after the per-scope backlog lines.

**Step 3: Run focused test**

Run: `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog in plain output"`

Expected: PASS.

### Task 4: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/04-开发追踪.md`

**Step 1: Update CLI docs**

State that non-JSON `readiness doctor` prints `capture_command` rows when calibration backlog items are missing.

**Step 2: Preserve safety wording**

Make clear that these rows contain placeholders only and still require manual side-effect review before running a probe.

### Task 5: Verification

**Files:**
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`

**Step 1: Run required targeted tests**

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

Expected: Both pass.

**Step 2: Run full suite**

Run: `npm test`

Expected: All tests pass.

**Step 3: Run safety checks**

Run:

```powershell
git diff --check
git diff --name-only
```

Expected: No whitespace errors, and no forbidden local state paths are touched.
