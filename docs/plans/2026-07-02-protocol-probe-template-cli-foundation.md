# Protocol Probe Template CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-02. Focused RED/GREEN: `node --test test/ops-cli.test.js` first failed on the missing `probe template` command, then passed after the minimal CLI dispatcher and template helper were added. Full verification passed after docs sync.

**Goal:** Let `tabbit-pool probe template` emit safe JSON payload templates that can be copied into `probe protocol --input-json` or `--input-file` during real endpoint calibration.

**Architecture:** Extend the M08 CLI layer only. The command selects one of the supported protocol probe operations and prints a JSON object without account identifiers, cookies, tokens, or live secrets. Unsupported operations are CLI usage errors with exitCode 2 and do not echo user-supplied raw operation text.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()` dispatcher, existing JSON formatting and CLI usage error handling.

---

### Task 1: CLI template tests

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing tests**

Add tests for:

- `probe template --operation sendMessage --json` returns:

  ```json
  {
    "model": "tabbit/priority",
    "messages": [{ "role": "user", "content": "ping" }]
  }
  ```

- `probe template --operation listModels --json` returns:

  ```json
  { "force": true }
  ```

- Unsupported operations return exitCode 2 and do not emit stdout.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`.

Expected: FAIL because the existing dispatcher does not know `probe template`.

---

### Task 2: Minimal implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add templates**

Create an internal `PROBE_INPUT_TEMPLATES` map for `verifySession`, `sendMessage`, and `listModels`.

**Step 2: Add command handler**

Add `handleProbeTemplate()` and route `probe template` to it. The command writes formatted JSON and returns exitCode 0.

**Step 3: Add usage text and error behavior**

Update help output with `tabbit-pool probe template [--operation <name>] [--json]`. Reject unknown operations with `CliUsageError` exitCode 2.

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

Document command syntax, supported operations, emitted JSON objects, safe placeholder boundary, and unsupported operation exitCode 2.

**Step 2: Verify**

Run:

- `node --test test/ops-cli.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- root `npm test`
- `node bin/tabbit-pool.js --help`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

## Verification evidence

Collected after documentation sync on 2026-07-02:

- RED: `node --test test/ops-cli.test.js` failed with 3 expected failures because `probe template` was missing from the dispatcher/help.
- GREEN focused: `node --test test/ops-cli.test.js`: **22 pass / 0 fail** after adding the handler and templates.
- Focused + smoke: `node --test test/ops-cli.test.js test/smoke.test.js`: **24 pass / 0 fail**.
- `npm test` in `tabbit-protocol-pool`: **138 pass / 0 fail**.
- Root `npm test` from `E:\tabbit2api`: **208 pass / 0 fail**.
- `node bin/tabbit-pool.js --help`: help includes `tabbit-pool probe template [--operation <name>] [--json]`.
- Template smoke:
  - `probe template --operation sendMessage --json` exits 0 and emits `tabbit/priority` with a `ping` message.
  - `probe template --operation listModels --json` exits 0 and emits `{ "force": true }`.
  - Unsupported operation exits 2 with empty stdout and a supported-operation-only stderr message.
- Markdown local-link scan: **62 Markdown files / 0 broken local links**.
- Markdown sensitive placeholder scan: **0 findings**.
- Markdown trailing-whitespace scan: **0 findings**.
- `git diff --check -- tabbit-protocol-pool`: **clean** for tracked diff; Markdown whitespace scan covers the untracked protocol-pool docs tree.

Documentation updated in `README.md`, M08 module docs, the global docs index, development tracker, API docs, test cases, and implementation reference. The documented behavior now matches the CLI contract: fixed safe templates, no account/secret reads, default `verifySession`, and exitCode 2 for unsupported operations.
