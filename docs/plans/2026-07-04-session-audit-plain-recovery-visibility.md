# Session Audit Plain Output Recovery Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `fixtures audit --scope session` plain-text output expose the blocked automated refresh strategy so operators do not mistake lifecycle evidence for usable recovery.

**Architecture:** Keep the existing read-only session audit JSON contract as the source of truth. Extend only the non-JSON CLI rendering for the session scope to print `recovery_strategy`, `automated_session_refresh_strategy`, and missing coverage names from the already-built audit object. Do not add probes, network calls, fixture reads beyond the existing `verifySession` filter, or any refresh endpoint guesses.

**Tech Stack:** Node.js ESM, native `node:test`, `src/ops-cli.js`, `test/ops-cli.test.js`, and the existing `buildProtocolFixtureAudit({ scope: "session" })` output shape.

---

### Task 1: RED test for session plain output

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `fixtures audit --scope session prints refresh strategy gap in plain output`.

Use an injected `protocolFixtureStore` with:
- one successful `verifySession` fixture;
- one failed `verifySession` fixture classified as `login_required` / HTTP 401;
- one unrelated `sendMessage` fixture that must not be read.

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope session prints refresh strategy"
```

Expected: FAIL because current plain output omits `recovery_strategy` and `automated_session_refresh_strategy`.

### Task 2: GREEN implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Update session plain renderer**

In `handleFixturesAudit()`, session non-JSON output should keep existing lines and append:

```text
recovery_strategy    blocked    manual_reimport_then_probe    not_calibrated
missing    automated_session_refresh_strategy
```

Use the values from `audit.recoveryStrategy` and `audit.missing` so the renderer remains data-driven.

**Step 2: Re-run the focused test**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope session prints refresh strategy"
```

Expected: PASS.

### Task 3: Regression verification

**Files:**
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `README.md`

**Step 1: Document plain output behavior**

State that `fixtures audit --scope session` plain output includes the current manual recovery strategy and the missing `automated_session_refresh_strategy` item. Keep the text explicit that this is read-only and not an automated refresh implementation.

**Step 2: Run required verification**

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

Expected: all pass.

### Task 4: Evidence and safety checks

Run:

```powershell
node bin\tabbit-pool.js fixtures audit --scope session
git diff --check
git status --short --untracked-files=all
```

Expected:
- plain output contains no raw fixture body, cookie, session token, email, prompt, or API key;
- `automated_session_refresh_strategy` is visible when missing;
- only planned files changed in this slice.
