# HTTP Async SSE Flush Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the local HTTP route adapter flush SSE frames from an async upstream delta iterable as each delta arrives, instead of buffering the entire successful response before writing the local SSE body.

**Architecture:** Keep protocol endpoint discovery unchanged. This slice only upgrades `src/http-server.js` so successful `stream:true` compat results can expose `stream.deltas` as either a string array or an async iterable. Arrays keep the existing finite fallback path with `Content-Length`; async iterables use chunked SSE without `Content-Length` and write frames progressively. The compat/protocol layers can be wired to produce async deltas in a later slice.

**Tech Stack:** Node.js ESM, native `node:http`, native `fetch`, native `node:test`, no external dependencies.

---

### Task 1: RED test for progressive Chat SSE flush

**Files:**
- Modify: `test/http-server.test.js`

**Step 1: Write the failing test**

Add a test for `POST /v1/chat/completions` with `stream:true` where `compat.handleChatCompletions()` returns:

```js
{
  status: 200,
  body: {
    id: "chat_async_stream",
    object: "chat.completion",
    created: 1782961200,
    model: "tabbit/priority",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  },
  stream: {
    deltas: async function* () {
      yield "Hel";
      await releaseSecond;
      yield "lo";
    }(),
  },
}
```

The test must use `fetch()` and `response.body.getReader()` to read the first chunk before releasing the second delta. Assert:

- status is 200;
- content-type starts with `text/event-stream`;
- `content-length` is absent;
- the first chunk contains `Hel`;
- the first chunk does not contain `lo`;
- after releasing the second delta, the rest contains `lo` and ends with `[DONE]`.

**Step 2: Run RED**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
```

Expected: FAIL because the current adapter ignores async `stream.deltas`, buffers finite fallback SSE, and writes one complete `Hello` delta.

---

### Task 2: Implement async SSE writer and Chat route wiring

**Files:**
- Modify: `src/http-server.js`

**Step 1: Add async iterable detection**

Add a helper that returns true when a value has `Symbol.asyncIterator`.

**Step 2: Add chunked SSE writer**

Add `writeSseStream(res, events)` that:

- writes status 200;
- sets `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, and `Connection: keep-alive`;
- intentionally does not set `Content-Length`;
- iterates `for await` over preformatted SSE frame strings and calls `res.write(frame)`;
- calls `res.end()` when iteration completes.

**Step 3: Add Chat streaming event generator**

Add an async generator for chat completions:

- yield assistant role chunk;
- for each async delta, yield one `choices[0].delta.content` chunk;
- yield finish chunk;
- yield `data: [DONE]`.

**Step 4: Wire route selection**

In `handleCompatJsonRoute()`, when `body.stream === true`, result status is 2xx, and `result.stream.deltas` is async iterable, call the new async writer. Otherwise keep the existing finite SSE conversion.

**Step 5: Run GREEN**

```powershell
node --test test/http-server.test.js
```

---

### Task 3: Extend progressive flush to Responses and Anthropic

**Files:**
- Modify: `test/http-server.test.js`
- Modify: `src/http-server.js`

**Step 1: Add tests**

Add focused tests for `responsesToSseEvents` route behavior and Anthropic `/v1/messages` route behavior using async `stream.deltas`. They should verify the first read gets the first delta before the second is released.

**Step 2: Implement generators**

Add streaming generators for:

- Responses: `response.created`, one `response.output_text.delta` per async delta, `response.completed`, `[DONE]`.
- Anthropic Messages: `message_start`, `content_block_start`, one `content_block_delta` per async delta, `content_block_stop`, `message_delta`, `message_stop`.

**Step 3: Run GREEN**

```powershell
node --test test/http-server.test.js
```

---

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`
- Modify: `docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md`
- Modify: `docs/modules/M06-兼容网关/Anthropic-Messages处理器.md`

**Step 1: Document behavior**

Document the distinction:

- array `stream.deltas`: finite adapter, still writes a buffered response with `Content-Length`;
- async iterable `stream.deltas`: chunked SSE flush, no `Content-Length`, frames are written as each delta arrives;
- `ProtocolTabbitClient` still does not yet produce async deltas from `response.body`, so this is the HTTP foundation for end-to-end streaming rather than final protocol streaming.

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

Implemented:

- Added RED test `POST /v1/chat/completions stream true flushes async deltas before completion`; verified the old path returned a buffered response with `Content-Length`.
- Added RED tests for `/v1/responses` and `/v1/messages` async `stream.deltas`; verified they also used buffered finite SSE before implementation.
- Added `writeSseStream(res, events)` for chunked SSE without `Content-Length`.
- Added async streaming generators for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
- Updated route selection so successful `stream:true` results with async iterable `stream.deltas` are flushed frame-by-frame; array `stream.deltas` and full-text fallback continue using the existing finite SSE helpers.
- Updated README, API docs, M06 docs, test-case docs, and implementation reference to distinguish array `stream.deltas` from async iterable `stream.deltas`.

Verified:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
# RED before Chat async implementation: fail: 1, content-length was present and async deltas were ignored.

node --test test/http-server.test.js
# GREEN after Chat async implementation: pass: 19, fail: 0

node --test test/http-server.test.js
# RED before Responses/Anthropic async implementation: fail: 2, both routes still emitted buffered finite SSE with content-length.

node --test test/http-server.test.js
# GREEN after Responses/Anthropic async implementation: pass: 21, fail: 0

npm test
# tabbit-protocol-pool: pass: 161, fail: 0

cd E:\tabbit2api
npm test
# root gateway: pass: 231, fail: 0
```

Documentation quality scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 70 Markdown files, 0 broken local links. The scanner strips fenced and inline code before checking links.
- Sensitive placeholder scan over Markdown: 70 Markdown files, 0 live-format secret hits. Public examples keep using `sk-tabbit-local`.
- Trailing whitespace scan over `tabbit-protocol-pool`: 108 text files, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: passed with no output. The subtree is still untracked in the root worktree, so the custom trailing-whitespace scan above is the effective check for current file contents.
