# Protocol Env Wiring Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire explicit protocol environment configuration into the local CLI dependencies so `accounts probe` and `probe protocol` can use `ProtocolTabbitClient` for real endpoint calibration without changing code.

**Architecture:** Keep the default offline-safe: no environment opt-in means no protocol client factory and no Tabbit network. Add a `config.protocol` section from `TABBIT_POOL_PROTOCOL_*` variables, then create a `ProtocolTabbitClient` factory only when `protocol.enabled` is true or an endpoint path is explicitly configured. Reuse the existing AccountProvisioner and ProtocolProbeRunner paths so fixtures remain sanitized and account metadata keeps the same state transitions.

**Tech Stack:** Node.js ESM, native `node:test`, existing `loadConfig`, `ProtocolTabbitClient`, `ProtocolProbeRunner`, and `AccountProvisioner`.

---

### Task 1: RED tests for protocol env config

**Files:**
- Modify: `test/config.test.js`

**Step 1: Write failing tests**

Add assertions that:

- `loadConfig()` returns `protocol.enabled === false` by default.
- `TABBIT_POOL_PROTOCOL_ENABLED=true`, `TABBIT_POOL_PROTOCOL_BASE_URL`, `TABBIT_POOL_PROTOCOL_SEND_PATH`, and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH` populate `config.protocol`.
- Configuring only `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH` also enables protocol wiring.
- Invalid `TABBIT_POOL_PROTOCOL_ENABLED` values throw.

**Step 2: Run RED**

Run:

```powershell
node --test test/config.test.js
```

Expected: FAIL because `config.protocol` does not exist yet.

---

### Task 2: RED tests for CLI dependency wiring

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing tests**

Add tests that:

- Without protocol env, a default `ProtocolProbeRunner` with an existing local secret still returns `skipped/protocol_missing` and never calls injected `fetch`.
- With `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH`, default `accountVerifier.verifyAccount()` calls a fake `ProtocolTabbitClient` flow: fetch sign-key, fetch verify path with `Cookie`, and update the account to `active`.
- With the same env, default `protocolProbeRunner.probeAccount({ operation:"verifySession" })` calls the configured verify endpoint and produces a `success` fixture without leaking the raw session.

**Step 2: Run RED**

Run:

```powershell
node --test test/config.test.js test/ops-cli.test.js
```

Expected: FAIL because CLI dependencies still pass an empty protocol client and null protocol probe client factory by default.

---

### Task 3: Implement config parsing

**Files:**
- Modify: `src/config.js`

**Step 1: Add boolean parsing**

Add a strict boolean parser accepting `true/false`, `1/0`, `yes/no`, and `on/off`, with clear errors for invalid values.

**Step 2: Add protocol section**

Return:

```js
protocol: {
  enabled,
  baseUrl,
  signKeyPath,
  modelCatalogPath,
  sendPath,
  sessionVerifyPath,
  sessionVerifyMethod,
}
```

Use `null` for absent optional strings. Set `enabled` true when `TABBIT_POOL_PROTOCOL_ENABLED` is true or any operation path is configured.

**Step 3: Run GREEN for config**

Run:

```powershell
node --test test/config.test.js
```

---

### Task 4: Implement CLI protocol wiring

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Import `ProtocolTabbitClient`**

Use it directly to avoid expanding gateway startup responsibilities.

**Step 2: Build configured protocol client factory**

Create a helper that:

- returns `null` when `config.protocol.enabled` is false;
- omits null options before constructing `ProtocolTabbitClient`;
- passes `options.fetch || globalThis.fetch`;
- passes CLI `now` into the protocol client for deterministic tests.

**Step 3: Wire defaults**

Use the configured factory when `options.protocolProbeClientFactory` is not explicitly provided. Use a small `protocolClient.verifySession()` wrapper for `AccountProvisioner` when `options.protocolClient` is not explicitly provided.

**Step 4: Run GREEN**

Run:

```powershell
node --test test/config.test.js test/ops-cli.test.js
```

---

### Task 5: Gateway protocol env wiring

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Write failing test**

Add a gateway test where `TABBIT_POOL_PROTOCOL_SEND_PATH` is set, an account has a stored `cookieJarRef`, and the default protocol client should sign and call the configured send path. The test should prove the gateway uses env-derived protocol options without custom `protocolClientFactory`.

**Step 2: Run RED**

Run:

```powershell
node --test test/protocol-pool-gateway.test.js
```

Expected: FAIL with a non-200 chat completion because the default protocol client still lacks `sendPath`.

**Step 3: Implement gateway wiring**

In `createProtocolPoolGateway()`, use `config.protocol` to populate default `protocolClientOptions` when no explicit `options.protocolClientOptions` is provided. Keep explicit options higher priority than env config.

**Step 4: Run GREEN**

Run:

```powershell
node --test test/protocol-pool-gateway.test.js
```

---

### Task 6: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M07-配置密钥/_M07-配置密钥.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/启动工厂.md`

**Step 1: Document env variables**

Document that real protocol wiring is opt-in through `TABBIT_POOL_PROTOCOL_ENABLED` or explicit endpoint paths, and that defaults remain offline-safe.

**Step 2: Verify**

Run:

```powershell
node --test test/config.test.js test/ops-cli.test.js test/protocol-tabbit-client.test.js test/protocol-probe.test.js test/account-provisioner.test.js
npm test
cd E:\tabbit2api
npm test
```

Also run Markdown local link scan, sensitive placeholder scan, trailing whitespace scan, and:

```powershell
git diff --check -- tabbit-protocol-pool
```

---

### Verification evidence

Implemented:

- `loadConfig().protocol` with strict `TABBIT_POOL_PROTOCOL_ENABLED` parsing and nullable protocol endpoint overrides.
- Env-derived `ProtocolTabbitClient` wiring in `createProtocolPoolCliDependencies()` for `accounts probe` and `probe protocol`.
- Env-derived `ProtocolTabbitClient` options in `createProtocolPoolGateway()` so `TABBIT_POOL_PROTOCOL_SEND_PATH` can drive the default gateway protocol client.
- Tests proving default no-env behavior remains offline-safe, while explicit env opt-in signs requests, sends hydrated `Cookie`, updates account verification state, and keeps protocol probe fixtures sanitized.
- Documentation updates in README, M07, M08, M06 startup factory, development tracker, API docs, test cases, and implementation reference.

RED evidence:

```powershell
node --test test/config.test.js test/ops-cli.test.js
# fail: 6
# config.protocol missing; account verifier/protocol probe not wired

node --test test/protocol-pool-gateway.test.js
# fail: 1
# gateway returned 400 because env sendPath was not wired into default ProtocolTabbitClient
```

GREEN and regression evidence:

```powershell
node --test test/config.test.js test/ops-cli.test.js
# pass: 32, fail: 0

node --test test/protocol-pool-gateway.test.js
# pass: 7, fail: 0

node --test test/config.test.js test/ops-cli.test.js test/protocol-pool-gateway.test.js test/protocol-tabbit-client.test.js test/protocol-probe.test.js test/account-provisioner.test.js
# pass: 69, fail: 0

npm test
# tabbit-protocol-pool pass: 152, fail: 0

cd E:\tabbit2api
npm test
# root pass: 222, fail: 0
```

Documentation and diff checks:

- Markdown local-link scan: OK, 65 Markdown files checked.
- Markdown sensitive placeholder scan: OK, 65 Markdown files checked.
- Trailing whitespace scan: OK, 103 text files checked.
- `git diff --check -- tabbit-protocol-pool`: OK.
