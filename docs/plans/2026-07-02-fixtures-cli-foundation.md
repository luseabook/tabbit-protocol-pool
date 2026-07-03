# Fixtures CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-02. Focused RED/GREEN covers fixture listing, sanitized fixture reading, path traversal rejection, CLI list/show wiring, package exports, and safe local-only behavior.

**Goal:** Add a safe local fixture browsing surface for protocol probe fixtures so operators can inspect generated `protocol_probe` samples without opening raw state files or risking secret leakage.

**Architecture:** Extend `FileProtocolFixtureStore` with `listFixtures()`, `readFixture(ref)`, `resolveFixtureRef(ref)`, `ProtocolFixtureStoreError`, and `sanitizeProtocolProbeFixture()`. Wire `runProtocolPoolCli()` to expose `tabbit-pool fixtures list [--json]` and `tabbit-pool fixtures show <ref> [--json]` using the existing default `protocolFixtureStore`.

**Tech Stack:** Node.js ESM, native `node:test`, existing redaction helpers, `FileProtocolFixtureStore`, and local JSON files under `stateDir/fixtures/protocol-probes/`.

---

### Task 1: Store list/read support

**Files:**
- Modify: `test/protocol-probe.test.js`
- Modify: `src/protocol-probe.js`

**Step 1: Write failing tests**

Add tests that prove:

- `listFixtures()` only reads `fixtures/protocol-probes/*.json` with `kind === "protocol_probe"`.
- Returned summaries are sorted newest first and contain no raw response secrets.
- `readFixture(ref)` returns a sanitized fixture even when the file contains raw email, cookie/session/token, `cookieJarRef`, or verification code values.
- Traversal refs such as `fixtures/protocol-probes/../secrets/...` are rejected.

**Step 2: Run RED**

Run: `node --test test/protocol-probe.test.js test/ops-cli.test.js`.

Expected: FAIL because `FileProtocolFixtureStore.listFixtures()` and `readFixture()` do not exist.

**Step 3: Implement minimal code**

Implement store methods, path normalization, structured store errors, and sanitizer reuse.

**Step 4: Run GREEN**

Run focused tests again.

---

### Task 2: CLI commands and exports

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `test/smoke.test.js`
- Modify: `src/ops-cli.js`
- Modify: `src/index.js`

**Step 1: Write failing tests**

Add tests that prove:

- `tabbit-pool fixtures list --json` calls the injected fixture store and prints `{ fixtures }`.
- `tabbit-pool fixtures show <ref> --json` calls the injected fixture store and prints a sanitized fixture document.
- Missing fixture ref returns exitCode 2 and a fixture-ref error.
- Package entry exports `ProtocolFixtureStoreError` and `sanitizeProtocolProbeFixture`.

**Step 2: Run RED**

Run focused tests.

Expected: FAIL because the commands are unknown and exports are absent.

**Step 3: Implement minimal code**

- Add help text for fixture commands.
- Add `fixtures list` and `fixtures show` handlers.
- Preserve fixture-store `exitCode` in CLI catch handling.
- Export the new store error and sanitizer.

**Step 4: Run GREEN**

Run focused tests again.

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

Document fixture list/show commands, path safety, output shapes, sanitizer behavior, and verification evidence.

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

2026-07-02 verification after documentation sync:

- PASS: `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js` — 24 pass / 0 fail.
- PASS: `npm test` in `tabbit-protocol-pool` — 132 pass / 0 fail.
- PASS: root `npm test` — 202 pass / 0 fail.
- PASS: `node bin/tabbit-pool.js --help` includes `tabbit-pool fixtures list [--json]` and `tabbit-pool fixtures show <ref> [--json]`.
- PASS: Markdown local-link scan over 60 Markdown files — 0 broken local links.
- PASS: Markdown sensitive placeholder scan — 0 live-format key/cookie/token findings.
- PASS: trailing whitespace scan for `.md`, `.js`, and `.json` in `tabbit-protocol-pool` — 0 findings.
- PASS: `git diff --check -- tabbit-protocol-pool` — clean.

Documentation additions completed in this slice:

- README now lists fixture list/show as part of the implemented local ops CLI surface.
- M08 operations doc now includes `fixtures list` / `fixtures show` command reference, output shapes, path-safety rules, and redaction boundaries.
- API docs now describe CLI fixture commands and default dependency wiring.
- Implementation reference now documents `sanitizeProtocolProbeFixture()`, `FileProtocolFixtureStore.listFixtures()`, `FileProtocolFixtureStore.readFixture()`, and `ProtocolFixtureStoreError`.
- Test plan now includes T47 for fixture list/show behavior.
