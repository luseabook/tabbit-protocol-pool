# Account Provisioner Auth Endpoint Calibration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe, testable registration/login protocol boundary so real Tabbit send-code and submit-code evidence can be calibrated without changing `AccountProvisioner` orchestration again.

**Architecture:** Keep `AccountProvisioner` as an injected orchestration layer and add optional `ProtocolTabbitClient` operations for `sendVerificationCode()` and `submitRegistrationOrLogin()`. The endpoint paths and request bodies remain explicit configuration/input, missing configuration fails as `protocol_missing`, side-effect calls require caller intent, and all persisted session material continues to flow only through `secretStore`.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolTabbitClient`, `ProtocolProbeRunner`, `loadConfig()`, `createSecretHydratingProtocolClientFactory()`, and M04 documentation.

---

### Task 1: Document Scope and Safety Boundary

**Files:**
- Create: `docs/plans/2026-07-03-account-provisioner-auth-endpoint-calibration.md`

**Step 1: Record current blocker**

Document that `AccountProvisioner` already calls injected `sendVerificationCode()` and `submitRegistrationOrLogin()`, but the real Tabbit endpoint paths and body shapes are not yet safe to hard-code.

**Step 2: Define this phase**

This phase only adds configurable protocol operations and tests. It does not mark the remaining priority-1 item complete until a sanitized real success fixture proves:

- send verification-code endpoint path/method/body.
- submit verification-code endpoint path/method/body.
- response field containing cookie/session material or another safe import path.

**Step 3: Preserve secret boundaries**

No raw cookie, session, JWT, Bearer token, API key, verification code, prompt, raw payload, local browser profile, `output/`, `.agents/`, `.codex/`, `.omx/`, or private state fixture may be committed.

### Task 2: RED Tests for Auth Protocol Configuration

**Files:**
- Modify: `test/config.test.js`
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Add config test**

Add assertions that:

- defaults include `authSendCodePath:null`, `authSubmitCodePath:null`, `authSendCodeMethod:"POST"`, and `authSubmitCodeMethod:"POST"`;
- `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH`, `TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH`, `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_METHOD`, and `TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_METHOD` load into `config.protocol`;
- either auth path enables protocol wiring.

**Step 2: Add factory forwarding test**

Add a secret-hydrating factory test asserting `sendVerificationCode()` and `submitRegistrationOrLogin()` are forwarded to the configured client. The submit operation must receive hydrated account session if one exists, but no raw session is persisted to account metadata.

**Step 3: Run RED**

Run:

```powershell
node --test test\config.test.js test\protocol-pool-gateway.test.js --test-name-pattern "auth|verification"
```

Expected: FAIL because the new config fields and factory methods do not exist.

### Task 3: RED Tests for `ProtocolTabbitClient` Auth Operations

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Add missing-config tests**

Assert:

- `sendVerificationCode({ email })` returns `ok:false`, `category:"protocol_missing"`, `code:"MISSING_AUTH_SEND_CODE_PATH"` when the path is absent.
- `submitRegistrationOrLogin({ email, code })` returns `ok:false`, `category:"protocol_missing"`, `code:"MISSING_AUTH_SUBMIT_CODE_PATH"` when the path is absent.
- missing `email` or `code` fails before network with `invalid_request`.

**Step 2: Add request-shape tests**

With configured fixture paths, assert:

- `sendVerificationCode()` POSTs JSON to the configured path with `{ email }` by default and allows an explicit `body` object to be supplied for future captured shapes.
- `submitRegistrationOrLogin()` POSTs JSON to the configured path with `{ email, code }` by default and allows explicit body override.
- both use signed JSON headers and never require a cookie by default.

**Step 3: Add response normalization tests**

Assert submit success normalizes at least these safe variants:

- `{ cookieHeader, userId, accessTier }`
- `{ data: { cookie, user_id, access_tier } }`
- `{ data: { sessionToken } }`

Expected output must include session material for `AccountProvisioner.extractSessionSecret()` but tests must use placeholder values only.

**Step 4: Run RED**

Run:

```powershell
node --test test\protocol-tabbit-client.test.js --test-name-pattern "verification code|registration or login|auth"
```

Expected: FAIL until protocol methods exist.

### Task 4: Implement Minimal Auth Protocol Operations

**Files:**
- Modify: `src/config.js`
- Modify: `src/protocol-tabbit-client.js`
- Modify: `src/protocol-pool-gateway.js`
- Modify: `src/ops-cli.js`

**Step 1: Config**

Load four new env vars:

- `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH`
- `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_METHOD`
- `TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH`
- `TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_METHOD`

Include auth paths in protocol auto-enable detection.

**Step 2: Client constructor**

Store normalized `authSendCodePath`, `authSendCodeMethod`, `authSubmitCodePath`, and `authSubmitCodeMethod`.

**Step 3: Client methods**

Implement:

```js
async sendVerificationCode({ email, body = null, input = {} } = {})
async submitRegistrationOrLogin({ email, code, body = null, input = {} } = {})
```

Use configured methods, JSON body, sign-key signing, `x-req-ctx`, `unique-uuid`, and `Content-Type: application/json`. Return normalized success objects; return `{ ok:false, error }` for protocol errors.

**Step 4: Factory wiring**

Forward both methods in `createSecretHydratingProtocolClientFactory()` and include auth options in `configuredProtocolClientOptions()` in both gateway and ops CLI paths.

**Step 5: Run GREEN**

Run the focused RED commands again and require PASS.

### Task 5: Documentation and Evidence Trail

**Files:**
- Modify: `docs/modules/M04-账号注册初始化/_M04-账号注册初始化.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `README.md`

**Step 1: Update M04**

State that the code now has configurable protocol operations, while real endpoint/body success evidence is still required before the item can be marked complete.

**Step 2: Update API/reference docs**

Document the env vars and the expected safe placeholder workflow. Do not include real paths unless verified and sanitized.

**Step 3: Update tracking**

Move priority 1 from “编排层已有” to “可配置协议入口已有，真实 endpoint/body success evidence 待捕获”.

### Task 6: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused tests**

Run:

```powershell
node --test test\config.test.js
node --test test\protocol-pool-gateway.test.js
node --test test\protocol-tabbit-client.test.js
node --test test\account-provisioner.test.js
node --test test\ops-cli.test.js
```

**Step 2: Required project tests**

Run:

```powershell
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 3: External state read-only evidence**

If `E:\tabbit2api\output\tabbit-live-state` exists, run the readiness doctor/readiness/audit commands with env vars and confirm no raw fixture content is printed.

**Step 4: Sensitive-file boundary**

Confirm git status does not include `tabbit-cookie.txt`, `output/`, browser profiles, private state fixtures, `.agents/`, `.codex/`, or `.omx/`.
