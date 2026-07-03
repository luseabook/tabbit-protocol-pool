# HTTP Async SSE Error Frames Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert async `stream.deltas` iterator failures into client-visible SSE error frames after headers have already been sent.

**Architecture:** Once an async SSE response starts, the server cannot switch back to JSON or change HTTP status. `writeSseStream()` catches async iterator errors and writes route-specific SSE error frames before ending the response. Chat Completions keeps OpenAI-style `data: {"error":...}` plus `[DONE]`; Responses emits `response.failed` plus `[DONE]`; Anthropic emits `event: error`.

**Tech Stack:** Node.js ESM, native `node:test`, `node:http`, existing OpenAI/Responses/Anthropic SSE adapters.

---

### Task 1: RED Chat async stream error frame

**Files:**
- Modify: `test/http-server.test.js`

**Step 1: Write the failing test**

Add `POST /v1/chat/completions stream true emits SSE error when async deltas reject`:

- compat handler returns 2xx Chat Completion JSON;
- `stream.deltas` is an async generator that yields `"Hel"`, waits on a deferred promise, then throws an error with `code:"QUOTA_EXHAUSTED"`;
- request `stream:true`;
- assert the first content delta is readable before releasing the error;
- release the error;
- assert the rest of the stream contains:

```text
data: {"error":{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"}}

data: [DONE]
```

**Step 2: Run RED**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
```

Expected: FAIL because the current outer catch tries to write JSON after SSE headers have been sent.

### Task 2: GREEN generic SSE error catch

**Files:**
- Modify: `src/http-server.js`

**Step 1: Add stream error helpers**

Add:

- `streamErrorShape(error)`;
- `streamErrorEvents(error)`.

**Step 2: Catch in `writeSseStream()`**

Wrap the async iteration in try/catch. On error, write `streamErrorEvents(error)`, then `res.end()`.

**Step 3: Run GREEN**

```powershell
node --test test/http-server.test.js
```

Expected: Chat test passes.

### Task 3: RED route-specific error frames

**Files:**
- Modify: `test/http-server.test.js`

**Step 1: Add Responses test**

Add `POST /v1/responses stream true emits response.failed when async deltas reject`:

- first delta is `"Hel"`;
- after release, generator throws quota error;
- assert the stream contains `event: response.failed`, `type:"response.failed"`, `status:"failed"`, error code, and ends with `[DONE]`.

**Step 2: Add Anthropic test**

Add `POST /v1/messages stream true emits Anthropic error event when async deltas reject`:

- first delta is `"Hel"`;
- after release, generator throws quota error;
- assert the stream contains `event: error`, `type:"error"`, Anthropic-style `error:{ type:"api_error", message }`, and metadata code.

**Step 3: Run RED**

```powershell
node --test test/http-server.test.js
```

Expected: FAIL because the generic error frame does not emit `response.failed` or Anthropic `event:error`.

### Task 4: GREEN route-specific error mappers

**Files:**
- Modify: `src/http-server.js`

**Step 1: Add mappers**

Add:

- `responsesStreamErrorEvents(body, error)`;
- `anthropicStreamErrorEvents(error)`.

**Step 2: Allow `writeSseStream()` custom error events**

Change signature to:

```js
writeSseStream(res, events, { errorEvents = streamErrorEvents } = {})
```

**Step 3: Wire route adapters**

- Chat: default generic OpenAI `data:error` + `[DONE]`.
- Responses: pass `(error) => responsesStreamErrorEvents(result.body, error)`.
- Anthropic: pass `anthropicStreamErrorEvents`.

**Step 4: Run GREEN**

```powershell
node --test test/http-server.test.js
```

Expected: PASS.

### Task 5: Documentation and verification

**Files:**
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md`
- Modify: `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`

**Step 1: Document behavior**

Document that async iterator failures after SSE headers are sent are not converted to JSON. They are written as SSE error frames:

- Chat: `data: {"error":...}` then `[DONE]`;
- Responses: `event: response.failed` then `[DONE]`;
- Anthropic: `event: error`.

**Step 2: Run verification**

```powershell
node --test test/http-server.test.js
npm test
```

Then run root `npm test`, Markdown scans, trailing whitespace scan, and `git diff --check -- tabbit-protocol-pool`.

---

## Implementation and verification evidence

### RED 1

```powershell
node --test test/http-server.test.js
```

Observed result after adding the Chat test:

- command initially timed out because the response stayed open after the async iterator error;
- after adjusting the test to cancel the reader on timeout, the RED failure was explicit:
  `ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent to the client`.

### GREEN 1

After adding generic `writeSseStream()` error catch, Chat async stream error test passed.

### RED 2

After adding Responses and Anthropic route-specific tests:

- 22 pass / 2 fail.
- Responses test received generic `data: {"error":...}` instead of `event: response.failed`.
- Anthropic test received generic `data: {"error":...}` instead of `event: error`.

### GREEN 2

```powershell
node --test test/http-server.test.js
```

Observed result after route-specific error mappers:

- 24 pass / 0 fail.

### Documentation pass

Updated documentation:

- `README.md`: current-stage and `src/http-server.js` summary now mention HTTP async SSE error frames.
- `docs/modules/M06-兼容网关/_M06-兼容网关.md`: module overview now reflects response.body async producer, async chunked flush, and route-specific SSE error frames.
- `docs/modules/M06-兼容网关/HTTP路由层.md`: documents `writeSseStream(res, events, { errorEvents? })`, Chat/Responses/Anthropic error frame shapes, and the regression checklist item.
- `docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md`: documents that compat handlers pass async deltas through and HTTP owns Chat `data:error` / Responses `response.failed` iterator errors.
- `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`: documents Anthropic `event:error` behavior for post-header async iterator failures.

### Final verification

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
```

Observed:

- 24 pass / 0 fail.

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test
```

Observed:

- 171 pass / 0 fail.

```powershell
cd E:\tabbit2api
npm test
```

Observed:

- 241 pass / 0 fail.

Documentation and formatting scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 73 files / 0 broken.
- Secret scan over `tabbit-protocol-pool` text sources: 0 hits.
- Trailing whitespace scan over `tabbit-protocol-pool`: 0 hits.
- `git diff --check -- tabbit-protocol-pool`: exit 0, no output.
