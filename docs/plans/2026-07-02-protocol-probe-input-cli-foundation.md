# Protocol Probe Input CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-02. Focused RED/GREEN: `node --test test/ops-cli.test.js` covers inline JSON input, file JSON input, invalid JSON redaction, and runner input plumbing. Full verification passed after docs sync.

**Goal:** Let `tabbit-pool probe protocol` accept explicit JSON probe input so real endpoint calibration can record reproducible `sendMessage` and `listModels` fixtures without changing code for every payload.

**Architecture:** Extend the CLI layer only. `ProtocolProbeRunner` already accepts `input`; `runProtocolPoolCli()` now parses either `--input-json <json>` or `--input-file <path>`, validates that the parsed value is a JSON object, and passes it to `probeAccount({ input })`. Invalid user input becomes a CLI usage error with exitCode 2 and does not echo the raw payload.

**Tech Stack:** Node.js ESM, native `node:test`, existing CLI dependency injection and redaction helpers.

---

### Task 1: CLI input tests

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing tests**

Add tests for:

- `probe protocol --input-json <json>` parses a JSON object and passes it as `input` to the injected `protocolProbeRunner.probeAccount()`.
- `probe protocol --input-file <path>` reads a UTF-8 JSON file and passes the parsed object as `input`.
- Invalid `--input-json` returns exitCode 2, does not call the runner, and does not leak raw token/code payload text to stderr.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`.

Expected: FAIL because existing CLI ignores probe input flags and accepts invalid JSON by continuing to the runner.

---

### Task 2: Minimal implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Implement parser**

- Add `--input-json` and `--input-file` help text.
- Add a CLI usage error carrying `exitCode: 2`.
- Parse exactly one input source.
- Require parsed input to be a JSON object.
- Avoid including raw payload text in parser error messages.

**Step 2: Wire request**

Pass parsed input only when present, preserving existing command call shape when no input is supplied.

**Step 3: Run GREEN**

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

Document command syntax, input source rules, object requirement, error behavior, redaction boundary, and examples.

**Step 2: Verify**

Run:

- `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- root `npm test`
- `node bin/tabbit-pool.js --help`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

## Verification evidence

Collected after documentation sync on 2026-07-02:

- `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js` in `tabbit-protocol-pool`: **27 pass / 0 fail**.
- `npm test` in `tabbit-protocol-pool`: **135 pass / 0 fail**.
- Root `npm test` from `E:\tabbit2api`: **205 pass / 0 fail**.
- `node bin/tabbit-pool.js --help`: help includes `--input-json <json> | --input-file <path>` for `probe protocol`.
- Markdown local-link scan: **61 Markdown files / 0 broken local links**.
- Markdown sensitive placeholder scan: **0 findings**.
- Markdown trailing-whitespace scan: **0 findings**.
- `git diff --check -- tabbit-protocol-pool`: **clean**.

Documentation updated in `README.md`, M08 module docs, the global docs index, development tracker, API docs, test cases, and implementation reference. The documented behavior now matches the CLI contract: exactly one input source, JSON-object-only payloads, exitCode 2 for usage errors, and redacted stderr without raw payload echo.
