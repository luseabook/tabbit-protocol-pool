# Accounts Probe CLI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented on 2026-07-02. Verified with focused ops/smoke tests, protocol-pool `npm test`, root `npm test`, CLI help, Markdown local-link scan, Markdown sensitive placeholder scan, and `git diff --check -- tabbit-protocol-pool`.

**Goal:** Add an offline-testable `tabbit-pool accounts probe <id>` command that verifies one stored account through an injectable verifier/provisioner and prints redacted action logs plus probe advice.

**Architecture:** Reuse the existing `AccountProvisioner.verifyAccount(accountId)` contract instead of inventing a new account verification path. The CLI creates a default `AccountProvisioner` from `JsonAccountStore`, `FileSecretStore`, and an empty protocol client so default probes are safe and either mark missing local sessions or skip unconfigured network verification. Tests inject a fake provisioner to prove command wiring without real Tabbit access.

**Tech Stack:** Node.js ESM, native `node:test`, existing `AccountProvisioner`, `FileSecretStore`, `formatMaintenanceActionLog`, `protocolProbeAdvice`, and redaction helpers.

---

### Task 1: Probe command dispatcher

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`

**Step 1: Write the failing tests**

Add tests for:

- `runProtocolPoolCli(["accounts", "probe", "acct_a", "--json"], deps)` calls an injected `accountVerifier.verifyAccount("acct_a")`, prints redacted events, account summary, and advice.
- Missing account id returns exit code 2 and prints help/error to stderr.
- Default dependencies expose an `accountVerifier` whose `verifyAccount` method is safe to call without configuring a real protocol verifier.

**Step 2: Run RED**

Run: `node --test test/ops-cli.test.js`.

Expected: FAIL because `accounts probe` is not routed and default dependencies do not expose `accountVerifier`.

**Step 3: Implement minimal code**

- Add `AccountProvisioner` and `FileSecretStore` default wiring in `createProtocolPoolCliDependencies()`.
- Add `tabbit-pool accounts probe <id> [--json]` to help text and dispatcher.
- In the handler, call `deps.accountVerifier.verifyAccount(accountId)`.
- Convert returned actions with `formatMaintenanceActionLog({ action, accountId })` even though the action name is `verifySession`.
- Return JSON shape: `{ changed, account, events, advice }`, with `account` redacted via `redactAccountForDisplay()` and `advice` from the first failed action error or resulting account lastError.
- Non-JSON output should be a simple tab-separated event list.

**Step 4: Run GREEN**

Run: `node --test test/ops-cli.test.js`.

Expected: PASS.

---

### Task 2: Documentation and focused verification

**Files:**
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `README.md`

**Step 1: Update docs**

Document `tabbit-pool accounts probe <id> [--json]` as a foundation command. It verifies local session state through `AccountProvisioner.verifyAccount()`; with default empty protocol verifier it will not perform real Tabbit network verification.

**Step 2: Verify**

Run:

- `node --test test/ops-cli.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

## Verification evidence on 2026-07-02

- `node --test test/ops-cli.test.js`: 11 pass / 0 fail after RED failures confirmed.
- `node --test test/ops-cli.test.js test/smoke.test.js`: 13 pass / 0 fail.
- `npm test` in `tabbit-protocol-pool`: 121 pass / 0 fail.
- Root `npm test`: 191 pass / 0 fail.
- `node bin/tabbit-pool.js --help`: exit 0 and lists `accounts probe <id>`.
- Markdown local-link scan: 58 files, 0 broken local links.
- Markdown sensitive placeholder scan: 0 hits.
- `git diff --check -- tabbit-protocol-pool`: exit 0.
