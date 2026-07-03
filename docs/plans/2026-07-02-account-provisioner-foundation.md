# AccountProvisioner Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an offline-testable M04 AccountProvisioner foundation that orchestrates email inbox creation, verification-code login/registration, session persistence, account import, resume hooks, and session verification without guessing real Tabbit endpoint paths.

**Architecture:** Introduce `src/account-provisioner.js` as a pure orchestration layer. It depends on injected `mailProvider`, `protocolClient`, `accountStore`, `secretStore`, and optional `benefitsMaintainer`; real Tabbit send-code, submit-code, resume, and verify endpoints remain protocol operations supplied by the caller. The provisioner writes raw cookies/session material only through `secretStore`, persists only `cookieJarRef` and normalized account metadata, and returns auditable action results.

**Tech Stack:** Node.js ESM, native `node:test`, existing `normalizeAccount`, `JsonAccountStore`/store shape, and `FileSecretStore`/secret-store shape.

---

### Task 1: Create-account happy path and failure skeleton

**Files:**
- Create: `test/account-provisioner.test.js`
- Create: `src/account-provisioner.js`

**Step 1: Write failing tests**

Add tests for:

- `createAccount(input)` runs `createInbox`, `sendVerificationCode`, `waitForVerificationCode`, `submitRegistrationOrLogin`, `saveSession`, and optional `initializeBenefits` in order.
- A successful create writes the raw session to `secretStore.writeSecret()` before saving an `active` account.
- Stored account metadata contains `cookieJarRef` but not raw `cookieHeader`, `cookie`, `token`, or `session`.
- Verification-code timeout keeps the account in `provisioning`, records a failed action, and redacts sensitive values in the error summary.
- Missing session material after code submission marks the account `suspect` and does not write a secret.

**Step 2: Run RED**

Run: `node --test test/account-provisioner.test.js`

Expected: FAIL because `src/account-provisioner.js` does not exist.

**Step 3: Implement minimal code**

Implement:

- `AccountProvisionerError`
- `extractSessionSecret(result)`
- `AccountProvisioner.createAccount(input)`
- internal `upsertAccount(account)` and action/error helpers.

Do not add real endpoint URLs. Missing `protocolClient.sendVerificationCode` or `protocolClient.submitRegistrationOrLogin` returns a failed action with a protocol-operation detail.

**Step 4: Run GREEN**

Run: `node --test test/account-provisioner.test.js`

Expected: PASS.

---

### Task 2: Import, resume, and verify foundations

**Files:**
- Modify: `test/account-provisioner.test.js`
- Modify: `src/account-provisioner.js`

**Step 1: Write failing tests**

Add tests for:

- `importSession(input)` writes secret material first, then persists an `active` account with `cookieJarRef`.
- `importSession(input)` returns a failed result when session material is missing.
- Secret write failure during import does not persist an `active` account.
- `resumeProvisioning(accountId)` returns `skipped` when account is not provisioning or when the protocol resume hook is absent.
- `verifyAccount(accountId)` calls the injected verifier with the account and secret; success marks the account active, missing/invalid sessions mark it `login_expired`.
- Constructor validates required store dependencies.

**Step 2: Run RED**

Run: `node --test test/account-provisioner.test.js`

Expected: FAIL until the methods exist.

**Step 3: Implement minimal code**

Implement:

- `AccountProvisioner.importSession(input)`
- `AccountProvisioner.resumeProvisioning(accountId)`
- `AccountProvisioner.verifyAccount(accountId)`
- account lookup/update helpers.

**Step 4: Run GREEN**

Run: `node --test test/account-provisioner.test.js`

Expected: PASS.

---

### Task 3: Exports and documentation

**Files:**
- Modify: `test/smoke.test.js`
- Modify: `src/index.js`
- Modify: `docs/modules/M04-账号注册初始化/_M04-账号注册初始化.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`
- Modify: `docs/modules/M04-账号注册初始化/保存会话.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `README.md`

**Step 1: Write export test**

Update `test/smoke.test.js` to assert that `AccountProvisioner`, `AccountProvisionerError`, and `extractSessionSecret` are exported.

**Step 2: Run RED**

Run: `node --test test/smoke.test.js`

Expected: FAIL until exports are added.

**Step 3: Export**

Add exports from `src/index.js`.

**Step 4: Document**

Document that this is a foundation layer: real Tabbit verification-code and registration/login endpoint paths are still to be restored, and the provisioner depends on injected protocol operations.

**Step 5: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`.
- `npm test` in repository root.
- Markdown local-link scan.
- Markdown sensitive placeholder scan.
