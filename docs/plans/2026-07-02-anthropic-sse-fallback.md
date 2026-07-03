# Anthropic SSE Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTTP SSE fallback for Anthropic Messages when clients send `stream:true`, using the existing non-streaming AnthropicCompat handler as the source of truth.

**Status:** Implemented on 2026-07-02. `test/http-server.test.js` covers Anthropic fallback SSE and non-2xx `stream:true` errors staying JSON. `test/smoke.test.js` covers package entry export for the Anthropic SSE helper.

**Architecture:** Keep request normalization, runner calls, and Anthropic JSON/error mapping in `AnthropicCompat`. Add a small Anthropic SSE converter in `src/http-server.js` that detects successful `/v1/messages` `stream:true` responses and frames the handler's message JSON as Anthropic-style SSE events. Non-2xx handler results remain JSON because no stream has started.

**Tech Stack:** Node.js ESM, native `node:http`, native `node:test`.

---

### Task 1: Anthropic Messages SSE route

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Write the failing test**

Add a test for `POST /v1/messages` with `stream:true`:

- Send `x-api-key: sk-tabbit-local` and JSON body with `messages`.
- Make `compat.handleMessages` return a 200 Anthropic message JSON body.
- Assert status 200.
- Assert `content-type` starts with `text/event-stream`.
- Assert handler receives the original parsed body including `stream:true`.
- Assert body contains events in the expected fallback shape:
  - `event: message_start`
  - `event: content_block_start`
  - `event: content_block_delta` with `text_delta`
  - `event: content_block_stop`
  - `event: message_delta`
  - `event: message_stop`

**Step 2: Run test to verify it fails**

Run: `node --test test/http-server.test.js`
Expected: FAIL because `/v1/messages` currently returns JSON for `stream:true`.

**Step 3: Implement minimal SSE conversion**

Implement `anthropicMessageToSseEvents(body)` in `src/http-server.js`.

Conversion rules:

- `message_start`: data is `{ type:"message_start", message:{ ...body, content: [] } }`.
- For each `body.content[index]`:
  - emit `content_block_start` with an empty text block for text content.
  - for text blocks, emit one `content_block_delta` containing the full text as `{ type:"text_delta", text }`.
  - emit `content_block_stop`.
- `message_delta`: include `stop_reason`, `stop_sequence:null`, and `usage`.
- `message_stop`: data is `{ type:"message_stop" }`.

This is a fallback stream, not upstream token streaming. It emits complete text as one delta per content block.

**Step 4: Wire route selection**

Route `POST /v1/messages` through `handleCompatJsonRoute(..., { streamKind: "anthropic" })`. Reuse existing success-status gate so non-2xx results stay JSON.

**Step 5: Run test to verify it passes**

Run: `node --test test/http-server.test.js`
Expected: PASS.

### Task 2: Streaming errors stay JSON for Anthropic

**Files:**
- Modify: `test/http-server.test.js`

**Step 1: Write regression test**

Add an assertion for `POST /v1/messages` with `stream:true` where `compat.handleMessages` returns a non-2xx Anthropic error body:

- status remains the handler status.
- content type remains `application/json`.
- body equals the handler error body.

**Step 2: Run test**

Run: `node --test test/http-server.test.js`
Expected: PASS if Task 1 uses the shared success-status gate.

### Task 3: Package exports and docs

**Files:**
- Modify: `src/index.js`
- Modify: `test/smoke.test.js`
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`

**Step 1: Export helper**

Export `anthropicMessageToSseEvents` from `src/http-server.js` through `src/index.js` and assert it in `test/smoke.test.js`.

**Step 2: Document behavior**

Document this as fallback SSE:

- It uses the non-streaming Anthropic message response as source of truth.
- It emits complete text as a single `text_delta` per text block.
- It is not upstream token streaming.
- Non-2xx handler errors remain JSON.

**Step 3: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`.
- `npm test` in repository root.
- Markdown local-link scan.
- Markdown sensitive placeholder scan.
