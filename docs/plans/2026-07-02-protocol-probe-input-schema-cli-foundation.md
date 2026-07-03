# Protocol Probe Input Schema CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-02. Focused RED/GREEN: `node --test test/ops-cli.test.js` first failed because invalid schema payloads still reached the injected runner, then passed after CLI validation was added.

**Goal:** Add operation-aware validation for `tabbit-pool probe protocol --input-json/--input-file` so invalid calibration payloads are rejected before the protocol probe runner is called.

**Architecture:** Keep validation in the CLI layer because malformed CLI payloads are user input errors and should return exitCode 2 without producing misleading protocol fixtures. The validator remains intentionally narrow: it checks only stable fields used by current probe dispatch defaults while allowing unknown fields for future protocol calibration.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()` dependency injection, existing `CliUsageError` and redacted stderr handling.

---

### Task 1: RED tests for schema errors

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing tests**

Add tests for:

- `sendMessage.messages` supplied as an empty array returns exitCode 2 and does not call the injected runner.
- `sendMessage.model` supplied as an empty string returns exitCode 2 and does not leak the raw payload.
- `listModels.force` supplied as a string returns exitCode 2 and does not call the injected runner.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`.

Expected: FAIL because the current CLI only checks that probe input is a JSON object.

---

### Task 2: Minimal CLI validator

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add validator helpers**

Add `validateProbeInputForOperation(input, operation)` and small helpers for non-empty strings and message arrays.

**Step 2: Wire validation before runner call**

In `handleProbeProtocol()`, after reading input and before building `probeRequest`, validate only when input is present.

**Step 3: Error behavior**

Throw `CliUsageError` with exitCode 2 and messages that name the failing field without echoing raw JSON payload values.

**Step 4: Run GREEN**

Run: `node --test test/ops-cli.test.js`.

---

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/03-索引.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`

**Step 1: Update docs**

Document the operation-aware validation rules, the exitCode 2 behavior, and the no-payload-echo redaction boundary.

**Step 2: Verify**

Run:

- `node --test test/ops-cli.test.js test/protocol-probe.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- root `npm test`
- `node bin/tabbit-pool.js --help`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

## Verification evidence

Collected after documentation sync on 2026-07-02:

- RED: `node --test test/ops-cli.test.js` failed with 3 expected failures because invalid `sendMessage.messages`, invalid `sendMessage.model`, and non-boolean `listModels.force` still called the injected runner and returned exitCode 0.
- GREEN focused: `node --test test/ops-cli.test.js`: **25 pass / 0 fail** after adding operation-aware CLI validation.
- Focused + protocol probe + smoke: `node --test test/ops-cli.test.js test/protocol-probe.test.js test/smoke.test.js`: **33 pass / 0 fail**.
- `npm test` in `tabbit-protocol-pool`: **141 pass / 0 fail**.
- Root `npm test` from `E:\tabbit2api`: **211 pass / 0 fail**.
- `node bin/tabbit-pool.js --help`: help still includes `--input-json <json> | --input-file <path>` and `probe template`.
- CLI smoke:
  - `probe protocol --operation sendMessage --input-json '{"messages":[]}'` exits 2 with empty stdout and a `sendMessage.messages` schema message.
  - `probe protocol --operation listModels --input-json '{"force":"yes"}'` exits 2 with empty stdout and a `listModels.force` schema message.
- Markdown local-link scan: **63 Markdown files / 0 broken local links**.
- Markdown sensitive placeholder scan: **0 findings**.
- Markdown trailing-whitespace scan: **0 findings**.
- `git diff --check -- tabbit-protocol-pool`: **clean** for tracked diff; Markdown whitespace scan covers the untracked protocol-pool docs tree.

Documentation updated in `README.md`, M08 module docs, the global docs index, development tracker, API docs, test cases, and implementation reference. The documented behavior now matches the CLI contract: operation-aware validation for stable probe fields, exitCode 2 for schema errors, no runner call on invalid input, and no raw payload echo in stderr.
