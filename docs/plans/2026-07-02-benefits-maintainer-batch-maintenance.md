# BenefitsMaintainer Batch Maintenance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add offline-testable `BenefitsMaintainer.maintainAllAccounts()` so M05 can maintain an account list or a bound local account store without guessing real Tabbit entitlement endpoints.

**Architecture:** Keep the existing single-account `maintainAccount()` as the only per-account action pipeline. The batch method is an orchestration wrapper: it loads accounts from an optional `accountStore`, runs `maintainAccount()` in account order, aggregates per-account results, and saves only when at least one account changed. Real quota/check-in/Pro/reset endpoints remain injected protocol operations.

**Tech Stack:** Node.js ESM, native `node:test`, existing `BenefitsMaintainer`, `JsonAccountStore`-compatible interface, and CLI dependency factory.

---

### Task 1: RED tests for batch maintenance

**Files:**
- Modify: `test/benefits-maintainer.test.js`

Add tests that:

- `maintainAllAccounts()` loads accounts from a bound accountStore.
- It calls `maintainAccount()` behavior for each account in stable order.
- It returns `{ accounts, changed, results }` with per-account `actions`.
- It calls `saveAccounts()` exactly once when any account changed.
- It does not call `saveAccounts()` when every account is unchanged.

RED evidence:

```powershell
node --test test/benefits-maintainer.test.js
# fail: 2
# TypeError: maintainer.maintainAllAccounts is not a function
```

---

### Task 2: Minimal implementation

**Files:**
- Modify: `src/benefits-maintainer.js`

Implement:

- Optional constructor `accountStore`.
- `maintainAllAccounts(accounts?)` with explicit array mode and accountStore mode.
- Store persistence only when `changed === true`.
- `MISSING_ACCOUNT_SOURCE`, `INVALID_ACCOUNT_LIST`, and `MISSING_ACCOUNT_STORE_SAVE` errors for invalid local usage.

GREEN evidence:

```powershell
node --test test/benefits-maintainer.test.js
# pass: 11, fail: 0
```

---

### Task 3: CLI dependency wiring and documentation

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M05-权益额度维护/_M05-权益额度维护.md`

Add coverage that default CLI dependencies expose a batch benefits maintainer bound to the local accountStore. Keep the existing `tabbit-pool maintain` output behavior unchanged.

RED evidence:

```powershell
node --test test/ops-cli.test.js
# fail: default CLI dependencies expose a batch benefits maintainer
# BenefitsMaintainerError: accounts array or accountStore is required
```

GREEN evidence:

```powershell
node --test test/benefits-maintainer.test.js test/ops-cli.test.js
# pass: 42, fail: 0
```

---

### Boundaries

- This does not add any real Tabbit quota/check-in/Pro/reset endpoint path.
- Protocol operations remain injected and optional; missing methods still produce skipped actions.
- Batch mode persists only sanitized account metadata through the existing accountStore.
- The CLI `maintain` command still preserves its existing event output contract.

---

### Final verification evidence

```powershell
node --test test/benefits-maintainer.test.js test/ops-cli.test.js
# pass: 42, fail: 0

npm test
# tabbit-protocol-pool pass: 182, fail: 0

cd E:\tabbit2api
npm test
# root pass: 252, fail: 0
```

Post-doc checks:

- Markdown local-link scan: OK, 77 Markdown files checked, 0 broken links.
- Secret scan: OK, 115 text files checked, 0 live-format hits after placeholder allowlist.
- Trailing whitespace scan: OK, 115 text files checked, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: OK.
