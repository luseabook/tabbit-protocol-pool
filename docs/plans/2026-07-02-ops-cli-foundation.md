# Ops CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented on 2026-07-02. Verified with focused CLI/smoke tests, protocol-pool `npm test`, root `npm test`, Markdown local-link scan, Markdown sensitive placeholder scan, and `git diff --check -- tabbit-protocol-pool`.

**Goal:** Add an offline-testable M08 operations CLI foundation for account listing, health summary, maintenance action execution, and protocol probe advice without requiring real Tabbit network endpoints.

**Architecture:** Introduce `src/ops-cli.js` as a testable command dispatcher with injectable stores and maintainers, plus `bin/tabbit-pool.js` as the executable wrapper. The CLI reads account metadata from `JsonAccountStore`, uses `observability.js` for summaries/redaction/logs, and uses `BenefitsMaintainer` with an empty protocol client by default so maintenance is safe and skipped until real protocol operations are injected.

**Tech Stack:** Node.js ESM, native `node:test`, existing `loadConfig`, `JsonAccountStore`, `BenefitsMaintainer`, and `observability` helpers.

---

### Task 1: accounts list and health

**Files:**
- Create: `test/ops-cli.test.js`
- Create: `src/ops-cli.js`

**Step 1: Write failing tests**

Add tests for:

- `runProtocolPoolCli(["accounts", "list", "--json"], deps)` loads accounts and prints a redacted account list.
- `runProtocolPoolCli(["accounts", "list"], deps)` prints a readable table without raw email/cookie/session/token/cookieJarRef.
- `runProtocolPoolCli(["health", "--json"], deps)` prints `buildHealthSnapshot()` output with account summary.
- Unknown commands print help to stderr and return exit code 2.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`

Expected: FAIL because `src/ops-cli.js` does not exist.

**Step 3: Implement minimal code**

Implement:

- `runProtocolPoolCli(argv, options)`
- `createProtocolPoolCliDependencies(options)`
- `parseGlobalFlags(argv)`
- accounts list and health handlers.

**Step 4: Run GREEN**

Run: `node --test test/ops-cli.test.js`

Expected: PASS.

---

### Task 2: maintain and probe advice

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`

**Step 1: Write failing tests**

Add tests for:

- `runProtocolPoolCli(["maintain", "--json"], deps)` calls injected `benefitsMaintainer.maintainAccount()` for each account, saves changed accounts, and prints redacted maintenance events.
- Default `maintain --json` with no injected maintainer returns skipped actions instead of hitting network.
- `runProtocolPoolCli(["probe", "advice", "--category", "protocol_changed", "--json"], deps)` prints `protocolProbeAdvice()` output.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`

Expected: FAIL until handlers exist.

**Step 3: Implement minimal code**

Implement maintain and probe advice handlers. Keep all errors JSON-safe and redacted.

**Step 4: Run GREEN**

Run: `node --test test/ops-cli.test.js`

Expected: PASS.

---

### Task 3: executable wrapper, exports, and docs

**Files:**
- Create: `bin/tabbit-pool.js`
- Modify: `package.json`
- Modify: `test/smoke.test.js`
- Modify: `src/index.js`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `README.md`

**Step 1: Write failing tests**

Update smoke tests to assert `runProtocolPoolCli` and `createProtocolPoolCliDependencies` are exported. Add a package metadata test or direct file existence check for `bin/tabbit-pool.js`.

**Step 2: Run RED**

Run: `node --test test/smoke.test.js test/ops-cli.test.js`

Expected: FAIL until exports and bin are added.

**Step 3: Implement minimal code**

Add exports from `src/index.js`, create the bin wrapper, and add `bin` metadata to `package.json`.

**Step 4: Document**

Document that CLI commands are foundation commands: account list and health are fully offline, maintain defaults to skipped protocol operations until real protocol methods are provided, and probe advice is advisory only.

**Step 5: Run full verification**

Implementation note: docs now describe the safe default behavior: account list and health are local-only; maintain defaults to skipped protocol operations; probe advice is advisory only.

Verification evidence on 2026-07-02:

- `node --test test/ops-cli.test.js test/smoke.test.js`: 10 pass / 0 fail.
- `npm test` in `tabbit-protocol-pool`: 118 pass / 0 fail.
- `npm test` in repository root: 188 pass / 0 fail.
- Markdown local-link scan: 57 files, 0 broken local links.
- Markdown sensitive placeholder scan: 0 hits after filtering HMAC-SHA256 false positives.
- `git diff --check -- tabbit-protocol-pool`: exit 0.
- `node bin/tabbit-pool.js --help`: exit 0 and prints CLI usage.

Original verification checklist:

- `npm test` in `tabbit-protocol-pool`.
- `npm test` in repository root.
- Markdown local-link scan.
- Markdown sensitive placeholder scan.
