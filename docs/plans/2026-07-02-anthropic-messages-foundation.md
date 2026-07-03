# Anthropic Messages Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a non-streaming Anthropic Messages compatibility layer and expose it through `POST /v1/messages` in the protocol-pool HTTP server.

**Architecture:** Mirror the existing `OpenAICompat` split: implement a pure `AnthropicCompat` handler that normalizes Anthropic request bodies and maps runner results to Anthropic JSON/error envelopes, then let `src/http-server.js` route `/v1/messages` to `compat.handleMessages` without duplicating compatibility semantics.

**Tech Stack:** Node.js ESM, native `node:test`, existing `PooledRequestRunner`, existing `node:http` route adapter.

---

### Task 1: Pure Anthropic handler

**Files:**
- Create: `test/anthropic-compat.test.js`
- Create: `src/anthropic-compat.js`

**Step 1: Write the failing test**

Test that `AnthropicCompat.handleMessages(body)`:

- Accepts `model`, `messages`, `system`, `stream`, `max_tokens`, and `requires_premium`.
- Converts system + user messages into runner messages.
- Calls `runner.run()` with model, normalized messages, stream, attachments, and requiresPremium.
- Returns Anthropic non-streaming message JSON with `type: "message"`, `role: "assistant"`, `content: [{ type:"text", text }]`, `stop_reason: "end_turn"`, and `usage`.

**Step 2: Run test to verify it fails**

Run: `node --test test/anthropic-compat.test.js`
Expected: FAIL because `src/anthropic-compat.js` does not exist.

**Step 3: Write minimal implementation**

Implement exports:

- `normalizeAnthropicMessagesRequest(body)`
- `buildAnthropicMessageResponse(normalized, result, meta)`
- `anthropicErrorForCategory(error)`
- `AnthropicCompat`

**Step 4: Run test to verify it passes**

Run: `node --test test/anthropic-compat.test.js`
Expected: PASS.

### Task 2: Anthropic errors and empty input

**Files:**
- Modify: `test/anthropic-compat.test.js`
- Modify: `src/anthropic-compat.js`

**Step 1: Write failing tests**

Add tests that:

- Empty `messages` and no attachments returns 400 Anthropic error envelope.
- `no_available_account` maps to 503 `type: "error"`, `error.type: "api_error"`.
- `login_required` maps to 401 `authentication_error`.

**Step 2: Run test to verify it fails**

Run: `node --test test/anthropic-compat.test.js`
Expected: FAIL until error mapping exists.

**Step 3: Implement minimal mapping**

Anthropic error shape:

`{ type: "error", error: { type, message }, metadata: { code } }`

**Step 4: Run test to verify it passes**

Run: `node --test test/anthropic-compat.test.js`
Expected: PASS.

### Task 3: HTTP route wiring

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Write failing tests**

Add tests that:

- `POST /v1/messages` with `x-api-key` parses JSON and calls `compat.handleMessages`.
- Malformed JSON on `/v1/messages` returns 400 `invalid_json` using existing HTTP envelope.
- Missing auth returns 401 before handler call.

**Step 2: Run test to verify it fails**

Run: `node --test test/http-server.test.js`
Expected: FAIL because `/v1/messages` currently returns 404.

**Step 3: Implement route**

In `createProtocolPoolServer`, route `POST /v1/messages` to `handleCompatJsonRoute(req, res, compat, "handleMessages")`.

**Step 4: Run test to verify it passes**

Run: `node --test test/http-server.test.js`
Expected: PASS.

### Task 4: Gateway wiring and exports

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `test/smoke.test.js`
- Modify: `src/protocol-pool-gateway.js`
- Modify: `src/index.js`

**Step 1: Write failing tests**

Add a gateway test that requests `POST /v1/messages` and receives Anthropic response JSON from the same runner chain. Update smoke test to import `AnthropicCompat` and helper exports.

**Step 2: Run test to verify it fails**

Run: `node --test test/protocol-pool-gateway.test.js test/smoke.test.js`
Expected: FAIL until gateway creates combined compat and index exports exist.

**Step 3: Implement gateway wiring**

Create `AnthropicCompat` in `createProtocolPoolGateway()` and pass a combined compat object with `handleChatCompletions`, `handleResponses`, and `handleMessages`.

**Step 4: Run test to verify it passes**

Run: `node --test test/protocol-pool-gateway.test.js test/smoke.test.js`
Expected: PASS.

### Task 5: Docs and full verification

**Files:**
- Create: `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`
- Modify: `README.md`
- Modify: `docs/03-索引.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/启动工厂.md`

**Step 1: Document behavior**

Document non-streaming Anthropic support, request normalization, response shape, error mapping, and streaming boundary.

**Step 2: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`
- `npm test` in repository root
- Markdown local-link scan
- Markdown sensitive placeholder scan

Expected: all tests pass, 0 broken links, 0 Markdown secret hits.
