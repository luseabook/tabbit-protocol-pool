# Secret Store Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local file-backed secret reference layer so account metadata can keep `cookieJarRef` while the gateway hydrates runtime account cookies without writing raw cookies into `accounts.json`.

**Architecture:** Keep `JsonAccountStore` responsible only for non-secret metadata. Add `src/secret-store.js` for constrained relative secret refs under `stateDir`, then update `createProtocolPoolGateway()` to optionally hydrate accounts through the secret store before calling a protocol client factory.

**Tech Stack:** Node.js ESM, `node:fs/promises`, `node:path`, `node:test`.

---

### Task 1: FileSecretStore path and read/write behavior

**Files:**
- Create: `test/secret-store.test.js`
- Create: `src/secret-store.js`

**Step 1: Write the failing test**

Test `resolveSecretRefPath({ stateDir, ref })` and `FileSecretStore.writeSecret/readSecret`:

- `secrets/acct_a.cookie` resolves inside `stateDir`.
- Writes create parent directories.
- Reads return exact text.
- Missing secret returns `null` from `readSecret`.

**Step 2: Run test to verify it fails**

Run: `node --test test/secret-store.test.js`
Expected: FAIL because `src/secret-store.js` does not exist.

**Step 3: Write minimal implementation**

Implement:

- `SecretStoreError`
- `resolveSecretRefPath({ stateDir, ref })`
- `FileSecretStore.readSecret(ref)`
- `FileSecretStore.writeSecret(ref, value)`

**Step 4: Run test to verify it passes**

Run: `node --test test/secret-store.test.js`
Expected: PASS.

### Task 2: Path traversal guard

**Files:**
- Modify: `test/secret-store.test.js`
- Modify: `src/secret-store.js`

**Step 1: Write the failing test**

Add assertions that refs such as `../outside`, absolute paths, empty refs, and refs containing Windows drive syntax throw `SecretStoreError(INVALID_SECRET_REF)`.

**Step 2: Run test to verify it fails**

Run: `node --test test/secret-store.test.js`
Expected: FAIL until validation is implemented.

**Step 3: Write minimal implementation**

Reject absolute paths, `..` segments, empty refs, and drive-letter refs before resolving. Ensure final resolved path starts with the resolved `stateDir` plus path separator or equals stateDir only when appropriate.

**Step 4: Run test to verify it passes**

Run: `node --test test/secret-store.test.js`
Expected: PASS.

### Task 3: Gateway cookieJarRef hydration

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `src/protocol-pool-gateway.js`
- Modify: `src/index.js`

**Step 1: Write the failing test**

Add a gateway test that:

1. Stores account metadata with `cookieJarRef: "secrets/acct_a.cookie"`.
2. Writes secret file with a placeholder cookie string.
3. Uses default gateway hydration wrapper around an injected `protocolClientFactory`.
4. Asserts the factory receives an account with `cookieHeader`, while `accounts.json` still does not contain direct `cookie`/`cookieHeader`.

**Step 2: Run test to verify it fails**

Run: `node --test test/protocol-pool-gateway.test.js`
Expected: FAIL because gateway currently passes only metadata account.

**Step 3: Write minimal implementation**

- Add `secretStore = options.secretStore || new FileSecretStore({ stateDir: config.stateDir })`.
- Wrap protocol client factory with an async `hydrateAccountSecrets(account, secretStore)` helper.
- If `account.cookieJarRef` exists and secret exists, add `cookieHeader` to the runtime account passed to the protocol client factory / sendMessage.
- Do not mutate account pool stored account.

**Step 4: Run test to verify it passes**

Run: `node --test test/protocol-pool-gateway.test.js`
Expected: PASS.

### Task 4: Docs and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M07-配置密钥/_M07-配置密钥.md`
- Create: `docs/modules/M07-配置密钥/Secret引用存储.md`

**Step 1: Document behavior**

Describe FileSecretStore, path constraints, `cookieJarRef` hydration, and security boundary.

**Step 2: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`
- `npm test` in repository root
- Markdown local-link scan
- sensitive placeholder scan

Expected: all pass, 0 broken links, 0 secret hits.
