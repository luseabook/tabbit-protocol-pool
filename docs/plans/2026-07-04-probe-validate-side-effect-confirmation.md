# Probe Validate Side Effect Confirmation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicit read-only `probe validate --require-confirmed-side-effect` preflight gate so operators can reject side-effect probe inputs that have not set `confirmSideEffect:true`.

**Architecture:** Keep `probe validate` offline and dependency-free. Reuse the existing operation-aware schema validation and side-effect operation allowlist, then add a stricter optional confirmation check that only applies to known side-effect operations. This does not change `probe protocol`, fixture audit semantics, or any real endpoint/body assumptions.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()` helpers, and CLI docs.

---

### Task 1: RED Test for Missing Side-Effect Confirmation

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `probe validate --require-confirmed-side-effect rejects unconfirmed side-effect input`.

The test should:
- write a temp JSON file for `sendVerificationCode` with a synthetic email, `confirmSideEffect:false`, and a body object;
- run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "require-confirmed-side-effect"
```

through:

```js
runProtocolPoolCli([
  "probe", "validate",
  "--operation", "sendVerificationCode",
  "--input-file", inputFile,
  "--require-confirmed-side-effect",
  "--json",
], ...)
```

- assert exitCode `2`;
- assert stderr mentions `confirmSideEffect:true`;
- assert no account, secret, fixture, or protocol-probe dependency is touched;
- assert stdout is empty and stderr does not leak the synthetic email or body values.

**Step 2: Verify RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "require-confirmed-side-effect"
```

Expected: FAIL because the new strict flag is ignored and the command exits 0.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add help text**

Update the help line:

```text
tabbit-pool probe validate [--operation <name>] [--input-json <json> | --input-file <path>] [--require-confirmed-side-effect] [--json]
```

**Step 2: Add confirmation helper**

Near the probe validation helpers, add:

```js
function assertConfirmedSideEffectInput(input, operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (!SIDE_EFFECT_PROBE_OPERATIONS.has(cleanOperation)) return;
  if (!input || input.confirmSideEffect !== true) {
    throw new CliUsageError(
      "Probe input for " + cleanOperation + " requires confirmSideEffect:true before side-effect capture.",
      { code: "SIDE_EFFECT_CONFIRMATION_REQUIRED" },
    );
  }
}
```

**Step 3: Route the flag**

In `handleProbeValidate()`, after `validateProbeInputForOperation(input, operation)`, call the helper only when `--require-confirmed-side-effect` is present.

**Step 4: Verify GREEN**

Run the focused command again. Expected: PASS.

### Task 3: Confirm Non-Side-Effect Compatibility

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add compatibility test**

Add a test named `probe validate --require-confirmed-side-effect allows read-only operations`.

The test should run:

```js
runProtocolPoolCli([
  "probe", "validate",
  "--operation", "verifySession",
  "--require-confirmed-side-effect",
  "--json",
], ...)
```

Expected output:

```js
{
  status: "valid",
  operation: "verifySession",
  sideEffect: false
}
```

No dependencies are touched.

**Step 2: Run focused tests**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "require-confirmed-side-effect"
```

Expected: PASS.

### Task 4: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`

**Step 1: Document the strict preflight**

State that `probe validate --require-confirmed-side-effect` is the recommended final preflight before running a side-effect `probe protocol --write-fixture`.

**Step 2: State the safety boundary**

State that the strict flag remains read-only, does not read account/session/fixture data, and only verifies that a known side-effect operation has `confirmSideEffect:true` in the redacted input file.

### Task 5: Verification

**Files:**
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`

**Step 1: Run required tests**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "require-confirmed-side-effect"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 2: Run safety checks**

```powershell
git diff --check
git status --short --untracked-files=all
```

Confirm no forbidden local state path was touched and added lines contain no real cookie, session, JWT, API key, Bearer token, raw payload, prompt, or real user data.
