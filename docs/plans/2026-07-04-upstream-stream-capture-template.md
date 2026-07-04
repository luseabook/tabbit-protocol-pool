# Upstream Stream Capture Template Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the safe `sendMessage` probe template suitable for real upstream stream boundary calibration by defaulting it to `stream:true`.

**Architecture:** Keep readiness/audit semantics unchanged and do not run protocol probes. Tighten only the offline `probe template` and `probe validate` path so upstream error-frame, cancellation, and backpressure capture commands produce a stream-capable input file that operators can review before any real probe.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()`, `ProtocolProbeRunner`, and Markdown docs.

---

### Task 1: RED Test the SendMessage Template

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add the failing test**

Add a test named `probe template for sendMessage defaults to stream capture input`.

Assertions:
- `node bin\tabbit-pool.js probe template --operation sendMessage --json` returns `stream:true`.
- The template keeps only synthetic model/message content.
- The serialized output does not contain cookie, token, session, API key, Bearer, JWT, prompt, raw payload, or user data shapes.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage defaults to stream capture input"
```

Expected: FAIL because the current template omits `stream:true`.

### Task 2: RED Test Validation Preview

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add the failing validation assertion**

Extend the same test or add a companion assertion that `probe validate --operation sendMessage --input-json <template> --json` returns a preview with `fields.stream === true`.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage defaults to stream capture input"
```

Expected: FAIL until the validate preview exposes the stream flag.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Update template**

Add `stream: true` to `PROBE_INPUT_TEMPLATES.sendMessage`.

**Step 2: Update sendMessage schema**

Allow optional boolean `stream` during `validateProbeInputForOperation()` for `sendMessage`.

**Step 3: Update validation preview**

For `sendMessage`, add `fields.stream` when the input includes a boolean stream flag.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`

**Step 1: Document the safer default**

State that `probe template --operation sendMessage` now emits `stream:true` so the upstream capture command path is aligned with stream boundary evidence collection.

**Step 2: Preserve boundaries**

Clarify that the template and validation preview are offline and do not satisfy `fixtures audit --scope upstream`; real coverage still requires sanitized upstream evidence markers.

### Task 5: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused checks**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage defaults to stream capture input"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

**Step 2: Full checks**

```powershell
npm test
git diff --check
```

**Step 3: Safety checks**

Run forbidden-path and credential-shape scans over the diff. Expected: no `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, or `.omx/` edits; no real cookie/session/JWT/API key/Bearer/raw payload/prompt/user data in changes.

---

## Execution Status

Updated: 2026-07-04

- [x] Task 1 RED test added in `test/ops-cli.test.js`.
- [x] Task 2 validation preview assertion added for `fields.stream`.
- [x] Task 3 implementation added in `src/ops-cli.js`.
- [x] Task 4 docs updated in README, `docs/13-真实协议校准与端到端验收.md`, and M08 operations docs.
- [x] Task 5 verification completed.

## Verification Evidence

- RED: `node --test test\ops-cli.test.js --test-name-pattern "sendMessage defaults to stream capture input"` failed as expected because `probe template --operation sendMessage` omitted `stream:true`.
- GREEN focused: `node --test test\ops-cli.test.js --test-name-pattern "sendMessage defaults to stream capture input"` passed.
- `node --test test\ops-cli.test.js`: 81/81 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 355/355 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings were emitted.
- forbidden path scan: clean for `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, and `.omx`.
- credential-shape diff scan: clean for real Bearer/JWT/OpenAI key/session/token/cookie shapes after excluding documented synthetic test placeholders.

## Boundary Notes

This change does not run `probe protocol`, does not write fixtures, and does not satisfy `fixtures audit --scope upstream`. It only makes the offline sendMessage input template and validation preview line up with the existing upstream stream boundary capture workflow.
