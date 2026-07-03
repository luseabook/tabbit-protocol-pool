# Account JSON Store Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a small JSON-backed account metadata store so AccountPool state can survive process restarts without storing raw cookies or tokens.

**Architecture:** Keep AccountPool as an in-memory scheduler and add a separate JsonAccountStore that loads/saves normalized account metadata. The store writes a versioned JSON document under the configured state directory and strips direct secret fields such as cookie, token, password, and Authorization before persistence. This is a foundation that can later be replaced by SQLite or an encrypted store.

**Tech Stack:** Node.js ESM, node:fs/promises, node:path, node:test.

---

### Task 1: Account store load/save behavior

**Files:**
- Create: src/account-store.js
- Test: test/account-store.test.js
- Modify: src/index.js

**Step 1: Write the failing test**

Add tests for:

- missing accounts file returns [];
- saveAccounts() writes a versioned document and loadAccounts() returns normalized accounts;
- direct secret fields are stripped while cookieJarRef is preserved.

**Step 2: Run test to verify it fails**

Run: node --test test/account-store.test.js
Expected: FAIL because src/account-store.js does not exist.

**Step 3: Write minimal implementation**

Implement AccountStoreError, resolveAccountStorePath(), sanitizeAccountForStorage(), normalizeAccountStoreDocument(), and JsonAccountStore with loadAccounts() and saveAccounts().

**Step 4: Run test to verify it passes**

Run: node --test test/account-store.test.js
Expected: PASS.

### Task 2: Update helper and malformed data behavior

**Files:**
- Modify: src/account-store.js
- Test: test/account-store.test.js

**Step 1: Write the failing test**

Add tests for:

- updateAccounts() loading current accounts, applying a mutator, saving the result;
- malformed JSON and non-array account payloads throw AccountStoreError with stable codes.

**Step 2: Run test to verify it fails**

Run: node --test test/account-store.test.js
Expected: FAIL for missing update/error behavior.

**Step 3: Write minimal implementation**

Implement updateAccounts() and stable error mapping.

**Step 4: Run test to verify it passes**

Run: node --test test/account-store.test.js
Expected: PASS.

### Task 3: Documentation and regression

**Files:**
- Modify: README.md
- Modify: docs/04-开发追踪.md
- Modify: docs/06-数据字典.md
- Modify: docs/09-实现接口参考.md
- Modify: docs/modules/M02-账号池调度/_M02-账号池调度.md
- Modify: docs/modules/M07-配置密钥/_M07-配置密钥.md

**Step 1: Update docs**

Mark JSON metadata persistence as implemented and clarify that raw cookies/tokens still belong in the future secrets store.

**Step 2: Run full regression**

Run:

~~~powershell
cd tabbit-protocol-pool
npm test
cd ..
npm test
~~~

Expected: all tests pass.

## Implementation result

Completed in this workspace:

- Added src/account-store.js with AccountStoreError, JsonAccountStore, StoredAccountPool, resolveAccountStorePath(), sanitizeAccountForStorage(), and normalizeAccountStoreDocument().
- Added test/account-store.test.js covering missing files, versioned writes, normalized reads, direct secret field stripping, updateAccounts(), malformed JSON, invalid shape, and StoredAccountPool state writeback.
- Updated PooledRequestRunner to await recordSuccess()/recordFailure() so async store-backed pools can finish persistence before run() resolves.
- Exported account store APIs from src/index.js and updated smoke coverage.

Verified targeted commands during implementation:

~~~powershell
cd tabbit-protocol-pool
node --test test/account-store.test.js test/pooled-request-runner.test.js test/smoke.test.js
~~~

Full regression still required before completion:

~~~powershell
cd tabbit-protocol-pool
npm test
cd ..
npm test
~~~
