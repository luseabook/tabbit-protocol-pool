# Protocol Async Stream Producer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let `ProtocolTabbitClient.sendMessage({ stream:true })` return an async `streamDeltas` producer directly from a streaming `fetch` response body, so the HTTP async SSE flush path can write upstream deltas without waiting for the whole response text.

**Architecture:** Keep endpoint discovery explicit. This slice does not add or guess any Tabbit URL. When `sendPath` is explicitly configured, `stream:true` is requested, the upstream response is 2xx, the content type is SSE/NDJSON, and `response.body` is readable, the protocol client returns immediately with `streamDeltas: AsyncIterable<string>`. Existing buffered parsing remains the fallback for non-stream calls, missing `response.body`, and finite fake responses.

**Tech Stack:** Node.js ESM, native `node:test`, Web `ReadableStream`, existing `ProtocolTabbitClient`, `OpenAICompat`, `AnthropicCompat`, `PooledRequestRunner`, and HTTP gateway tests.

---

### Task 1: RED protocol-client test for immediate async stream return

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Add a test `sendMessage returns async streamDeltas before the upstream stream completes`:

- fake fetch returns sign key first;
- second response has `Content-Type: text/event-stream` and a Web `ReadableStream`;
- the stream enqueues the first SSE frame `data: {"delta":"Hel"}\n\n`, then waits on a deferred promise before enqueuing `data: {"delta":"lo"}\n\n` and `[DONE]`;
- call `client.sendMessage({ stream:true })`;
- assert the call resolves before releasing the second frame;
- assert `result.ok === true`;
- assert `result.streamDeltas` is async iterable;
- consume one delta and assert it is `Hel`;
- assert the second delta is not produced before releasing the deferred promise;
- release it and assert the second delta is `lo`.

**Step 2: Run RED**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
```

Expected: FAIL because the current implementation calls `response.text()` and waits for the full upstream stream before returning.

---

### Task 2: Implement async stream parsing in ProtocolTabbitClient

**Files:**
- Modify: `src/protocol-tabbit-client.js`

**Step 1: Add stream detection helpers**

Add helpers:

- `isReadableBody(value)` for Web `ReadableStream` or async iterable body;
- `isStreamingContentType(contentType)` returning `sse` or `ndjson`;
- `decodeBodyTextChunks(body)` yielding decoded text chunks from Web streams or async iterable chunks.

**Step 2: Add async delta parsers**

Add async generators:

- SSE: buffer chunks until blank-line frame separators, parse `data:` lines, ignore `[DONE]`, and yield extracted text deltas.
- NDJSON: buffer chunks until newlines, parse each JSON/text line, ignore `[DONE]`, and yield extracted text deltas.

Use the same `parseDataLineValue()` and `extractStreamText()` rules as the buffered parser.

**Step 3: Return async success shape**

In `sendMessage()`, after a 2xx response:

- if `stream === true`, the content type is supported, and `response.body` is readable, return:

```js
{
  ok: true,
  contentBlocks: [{ type: "text", text: "" }],
  selectedModel: model,
  raw: { kind: "stream", format, async: true, events: [] },
  streamDeltas: asyncIterable,
}
```

The async iterable should append parsed raw events to `raw.events` as they are consumed.

**Step 4: Run GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js
```

---

### Task 3: Wire async deltas through compat and gateway

**Files:**
- Modify: `src/openai-compat.js`
- Modify: `src/anthropic-compat.js`
- Modify: `test/openai-compat.test.js`
- Modify: `test/anthropic-compat.test.js`
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Add compat tests**

Add tests showing that when runner returns async iterable `streamDeltas` and the request has `stream:true`, compat returns non-public `stream.deltas` as that same async iterable. Public JSON bodies must not include `stream` or `streamDeltas`.

**Step 2: Implement compat passthrough**

Update `streamMetadata()` in OpenAI and Anthropic compat modules:

- arrays remain filtered arrays;
- async iterable values pass through unchanged.

**Step 3: Add gateway E2E test**

Add a gateway test with explicit `TABBIT_POOL_PROTOCOL_SEND_PATH` and a fake streaming SSE `fetch` body. Request `/v1/chat/completions` with `stream:true`; read the HTTP response before releasing the second upstream frame and assert the first local SSE delta is already available and `Content-Length` is absent.

**Step 4: Run GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js test/protocol-pool-gateway.test.js test/http-server.test.js
```

---

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md`
- Modify: `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`

**Step 1: Document behavior**

Document that:

- `stream:true` + supported content type + readable `response.body` now produces async `streamDeltas`;
- HTTP SSE can flush those deltas progressively;
- buffered stream parsing remains the fallback for no readable body or non-stream call;
- this still does not calibrate any real Tabbit endpoint or signature fixture.

**Step 2: Run full verification**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test

cd E:\tabbit2api
npm test
```

Also run Markdown local link scan, Markdown sensitive placeholder scan, trailing whitespace scan over `tabbit-protocol-pool`, and:

```powershell
git diff --check -- tabbit-protocol-pool
```

---

## Implementation and verification evidence

### Completed in this slice

- Added `sendMessage returns async streamDeltas before the upstream stream completes` in `test/protocol-tabbit-client.test.js`.
- Implemented `ProtocolTabbitClient.sendMessage({ stream:true })` async stream path for 2xx SSE/NDJSON responses with readable `response.body`.
- Added async SSE/NDJSON body decoders that append parsed events to `raw.events` as the async iterable is consumed.
- Added OpenAI Chat/Responses and Anthropic Messages compat tests for async iterable `streamDeltas` passthrough as non-public `response.stream.deltas`.
- Updated OpenAI and Anthropic `streamMetadata()` to pass async iterable `streamDeltas` through unchanged while preserving the previous filtered-array behavior.
- Added gateway E2E coverage for explicit `TABBIT_POOL_PROTOCOL_SEND_PATH` plus streaming upstream SSE body. The test asserts the first OpenAI Chat SSE content delta is readable before the second upstream frame is released and that the response has no `Content-Length`.
- Updated README and module/API/test/reference docs to distinguish:
  - buffered stream parsing with array `streamDeltas`;
  - response.body async producer with async iterable `streamDeltas`;
  - HTTP chunked SSE flush;
  - still-uncalibrated real Tabbit endpoint/signature/error-frame boundaries.

### Verification run during implementation

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
node --test test/openai-compat.test.js test/anthropic-compat.test.js test/protocol-pool-gateway.test.js
node --test test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js test/protocol-pool-gateway.test.js test/http-server.test.js
```

Observed results:

- `test/protocol-tabbit-client.test.js`: 17 pass / 0 fail.
- Compat + gateway RED before implementation: 20 pass / 4 fail, expected missing `response.stream.deltas` and buffered SSE `Content-Length`.
- Compat + gateway GREEN after implementation: 24 pass / 0 fail.
- Targeted regression suite after implementation: 62 pass / 0 fail.

### Final verification after documentation pass

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test

cd E:\tabbit2api
npm test
```

Observed results:

- `tabbit-protocol-pool npm test`: 166 pass / 0 fail.
- root `npm test`: 236 pass / 0 fail.

Documentation and formatting scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 71 files, 0 broken local links.
- Markdown live-format secret scan: 71 files, 0 hits.
- Trailing whitespace scan over `tabbit-protocol-pool`: 109 files, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: clean.
