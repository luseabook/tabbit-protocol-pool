# Gateway Protocol Models Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the protocol-pool gateway serve `/v1/models` from `ProtocolTabbitClient.listModels()` when protocol env configuration is explicitly enabled.

**Architecture:** Keep the existing safe fallback: without protocol opt-in and without an injected `modelsProvider`, `/v1/models` still returns only `tabbit/priority`. When `config.protocol.enabled` is true, create a default models provider backed by the same env-derived `ProtocolTabbitClient` options used by send/session calls. Explicit `options.modelsProvider` continues to override the default.

**Tech Stack:** Node.js ESM, native `node:test`, existing `createProtocolPoolGateway`, `ProtocolTabbitClient.listModels()`, and native HTTP server model shaping.

---

### Task 1: RED test for env-backed `/v1/models`

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Write failing test**

Add a test that:

- starts `createProtocolPoolGateway()` with `TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH`;
- injects `fetch` returning a fake model catalog;
- calls authenticated `GET /v1/models`;
- expects both `tabbit/priority` and the upstream model to appear;
- verifies the request URL is `https://web.tabbit.ai/<path>?a=0`.

**Step 2: Run RED**

Run:

```powershell
node --test test/protocol-pool-gateway.test.js
```

Expected: FAIL because `/v1/models` currently ignores env-derived protocol clients unless `options.modelsProvider` is injected.

---

### Task 2: Implement default protocol models provider

**Files:**
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Add helper**

Add an internal `createProtocolModelsProvider(baseProtocolClientFactory, config)` helper that returns `null` unless `config.protocol.enabled` is true. When enabled, it returns an object with `listModels()` calling `baseProtocolClientFactory({}).listModels()`.

**Step 2: Wire server construction**

Use:

```js
const modelsProvider = Object.prototype.hasOwnProperty.call(options, "modelsProvider")
  ? options.modelsProvider
  : createProtocolModelsProvider(baseProtocolClientFactory, config);
```

Pass that value to `createProtocolPoolServer()`. Keep explicit `modelsProvider` higher priority.

**Step 3: Run GREEN**

Run:

```powershell
node --test test/protocol-pool-gateway.test.js
```

---

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/_M01-Tabbit协议客户端.md`
- Modify: `docs/modules/M06-兼容网关/启动工厂.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`

**Step 1: Document behavior**

Document that `/v1/models` uses the protocol model catalog only when protocol env is enabled or a custom provider is injected. Default remains `tabbit/priority`.

**Step 2: Verify**

Run:

```powershell
node --test test/protocol-pool-gateway.test.js test/protocol-tabbit-client.test.js test/config.test.js
npm test
cd E:\tabbit2api
npm test
```

Also run Markdown local link scan, sensitive placeholder scan, trailing whitespace scan, and:

```powershell
git diff --check -- tabbit-protocol-pool
```

---

## Implementation and verification evidence

Implemented:

- Added the failing gateway test `gateway default models provider uses explicit protocol env model catalog path`.
- Wired default env-backed `modelsProvider` in `src/protocol-pool-gateway.js` when `config.protocol.enabled` is true.
- Kept `options.modelsProvider` as the highest-priority override.
- Documented the behavior in README, M01, M06 startup factory, M06 HTTP route layer, M07 config, API docs, test cases, development tracker, and implementation reference.

Verified:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-pool-gateway.test.js test/protocol-tabbit-client.test.js test/config.test.js
# pass: 26, fail: 0

npm test
# pass: 153, fail: 0

cd E:\tabbit2api
npm test
# pass: 223, fail: 0

# Markdown local link scan
# OK markdown local links: 66 files

# Sensitive placeholder scan
# OK sensitive placeholder scan: 66 markdown files

# Trailing whitespace scan
# OK trailing whitespace scan: 104 files considered

git diff --check -- tabbit-protocol-pool
# OK, no whitespace errors
```
