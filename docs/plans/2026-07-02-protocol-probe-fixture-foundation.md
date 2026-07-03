# Protocol Probe Fixture Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-02. Focused RED/GREEN covers fixture redaction, runner behavior, CLI wiring, exports, and safe default no-network behavior; docs now record schema, CLI boundaries, and verification evidence.

**Goal:** Add a safe protocol probe fixture foundation that can run an injected protocol probe, emit a redacted reproducible fixture, and expose it through `tabbit-pool probe protocol` without requiring real Tabbit network access by default.

**Architecture:** Introduce `src/protocol-probe.js` with three public surfaces: `buildProtocolProbeFixture()` for deterministic redacted fixture creation, `FileProtocolFixtureStore` for writing sanitized JSON fixtures under `stateDir/fixtures/protocol-probes/`, and `ProtocolProbeRunner` for account/session hydration plus injected protocol operation dispatch. Wire `runProtocolPoolCli()` to call an injectable `protocolProbeRunner`; default dependencies create a safe runner with no protocol client factory, so the command reports skipped/missing configuration instead of guessing unknown Tabbit endpoints.

**Tech Stack:** Node.js ESM, native `node:test`, existing `JsonAccountStore`, `FileSecretStore`, `redactObject`, `redactAccountForDisplay`, and `protocolProbeAdvice`.

---

### Task 1: Protocol probe fixture module

**Files:**
- Create: `test/protocol-probe.test.js`
- Create: `src/protocol-probe.js`

**Step 1: Write failing tests**

Add tests for:

- `buildProtocolProbeFixture()` redacts email, cookies, session tokens, bearer tokens, and 4-8 digit verification codes while preserving operation/status/advice.
- `ProtocolProbeRunner.probeAccount({ accountId, operation })` returns a failed `session_missing` fixture when the account has no readable local secret.
- `ProtocolProbeRunner` hydrates the runtime account for an injected `verifySession` operation, writes a fixture when requested, and never leaks the raw session into the fixture.
- `FileProtocolFixtureStore.writeFixture()` writes JSON below `stateDir/fixtures/protocol-probes/` and returns a relative ref.

**Step 2: Run RED**

Run: `node --test test/protocol-probe.test.js`.

Expected: FAIL because `src/protocol-probe.js` does not exist.

**Step 3: Implement minimal code**

Implement:

- `buildProtocolProbeFixture(input)`.
- `FileProtocolFixtureStore`.
- `ProtocolProbeRunner` with operation support for `verifySession`, `sendMessage`, and `listModels`, but no default network client.

**Step 4: Run GREEN**

Run: `node --test test/protocol-probe.test.js`.

Expected: PASS.

---

### Task 2: CLI wiring and exports

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `test/smoke.test.js`
- Modify: `src/ops-cli.js`
- Modify: `src/index.js`

**Step 1: Write failing tests**

Add tests for:

- `runProtocolPoolCli(["probe", "protocol", "--account", "acct_a", "--operation", "verifySession", "--write-fixture", "--json"], deps)` calls an injected `protocolProbeRunner.probeAccount()` and prints its redacted fixture/advice.
- Missing `--account` returns exit code 2 and a specific account id error.
- `src/index.js` exports `ProtocolProbeRunner`, `FileProtocolFixtureStore`, and `buildProtocolProbeFixture`.

**Step 2: Run RED**

Run: `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js`.

Expected: FAIL until CLI wiring and exports are added.

**Step 3: Implement minimal code**

- Add default `protocolProbeRunner` dependency in `createProtocolPoolCliDependencies()`.
- Add `probe protocol --account <id> [--operation <name>] [--write-fixture] [--json]` route.
- Export probe APIs from `src/index.js`.

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

Document that `probe protocol` is a fixture-producing foundation command. It does not hit real Tabbit unless a protocol client factory is injected/configured later.

**Step 2: Verify**

Run:

- `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- root `npm test`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

## Verification evidence

2026-07-02 verification after documentation sync:

- PASS: `node --test test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js` — 19 pass / 0 fail.
- PASS: `npm test` in `tabbit-protocol-pool` — 127 pass / 0 fail.
- PASS: root `npm test` — 197 pass / 0 fail.
- PASS: `node bin/tabbit-pool.js --help` includes `tabbit-pool probe protocol --account <id> [--operation <name>] [--write-fixture] [--json]`.
- PASS: Markdown local-link scan over 59 Markdown files — 0 broken local links.
- PASS: Markdown sensitive placeholder scan — 0 live-format key/cookie/token findings.
- PASS: trailing whitespace scan for `.md`, `.js`, and `.json` in `tabbit-protocol-pool` — 0 findings.
- PASS: `git diff --check -- tabbit-protocol-pool` — clean.

Documentation additions completed in this slice:

- M08 operations doc now includes the `protocol_probe` fixture schema, status/category boundaries, and safe no-network default.
- API docs now state supported probe operations and fixture fields.
- Implementation reference now documents `ProtocolProbeFixture`, `ProtocolProbeRunnerResult`, default CLI dependencies, injected protocol probe hooks, and redaction boundaries.
