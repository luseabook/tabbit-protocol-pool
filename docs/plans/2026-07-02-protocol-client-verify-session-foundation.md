# Protocol Client Verify Session Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a configurable `ProtocolTabbitClient.verifySession()` implementation so real session verification endpoint calibration can move from injected mocks into the protocol client layer.

**Architecture:** Keep the endpoint opt-in with `sessionVerifyPath`; default runtime still does not guess a Tabbit verification URL. When configured, the client signs a verification request, sends the hydrated cookie/session, normalizes success metadata, and maps HTTP failures to account-safe categories. The secret-hydrating factory forwards `verifySession` so protocol probes can reuse stored cookie refs without exposing raw session material in fixtures.

**Tech Stack:** Node.js ESM, native `node:test`, existing HMAC header helpers, existing protocol error classification, existing secret hydration wrapper.

---

### Task 1: RED tests for protocol client verification

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Write failing tests**

Add tests for:

- `ProtocolTabbitClient.verifySession()` with `sessionVerifyPath` signs a GET request, sends `Cookie`, and normalizes `userId` / `accessTier`.
- HTTP 401 from the verify endpoint returns `ok:false`, `category:"login_required"`, `accountStatus:"login_expired"`, and `httpStatus:401` without throwing.
- Missing `sessionVerifyPath` returns `ok:false`, `category:"protocol_missing"`, and does not call fetch.
- `createSecretHydratingProtocolClientFactory()` forwards `verifySession` with a hydrated cookie/session.

**Step 2: Run RED**

Run: `node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js`.

Expected: FAIL because `ProtocolTabbitClient` and the hydration wrapper do not expose `verifySession` yet.

---

### Task 2: Minimal implementation

**Files:**
- Modify: `src/protocol-tabbit-client.js`
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Add constructor options**

Add `sessionVerifyPath = null` and `sessionVerifyMethod = "GET"`. Normalize the path only when configured.

**Step 2: Add `verifySession()`**

When `sessionVerifyPath` is missing, return a `protocol_missing` result without network. When configured, get the sign key, build signed headers, add `Cookie`, call fetch, parse the response, normalize `userId` and `accessTier`, and map errors with `classifyProtocolError()`.

**Step 3: Forward through hydration wrapper**

Add `verifySession(input)` to `createSecretHydratingProtocolClientFactory()`; it hydrates account secret and passes both `account` and `session` to the base client.

**Step 4: Run GREEN**

Run: `node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js`.

---

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/_M01-Tabbit协议客户端.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/03-索引.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`

**Step 1: Update docs**

Document `sessionVerifyPath`, opt-in behavior, signed request shape, success/failure output, and the fact that the real URL still needs fixture calibration.

**Step 2: Verify**

Run:

- `node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js`
- `npm test` in `tabbit-protocol-pool`
- root `npm test`
- Markdown local-link scan
- Markdown sensitive placeholder scan
- `git diff --check -- tabbit-protocol-pool`

---

### Verification evidence

Implemented:

- `ProtocolTabbitClient` constructor options `sessionVerifyPath` and `sessionVerifyMethod`.
- `ProtocolTabbitClient.verifySession({ account, session })` with safe no-endpoint behavior, missing-session short-circuit, signed configured request, success normalization, and HTTP failure mapping.
- `createSecretHydratingProtocolClientFactory()` forwarding `verifySession()` after hydrating `cookieJarRef` into both runtime `account.cookieHeader` and `session`.
- `AccountProvisioner.verifyAccount()` honoring verifier-provided `accountStatus` on failed checks.
- Documentation updates in README, M01, M08, global index, development tracker, API docs, test cases, and implementation reference.

Commands run:

```powershell
node --test test/account-provisioner.test.js test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js
# pass: 30, fail: 0

node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js test/account-provisioner.test.js test/protocol-probe.test.js test/ops-cli.test.js test/smoke.test.js
# pass: 63, fail: 0

npm test
# tabbit-protocol-pool pass: 147, fail: 0

cd E:\tabbit2api
npm test
# root pass: 217, fail: 0
```

Documentation and diff checks:

- Markdown local-link scan: OK, 64 Markdown files checked.
- Markdown sensitive placeholder scan: OK, 64 Markdown files checked.
- Trailing whitespace scan: OK, 102 text files checked.
- `git diff --check -- tabbit-protocol-pool`: OK.
