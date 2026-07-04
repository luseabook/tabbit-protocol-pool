# Probe Input Validation Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only `tabbit-pool probe validate` command that validates captured probe input files and prints a redacted shape preview before any real protocol probe is run.

**Architecture:** Reuse the existing `readProbeInput()` and `validateProbeInputForOperation()` logic from `src/ops-cli.js` so `probe validate` and `probe protocol` enforce the same schema. The command must not read accounts, secrets, fixture bodies, or network dependencies; it only parses the supplied JSON input, validates it for the selected operation, and returns field-presence/body-key metadata without raw values.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()` and CLI parser helpers.

---

### Task 1: RED Test for Auth Input Preview

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `probe validate --json validates auth input without leaking values`.

The test should:
- create a temp JSON file containing a realistic `submitRegistrationOrLogin` input with `confirmSideEffect:true`, an email, a code, and a body object containing additional captured body keys;
- run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "probe validate --json validates auth input without leaking values"
```

through `runProtocolPoolCli(["probe", "validate", "--operation", "submitRegistrationOrLogin", "--input-file", inputFile, "--json"], ...)`;
- assert exitCode 0;
- assert no `accountStore`, `secretStore`, `protocolProbeRunner`, or `protocolFixtureStore` method is called;
- assert output JSON includes:

```js
{
  status: "valid",
  operation: "submitRegistrationOrLogin",
  source: "input",
  sideEffect: true,
  confirmSideEffect: true,
  fields: {
    email: "present",
    code: "present",
    body: "object"
  },
  bodyKeys: ["captchaToken", "code", "email", "scene"]
}
```

The output must not contain the raw email, code, captcha token, raw body values, cookie, session, or token strings.

**Step 2: Verify RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "probe validate --json validates auth input without leaking values"
```

Expected: FAIL because `probe validate` is not routed yet.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add help text**

Add:

```text
tabbit-pool probe validate [--operation <name>] [--input-json <json> | --input-file <path>] [--json]
```

**Step 2: Add a redacted preview helper**

Add helpers near the probe input validation code:

```js
const SIDE_EFFECT_PROBE_OPERATIONS = new Set([...]);

function probeInputFieldState(input, key) { ... }

function buildProbeInputValidationPreview({ operation, input }) { ... }
```

The preview should include only shape metadata:
- `status:"valid"`;
- normalized operation;
- `source:"input"` when an input is supplied and `source:"default"` when no input is supplied;
- `sideEffect` from a fixed side-effect operation allowlist;
- `confirmSideEffect` only when the input contains that field;
- `fields` for top-level keys with values `present`, `missing`, `object`, `array`, or primitive type names;
- sorted `bodyKeys` when `body` is an object;
- sorted `attachmentKeys` when `attachment` is an object.

**Step 3: Add handler and route**

Add `handleProbeValidate(args, stdout)`:

```js
const operation = valueAfter(args, "--operation") || "verifySession";
const input = await readProbeInput(args);
validateProbeInputForOperation(input, operation);
const preview = buildProbeInputValidationPreview({ operation, input });
...
```

For non-JSON output, print one line with `status`, `operation`, `side_effect`, and `confirm_side_effect`.

Route `probe validate` before `probe protocol`.

**Step 4: Verify GREEN**

Run the focused test again. Expected: PASS.

### Task 3: Error Path Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add invalid input test**

Add `probe validate rejects invalid auth input before touching dependencies`:
- pass an input file with `confirmSideEffect:"yes"` or missing `code`;
- inject dependencies that throw if called;
- assert exitCode 2;
- assert stderr mentions schema validation but does not leak raw email/code/body values.

**Step 2: Run focused validation tests**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "probe validate"
```

Expected: PASS.

### Task 4: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/04-开发追踪.md`

**Step 1: Document the command**

Document `probe validate` as the recommended preflight before converting a `capture_command` placeholder into a real `probe protocol` call.

**Step 2: State the safety boundary**

State that it does not read accounts/secrets, does not execute network/probes, and prints only presence/type/body-key metadata.

### Task 5: Verification

**Files:**
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`

**Step 1: Run required tests**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 2: Run safety checks**

```powershell
git diff --check
git status --short --untracked-files=all
```

Confirm no forbidden local state path was modified and added lines contain no real cookie/session/JWT/API key/Bearer token/raw payload/prompt/real user data.
