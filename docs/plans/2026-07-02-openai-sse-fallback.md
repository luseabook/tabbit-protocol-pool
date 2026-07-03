# OpenAI SSE Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTTP SSE fallback for OpenAI Chat Completions and Responses when clients send `stream:true`, using the existing non-streaming compat handlers as the source of truth.

**Status:** Implemented on 2026-07-02. `test/http-server.test.js` covers Chat fallback SSE, Responses fallback SSE, and non-2xx `stream:true` errors staying JSON. `test/smoke.test.js` covers package entry exports for the SSE helpers.

**Architecture:** Keep request normalization and runner calls in `OpenAICompat`. Add small SSE helpers in `src/http-server.js` that detect `body.stream === true` for OpenAI routes, call the same compat handler, then transform successful JSON into compatible SSE frames. Errors remain JSON with their handler status because they occur before a successful stream starts.

**Tech Stack:** Node.js ESM, native `node:http`, native `node:test`.

---

### Task 1: Chat Completions SSE route

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Write the failing test**

Add a helper that reads raw text. Test `POST /v1/chat/completions` with `stream:true`:

- HTTP status 200.
- `content-type` starts with `text/event-stream`.
- handler receives parsed body unchanged.
- SSE body contains at least one `data: {...}` chat.completion.chunk with `choices[0].delta.content`.
- SSE body ends with `data: [DONE]`.

**Step 2: Run test to verify it fails**

Run: `node --test test/http-server.test.js`
Expected: FAIL because route currently returns JSON.

**Step 3: Implement minimal SSE writer**

Implement helpers in `src/http-server.js`:

- `writeSse(res, events)`
- `sseData(payload)`
- `chatCompletionToSseEvents(body)`

For chat, emit one chunk with full text as delta plus a final chunk with finish_reason, then `[DONE]`.

**Step 4: Run test to verify it passes**

Run: `node --test test/http-server.test.js`
Expected: PASS.

### Task 2: Responses SSE route

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Write the failing test**

Test `POST /v1/responses` with `stream:true`:

- HTTP status 200.
- `content-type` starts with `text/event-stream`.
- SSE body contains `event: response.created`.
- SSE body contains `event: response.output_text.delta` with text delta.
- SSE body contains `event: response.completed`.

**Step 2: Run test to verify it fails**

Run: `node --test test/http-server.test.js`
Expected: FAIL until responses SSE conversion exists.

**Step 3: Implement Responses SSE conversion**

Add `responsesToSseEvents(body)`. Use existing response body shape: id, model, created_at, output_text, output.

**Step 4: Run test to verify it passes**

Run: `node --test test/http-server.test.js`
Expected: PASS.

### Task 3: Streaming errors stay JSON

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Write tests**

For stream:true, make compat handler return a non-2xx error and assert response remains JSON with that status/body. This avoids starting an SSE stream for request validation or pooled failures.

**Step 2: Run test to verify it fails if behavior is wrong**

Run: `node --test test/http-server.test.js`
Expected: PASS if Task 1/2 implemented with status check; otherwise fail.

### Task 4: Exports, docs, full verification

**Files:**
- Modify: `src/index.js` if helpers are public.
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`

**Step 1: Document behavior**

Document this as a fallback SSE adapter: it emits one text delta from the non-streaming handler output, not true upstream token streaming.

**Step 2: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`
- `npm test` in repository root
- Markdown local-link scan
- Markdown sensitive placeholder scan

Expected: all tests pass, 0 broken links, 0 Markdown secret hits.
