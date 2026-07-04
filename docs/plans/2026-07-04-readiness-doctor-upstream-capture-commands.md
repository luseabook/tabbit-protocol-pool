# Readiness Doctor Upstream Capture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe `readiness doctor` capture command hints for real upstream stream boundary evidence: error frame, cancellation, and backpressure.

**Architecture:** Reuse the existing `calibrationBacklog.captureCommands` contract. Add upstream specs that map the three upstream missing names to placeholder-only `sendMessage` probe commands with `TABBIT_POOL_PROTOCOL_SEND_PATH` as a prerequisite. Do not relax `fixtures audit --scope upstream`; real coverage still requires sanitized `sendMessage` fixtures with explicit real-upstream evidence markers.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `plainCaptureCommandLines()`, `runProtocolPoolCli()`, and Markdown docs.

---

### Task 1: RED Tests for Upstream Capture Commands

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Extend JSON helper test**

In `buildReadinessDoctorReport includes safe calibration capture commands`, assert the upstream missing items now have capture commands:

```js
assert.equal(byMissing.real_upstream_error_frame_fixture.scope, "upstream");
assert.equal(byMissing.real_upstream_error_frame_fixture.operation, "sendMessage");
assert.equal(byMissing.real_upstream_error_frame_fixture.sideEffect, false);
assert.equal(byMissing.real_upstream_error_frame_fixture.prerequisitesStatus, "ready");
assert.deepEqual(byMissing.real_upstream_error_frame_fixture.prerequisites, [{
  name: "protocol_send_endpoint",
  env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
  status: "configured",
}]);
assert.match(byMissing.real_upstream_error_frame_fixture.probeCommand, /probe protocol --account <account-id> --operation sendMessage/);
```

Add equivalent assertions for `real_upstream_cancellation_fixture` and `real_upstream_backpressure_fixture`.

**Step 2: Extend CLI JSON test**

In `readiness doctor --json includes auth and benefits backlog without running probes`, assert that all three upstream capture commands exist, use `operation:"sendMessage"`, have `prerequisitesStatus:"ready"` when `sendPath` is configured, and do not contain raw payloads.

**Step 3: Extend plain doctor test**

In `readiness doctor prints calibration backlog in plain output`, assert plain rows include:

```text
capture_command    real_upstream_error_frame_fixture    upstream    side_effect=false ... prereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured
capture_command    real_upstream_cancellation_fixture   upstream    side_effect=false ... prereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured
capture_command    real_upstream_backpressure_fixture   upstream    side_effect=false ... prereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured
```

**Step 4: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because upstream capture commands are currently omitted.

### Task 2: Implement Upstream Capture Specs

**Files:**
- Modify: `src/observability.js`

**Step 1: Add a send-path prerequisite**

For each upstream missing item, add:

```js
prerequisites: [{
  name: "protocol_send_endpoint",
  env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
  protocolKey: "sendPath",
}]
```

**Step 2: Add upstream capture specs**

Map:

- `real_upstream_error_frame_fixture`
- `real_upstream_cancellation_fixture`
- `real_upstream_backpressure_fixture`

to `scope:"upstream"`, `operation:"sendMessage"`, `sideEffect:false`, and specific reasons explaining that the input file must be redacted and must later produce sanitized fixture evidence with explicit real-upstream markers.

**Step 3: Run GREEN**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`

**Step 1: Document upstream capture command hints**

State that doctor now prints placeholder-only upstream `sendMessage` capture commands for error-frame, cancellation, and backpressure gaps.

**Step 2: Preserve evidence boundary**

Clarify that these commands do not prove upstream boundary coverage; `fixtures audit --scope upstream` still requires sanitized fixtures with real-upstream markers, and local/fake stream samples do not count.

### Task 4: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused verification**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

**Step 2: Full verification**

```powershell
npm test
git diff --check
```

**Step 3: State and boundary checks**

Run aggregate-only external state checks and forbidden path / credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and external state reports upstream capture commands with `TABBIT_POOL_PROTOCOL_SEND_PATH:configured`.

---

## Execution Status

Updated: 2026-07-04

- [x] Task 1 test coverage is present for JSON doctor commands, plain doctor rows, operation/scope metadata, prerequisite status, and placeholder-only command text.
- [x] Task 2 implementation is present in `src/observability.js` through upstream `sendMessage` capture specs gated by `TABBIT_POOL_PROTOCOL_SEND_PATH`.
- [x] Task 3 docs are present in README, M08 operations docs, and M01 protocol docs, including the boundary that doctor hints do not satisfy upstream fixture audit by themselves.
- [x] Task 4 fresh verification evidence for this continuation is recorded below.

## Verification Evidence

Fresh verification for this continuation:

- `node --test test\observability.test.js`: 33/33 pass.
- `node --test test\ops-cli.test.js`: 80/80 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 354/354 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings were emitted.
- aggregate-only external state checks using `E:\tabbit2api\output\tabbit-live-state`: doctor=ready, readiness=ready, default fixture audit=ready, auth=blocked, benefits=blocked, session=blocked, upstream=blocked, calibration backlog missing=10, remainingWork=0.
- upstream capture command prerequisites in external-state doctor: `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture` all report `operation=sendMessage`, `sideEffect=false`, and `TABBIT_POOL_PROTOCOL_SEND_PATH:configured`.
- forbidden path status scan: clean for `tabbit-cookie.txt`, `output/`, `.agents/`, `.codex/`, and `.omx/`.
- credential-shape diff scan: clean for Bearer/JWT/OpenAI key/session/token patterns.
