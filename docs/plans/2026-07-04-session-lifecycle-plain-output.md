# Session Lifecycle Plain Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `fixtures audit --scope session` plain output expose the aggregate session lifecycle observation window already available in JSON.

**Architecture:** Keep the existing session audit semantics unchanged. JSON already includes `lifecycle.lastSuccessfulAt`, `lifecycle.lastExpiredAt`, and `lifecycle.observedWindowMs`; add a single plain-output line that prints those aggregate values without reading extra fixture bodies or exposing raw session material. This helps operators observe cookie expiry windows while `automated_session_refresh_strategy` remains blocked until real recovery evidence exists.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"session" })`, and `tabbit-pool fixtures audit --scope session`.

---

### Task 1: RED CLI Plain Lifecycle Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Extend `fixtures audit --scope session prints refresh strategy gap in plain output`.

Expected plain output should include:

```text
session_lifecycle	last_successful_at=2026-07-02T03:00:00.000Z	last_expired_at=2026-07-03T03:00:00.000Z	observed_window_ms=86400000
```

The test must continue asserting:
- `recovery_strategy` remains `blocked	manual_reimport_then_probe	not_calibrated`;
- `recovery_strategy_rejected	1` is printed;
- `missing	automated_session_refresh_strategy` is printed;
- raw user id, cookie, session, token, and non-session fixture content are not printed.

**Step 2: Run RED**

```powershell
node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js
```

Expected before implementation: FAIL because the `session_lifecycle` line is not printed.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add lifecycle plain line**

In the `scope === "session"` branch of `handleFixturesAudit()`, read `audit.lifecycle || {}` and add:

```js
"session_lifecycle\tlast_successful_at=" + (lifecycle.lastSuccessfulAt || "")
  + "\tlast_expired_at=" + (lifecycle.lastExpiredAt || "")
  + "\tobserved_window_ms=" + (Number.isFinite(lifecycle.observedWindowMs) ? lifecycle.observedWindowMs : ""),
```

Place it near `session_missing` and `recovery_strategy`.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document operator semantics**

State that session scope plain output includes a `session_lifecycle` line with aggregate `last_successful_at`, `last_expired_at`, and `observed_window_ms`. This is observation evidence only; it does not satisfy `automated_session_refresh_strategy`.

### Task 4: Verification

**Focused checks:**

```powershell
node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files. Confirm sensitive paths remain untouched.

---

## Execution Status

- RED verified: `node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js` initially failed because plain session audit did not print `session_lifecycle`.
- GREEN verified: `src/ops-cli.js` now prints `session_lifecycle	last_successful_at=...	last_expired_at=...	observed_window_ms=...` in session scope plain output.
- Focused check: `node --test --test-name-pattern "refresh strategy gap" test\ops-cli.test.js` -> 1/1 pass.
- Documentation updated: README, real protocol acceptance doc, and M08 ops doc now state that `session_lifecycle` is aggregate observation evidence only and does not satisfy `automated_session_refresh_strategy`.
- Full required verification:
  - `node --test test\ops-cli.test.js` -> 108/108 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 413/413 pass.
  - `git diff --check` -> exit 0, with LF-to-CRLF working-copy warnings only.
  - Forbidden path scan -> 29 changed/untracked paths, 0 hits.
  - Strict credential-shape scan -> 3341 added/untracked lines, 0 hits.
  - `fixtures audit --scope session --json` -> blocked with missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, `automated_session_refresh_strategy`.
  - `fixtures audit --scope upstream --json` -> blocked with missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, `real_upstream_backpressure_fixture`.
