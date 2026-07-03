# Protocol Pool Gateway Factory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an async gateway factory that wires config, account JSON store, stored account pool, pooled request runner, OpenAICompat, ProtocolTabbitClient, and the existing HTTP server into one startable unit.

**Architecture:** Keep HTTP route semantics in `src/http-server.js` and compatibility semantics in `src/openai-compat.js`. Add a small composition layer in `src/protocol-pool-gateway.js` that loads state and injects dependencies, so tests can verify wiring without real Tabbit network access.

**Tech Stack:** Node.js ESM, native `node:http`, `node:test`, existing protocol-pool modules.

---

### Task 1: Gateway factory integration test

**Files:**
- Create: `test/protocol-pool-gateway.test.js`
- Later create: `src/protocol-pool-gateway.js`
- Later modify: `src/index.js`

**Step 1: Write the failing test**

Add a test that:

1. Creates a temporary `stateDir`.
2. Writes `accounts.json` with one active account containing only metadata and `cookieJarRef`.
3. Calls `createProtocolPoolGateway({ env, now, idFactory, protocolClientFactory })`.
4. Starts `gateway.server` on `127.0.0.1:0`.
5. Sends `POST /v1/chat/completions` with `Authorization: Bearer sk-tabbit-local`.
6. Asserts OpenAI JSON response contains assistant text, selected account metadata, and that the store persisted `lastSuccessAt`.

**Step 2: Run test to verify it fails**

Run: `node --test test/protocol-pool-gateway.test.js`

Expected: FAIL with module export/file not found for `protocol-pool-gateway.js` or `createProtocolPoolGateway`.

**Step 3: Write minimal implementation**

Create `src/protocol-pool-gateway.js` exporting:

- `createProtocolPoolGateway(options)`
- `createDefaultProtocolClientFactory(options)`
- `listen(server, { host, port })`
- `closeServer(server)`

Factory should:

1. Resolve config with `options.config || loadConfig(options.env, options)`.
2. Create `JsonAccountStore({ stateDir: config.stateDir })` unless `options.store` is injected.
3. Load `StoredAccountPool.load({ store, now })` unless `options.accountPool` is injected.
4. Create `PooledRequestRunner({ accountPool, protocolClientFactory, retryLimit: config.retryLimit })`.
5. Create `OpenAICompat({ runner, now: compatNow, idFactory })`.
6. Create `createProtocolPoolServer({ apiKey: config.apiKey, compat, modelsProvider, health })`.
7. Return the composed pieces plus `start()` and `close()` helpers.

**Step 4: Run test to verify it passes**

Run: `node --test test/protocol-pool-gateway.test.js`

Expected: PASS.

### Task 2: Default model provider wiring

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Write the failing test**

Add a test that injects a `modelsProvider` and confirms `GET /v1/models` returns its models through the HTTP route. Also assert `gateway.config.host` defaults to `127.0.0.1`.

**Step 2: Run test to verify it fails**

Run: `node --test test/protocol-pool-gateway.test.js`

Expected: FAIL until the factory passes `modelsProvider` and exposes config.

**Step 3: Write minimal implementation**

Ensure `createProtocolPoolGateway` passes `options.modelsProvider` to `createProtocolPoolServer`, and return `config`.

**Step 4: Run test to verify it passes**

Run: `node --test test/protocol-pool-gateway.test.js`

Expected: PASS.

### Task 3: Export and docs

**Files:**
- Modify: `src/index.js`
- Modify: `README.md`
- Modify: `docs/03-索引.md` if adding a module doc
- Modify: `docs/07-API文档.md`
- Modify: `docs/09-实现接口参考.md`
- Create: `docs/modules/M06-兼容网关/启动工厂.md`

**Step 1: Write/extend smoke test**

Update `test/smoke.test.js` or gateway test to import `createProtocolPoolGateway` from `src/index.js`.

**Step 2: Run test to verify it fails**

Run: `node --test test/protocol-pool-gateway.test.js test/smoke.test.js`

Expected: FAIL until export exists.

**Step 3: Export and document**

Export gateway helpers from `src/index.js`. Document the composition boundary and usage with no real secrets.

**Step 4: Run full verification**

Run:

`npm test`

Then from repository root:

`npm test`

Expected: all tests pass.
