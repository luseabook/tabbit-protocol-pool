# Upstream Template Command Stream Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make upstream `readiness doctor` capture commands generate ready `sendMessage` stream evidence template commands, so operators do not need to hand-copy `recommendedInput.streamEvidence` into JSON.

**Architecture:** Keep `recommendedInput.streamEvidence` as structured metadata. For upstream missing items only, derive `templateCommand` from that same metadata and append `--stream-evidence <mode>` plus `--max-deltas <n>` only when needed. Do not change `validateCommand`, `probeCommand`, readiness gates, fixture audit semantics, or real upstream evidence requirements.

**Safety boundary:** The command must contain only a safe mode name and delta count. It must not include prompt text, endpoint values, account ids, cookie/session/JWT/API key/Bearer values, raw payloads, local fixture contents, or real user data.

---

### Task 1: RED JSON Doctor Test

**Files:**
- Modify: `test/observability.test.js`

Update the upstream assertions in `buildReadinessDoctorReport includes safe calibration capture commands`:

- `real_upstream_error_frame_fixture.templateCommand` includes `--stream-evidence error_frame --json`;
- `real_upstream_cancellation_fixture.templateCommand` includes `--stream-evidence cancel_after_first_delta --json`;
- `real_upstream_backpressure_fixture.templateCommand` includes `--stream-evidence first_token_backpressure --json`;
- no command includes raw prompt, endpoint values, account ids, session/cookie/token-like text, or real user data.

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"
```

Expected before implementation: FAIL because upstream template commands still use generic `probe template --operation sendMessage --json`.

### Task 2: RED Plain Doctor Test

**Files:**
- Modify: `test/ops-cli.test.js`

Update `readiness doctor prints calibration backlog in plain output` so each upstream `capture_command` line includes the direct template command:

- `template=node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence error_frame --json`
- `template=node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence cancel_after_first_delta --json`
- `template=node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence first_token_backpressure --json`

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output"
```

Expected before implementation: FAIL because plain output still prints the generic template command.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

Add a helper that builds a probe template command from `operation` and optional `recommendedInput.streamEvidence`.

Rules:
- If there is no stream evidence metadata, preserve the existing command exactly.
- If metadata exists, append `--stream-evidence <mode>`.
- Append `--max-deltas <n>` only when `maxDeltas` is a positive integer other than the template default of `2`.
- Always end with `--json`.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: this plan file

Document that upstream capture commands now include direct `probe template --stream-evidence ... --json` commands while still requiring operator review, `probe validate`, real probe execution, and sanitizer-only persistence.

### Task 5: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"
node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Run forbidden-path and credential-shape scans over tracked and untracked changed files. Expected: 0 forbidden hits and 0 credential-shaped hits.

## Execution Status - 2026-07-04

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"` failed because upstream `templateCommand` still used generic `probe template --operation sendMessage --json`.
  - `node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output"` failed because plain `capture_command` template fields still used the generic sendMessage template.
- GREEN implementation:
  - `src/observability.js` now derives `templateCommand` from `recommendedInput.streamEvidence`; upstream error-frame, cancellation, and backpressure commands emit `--stream-evidence error_frame`, `--stream-evidence cancel_after_first_delta`, or `--stream-evidence first_token_backpressure`.
  - Non-upstream template commands remain unchanged, and default `maxDeltas:2` is not redundantly printed as `--max-deltas`.
- Focused verification:
  - `node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"` passed 39/39.
  - `node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output"` passed 108/108.
- Required verification:
  - `node --test test\ops-cli.test.js` passed 108/108.
  - `node --test test\protocol-tabbit-client.test.js` passed 61/61.
  - `npm test` passed 408/408.
  - `git diff --check` exited 0 with only line-ending conversion warnings.
- Safety verification:
  - Forbidden-path scan checked 24 changed or untracked paths with 0 hits.
  - Credential-shape scan checked 2325 added or untracked lines with 0 hits.
