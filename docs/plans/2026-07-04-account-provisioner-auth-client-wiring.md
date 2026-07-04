# AccountProvisioner Auth Client Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure configured real auth send-code and submit-code protocol operations are available to `AccountProvisioner` through the default CLI dependency wiring, without guessing endpoint paths or running side-effect probes.

**Architecture:** Keep endpoint discovery and success evidence gated by existing `probe template` / `probe validate` / `probe protocol` flows. Reuse `ProtocolTabbitClient.sendVerificationCode()` and `submitRegistrationOrLogin()` only when explicit `TABBIT_POOL_PROTOCOL_AUTH_*` paths are configured, and keep the AccountProvisioner orchestration free of hardcoded Tabbit URLs, raw payloads, or secrets.

**Tech Stack:** Node.js ESM, native `node:test`, existing `createProtocolPoolCliDependencies()`, `AccountProvisioner`, `ProtocolTabbitClient`, and protocol fixture audit docs.

---

### Task 1: RED Test the Default Account Protocol Adapter

**Files:**
- Modify: `test/ops-cli.test.js`

- [ ] **Step 1: Add the failing test**

Add `createProtocolPoolCliDependencies wires configured auth operations for AccountProvisioner`.

Use `createProtocolPoolCliDependencies()` with:

```js
config: {
  stateDir: "E:/tmp/tabbit-auth-wiring-test",
  protocol: {
    enabled: true,
    baseUrl: "https://web.tabbit.ai",
    authSendCodePath: "/api/auth/send-code",
    authSendCodeMethod: "POST",
    authSubmitCodePath: "/api/auth/submit-code",
    authSubmitCodeMethod: "POST",
  },
  compat: { stripClientTools: true, toolLoopMode: "client_executes_tools_first" },
},
fetch: async (url, init) => { ... },
```

The fake fetch must return a sign-key response, then auth send/submit responses. Instantiate an `AccountProvisioner` with `deps.accountProtocolClient`, a memory account store, a memory secret store, and fake mail provider. Call `createAccount()`.

Assertions:

- The account becomes `active`.
- The stored secret is written only through the secret store.
- Fetch calls include `/api/auth/send-code` and `/api/auth/submit-code`.
- Serialized CLI/test output does not include the test cookie, verification code, or full email.

- [ ] **Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth operations for AccountProvisioner"
```

Expected: FAIL because the default account protocol adapter currently only exposes `verifySession`.

### Task 2: Implement Minimal Adapter Wiring

**Files:**
- Modify: `src/ops-cli.js`

- [ ] **Step 1: Extend `createConfiguredAccountProtocolClient()`**

Add `sendVerificationCode(input)` when `protocol.authSendCodePath` is configured, and `submitRegistrationOrLogin(input)` when `protocol.authSubmitCodePath` is configured. Each method should instantiate the configured `ProtocolTabbitClient` and delegate the input unchanged.

- [ ] **Step 2: Expose the adapter for tests and future callers**

Return `accountProtocolClient` from `createProtocolPoolCliDependencies()` so tests and future account creation CLI work can reuse the same default wiring.

- [ ] **Step 3: Run GREEN**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth operations for AccountProvisioner"
```

Expected: PASS.

### Task 3: Update Operator Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M04-账号注册初始化/_M04-账号注册初始化.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`

- [ ] **Step 1: Document the new wiring boundary**

State that the default AccountProvisioner protocol adapter now exposes configured auth send/submit methods, but it still does not guess endpoint paths or run side-effect probes automatically.

- [ ] **Step 2: Preserve evidence gate wording**

State that production use still requires sanitized delivery success and importable session-material fixtures before claiming auth calibration ready.

### Task 4: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

- [ ] **Step 1: Focused tests**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth operations for AccountProvisioner"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

- [ ] **Step 2: Full regression**

```powershell
npm test
git diff --check
```

- [ ] **Step 3: Secret boundary checks**

Run a forbidden path scan and a credential-shape scan over changed non-fixture repository files. Expected: no `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, or `.omx/` edits; no real cookie/session/JWT/API key/Bearer/raw payload/prompt/user data in changes.
