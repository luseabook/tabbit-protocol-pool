# Protocol Attachment Upload Skeleton Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe, explicit `ProtocolTabbitClient.uploadAttachment()` skeleton for calibrated upload endpoints, without claiming that message-level attachments are supported.

**Architecture:** Keep all real protocol calls opt-in. `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` and constructor `attachmentUploadPath` are the only ways to enable upload calls. The method reuses existing sign-key caching, canonical JSON signing, protocol error classification, and secret hydration. `sendMessage({ attachments })` continues to return `ATTACHMENTS_UNSUPPORTED` until the real Tabbit message body attachment reference format is captured in fixtures.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolTabbitClient`, HMAC signing helpers, `loadConfig()`, and protocol-pool gateway factory.

---

### Task 1: RED tests for upload path config and protocol client

**Files:**
- Modify: `test/config.test.js`
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write failing tests**

Add assertions that:

- `loadConfig()` reads `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH`.
- Configuring only `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` enables protocol wiring.
- `ProtocolTabbitClient.uploadAttachment()` signs a POST to the configured upload path, sends `{ attachment }`, includes `Cookie`, and normalizes `id/name/mimeType/size`.
- `sendMessage({ attachments })` still rejects attachments.

**Step 2: Run RED**

Run:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js
```

Expected: FAIL because config has no `attachmentUploadPath` and the client has no `uploadAttachment()` method.

---

### Task 2: RED test for gateway secret hydration

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Write failing test**

Add a gateway test where:

- `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` is configured.
- An account only has `cookieJarRef`.
- `gateway.protocolClientFactory(account).uploadAttachment()` should hydrate the cookie, sign the upload request, and call the configured path.

**Step 2: Run RED**

Run:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js test/protocol-pool-gateway.test.js
```

Expected: FAIL because the secret-hydrating factory does not expose `uploadAttachment()` yet.

---

### Task 3: Minimal implementation

**Files:**
- Modify: `src/config.js`
- Modify: `src/protocol-tabbit-client.js`
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Add config field**

Parse `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` as nullable `protocol.attachmentUploadPath`, and count it as an endpoint path that enables `protocol.enabled`.

**Step 2: Add client method**

Add constructor option `attachmentUploadPath = null`. Implement:

- missing path -> `{ ok:false, error: ProtocolTabbitError(... MISSING_ATTACHMENT_UPLOAD_PATH ...) }`;
- configured path -> get sign key, sign `POST` with body `{ attachment }`, attach `Content-Type` and optional `Cookie`, fetch, parse body, map non-2xx through `protocolResponseError()`;
- success -> normalize `body.data` or top-level body into `{ ok:true, attachment:{ id, name, mimeType, size }, raw }`;
- missing id -> `protocol_changed`.

**Step 3: Forward through gateway**

Include `attachmentUploadPath` in env-derived protocol options. Add `uploadAttachment()` to `createSecretHydratingProtocolClientFactory()` so local `cookieJarRef` secrets are hydrated before delegation.

**Step 4: Run GREEN**

Run:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js test/protocol-pool-gateway.test.js
```

---

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/03-索引.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/_M01-Tabbit协议客户端.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/启动工厂.md`
- Modify: `docs/modules/M07-配置密钥/_M07-配置密钥.md`

**Step 1: Update docs**

Document:

- `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH`;
- `ProtocolTabbitClient` constructor `attachmentUploadPath`;
- `uploadAttachment()` request, response normalization, error boundary, and secret hydration;
- the strict boundary that `sendMessage({ attachments })` still rejects attachments until message reference fixtures exist.

**Step 2: Verify**

Run:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js test/protocol-pool-gateway.test.js
npm test
cd E:\tabbit2api
npm test
```

Also run Markdown local-link scan, sensitive placeholder scan, trailing whitespace scan, and:

```powershell
git diff --check -- tabbit-protocol-pool
```

---

### Verification evidence

Implemented:

- `loadConfig().protocol.attachmentUploadPath` and endpoint-triggered `protocol.enabled`.
- `ProtocolTabbitClient` constructor option `attachmentUploadPath`.
- `ProtocolTabbitClient.uploadAttachment({ account, attachment })` with signed POST, optional Cookie, response normalization, HTTP error mapping, and missing-id protocol_changed handling.
- `createSecretHydratingProtocolClientFactory().uploadAttachment()` and gateway env option forwarding.
- Regression boundary: `sendMessage({ attachments })` still returns `unsupported_feature/ATTACHMENTS_UNSUPPORTED`.

RED evidence:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js
# fail: 3
# config.protocol missing attachmentUploadPath; protocol.enabled stayed false for attachment-only path; client.uploadAttachment was missing

node --test test/protocol-tabbit-client.test.js test/config.test.js test/protocol-pool-gateway.test.js
# fail: 4
# gateway secret-hydrating client did not expose uploadAttachment()
```

GREEN evidence:

```powershell
node --test test/protocol-tabbit-client.test.js test/config.test.js test/protocol-pool-gateway.test.js
# pass: 37, fail: 0
```

Full verification evidence:

```powershell
npm test
# tabbit-protocol-pool pass: 175, fail: 0

cd E:\tabbit2api
npm test
# root pass: 245, fail: 0
```

Documentation and diff checks:

- Markdown local-link scan: OK, 76 Markdown files checked, 0 broken links.
- Secret scan: OK, 114 text files checked, 0 live-format hits after placeholder allowlist.
- Trailing whitespace scan: OK, 114 text files checked, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: OK.

---

### Follow-up: protocol probe uploadAttachment CLI coverage

Implemented after the protocol skeleton:

- `ProtocolProbeRunner.dispatch()` now supports `operation:"uploadAttachment"` with hydrated runtime account and a safe default attachment probe input.
- `probe template --operation uploadAttachment` prints a starter JSON object with `probe.txt`, `text/plain`, and placeholder `base64-probe-payload`.
- `probe protocol --operation uploadAttachment` validates `attachment` shape before calling the runner; invalid attachment payloads return exitCode 2 and do not echo raw JSON.
- Protocol probe fixtures redact `attachment.data` while preserving filename, mimeType, normalized attachment id, and status for debugging.
- Default CLI protocol wiring forwards `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` into `ProtocolTabbitClient`, so explicitly configured probes can exercise the upload endpoint skeleton.

Verification evidence:

```powershell
node --test test/protocol-probe.test.js test/ops-cli.test.js
# pass: 37, fail: 0

npm test
# tabbit-protocol-pool pass: 179, fail: 0

cd E:\tabbit2api
npm test
# root pass: 249, fail: 0
```

Post-doc checks:

- Markdown local-link scan: OK, 76 Markdown files checked, 0 broken links.
- Secret scan: OK, 114 text files checked, 0 live-format hits after placeholder allowlist.
- Trailing whitespace scan: OK, 114 text files checked, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: OK.
