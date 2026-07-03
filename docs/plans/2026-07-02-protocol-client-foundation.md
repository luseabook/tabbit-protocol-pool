# Protocol Client Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first offline-testable M01 ProtocolTabbitClient foundation: sign-key retrieval/cache, deterministic signing helpers, model catalog normalization, message request skeleton, and protocol error classification.

**Architecture:** Keep real Tabbit protocol assumptions explicit and injectable. The client owns HTTP request construction, sign-key caching, normalized model metadata, and error classification, while unknown upstream paths remain configurable. Tests use injected fetch and fixed clocks/nonces so no live Tabbit network or browser UI is required.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `assert/strict`, built-in `node:crypto`, fetch-compatible dependency injection.

---

### Task 1: Signing and sign-key cache

**Files:**
- Create: `tabbit-protocol-pool/src/protocol-tabbit-client.js`
- Modify: `tabbit-protocol-pool/src/index.js`
- Create: `tabbit-protocol-pool/test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Test that `buildSignaturePayload()` canonicalizes method/path/query/body, `createSignedHeaders()` emits timestamp/nonce/signature with fixed inputs, and `ProtocolTabbitClient.getSignKey()` fetches `/chat/sign-key` once then returns the cached key until TTL expiry.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: FAIL because `protocol-tabbit-client.js` does not exist.

**Step 3: Write minimal implementation**

Implement `ProtocolTabbitClient`, `ProtocolTabbitError`, `canonicalJson()`, `buildSignaturePayload()`, and `createSignedHeaders()` using HMAC-SHA256 as a deterministic default until the true Tabbit signer is replaced by fixture-backed logic.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: PASS.

### Task 2: Model catalog normalization

**Files:**
- Modify: `tabbit-protocol-pool/src/protocol-tabbit-client.js`
- Modify: `tabbit-protocol-pool/test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Test `listModels()` against fixture shapes containing `models`, `data`, and raw arrays. Assert each result has `id`, `selectedModel`, `displayName`, `supports_tools`, `supports_images`, `model_access_type`, and `available_in_tabbit_catalog`, plus an injected `tabbit/priority` alias if upstream does not provide it.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: FAIL because `listModels()` is missing.

**Step 3: Write minimal implementation**

Implement `normalizeModelCatalog()` and `ProtocolTabbitClient.listModels()` with cache TTL and safe defaults for missing capability fields.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: PASS.

### Task 3: Message request skeleton and error classification

**Files:**
- Modify: `tabbit-protocol-pool/src/protocol-tabbit-client.js`
- Modify: `tabbit-protocol-pool/test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Test `sendMessage()` builds a signed POST to a configurable `sendPath`, normalizes common text response shapes into content blocks, rejects attachments with `unsupported_feature`, and maps 401/403/429/5xx/network/parse failures to `ProtocolTabbitError.category`.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: FAIL because `sendMessage()` or error classification is missing.

**Step 3: Write minimal implementation**

Implement request signing in `sendMessage()`, `normalizeMessageResponse()`, and `classifyProtocolError()` without pretending the true Tabbit send endpoint is known. Require `sendPath` configuration for real calls.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/protocol-tabbit-client.test.js`
Expected: PASS.

### Task 4: Regression

**Files:**
- No additional production files expected.

**Step 1: Run new project tests**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

**Step 2: Run root project tests**

Run: `npm test`
Expected: PASS.
