# Gateway Upstream Token Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve parsed upstream stream deltas through the local OpenAI and Anthropic SSE adapters so `stream:true` clients receive one local SSE delta per upstream text delta when the configured Tabbit protocol response is SSE/NDJSON.

**Architecture:** Keep endpoint discovery explicit. This does not add or guess Tabbit URLs. `ProtocolTabbitClient.sendMessage()` already parses configured stream responses into `raw.events` and aggregate text; this slice adds a safe `streamDeltas` result field and teaches compat handlers plus HTTP SSE converters to prefer those deltas for successful streaming responses. Non-stream JSON responses and non-2xx errors keep their existing wire shape.

**Tech Stack:** Node.js ESM, native `node:test`, native `node:http`, existing `ProtocolTabbitClient`, `PooledRequestRunner`, OpenAI/Anthropic compat handlers, and fake `fetch` fixtures.

---

### Task 1: RED gateway test for OpenAI Chat upstream deltas

**Files:**
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Write the failing test**

Add an end-to-end gateway test that:

- creates one active stored account;
- enables `TABBIT_POOL_PROTOCOL_SEND_PATH=/chat/send`;
- uses fake `fetch` to return a sign key and then a `text/event-stream` response with two text deltas, for example `Hel` and `lo`;
- calls `POST /v1/chat/completions` with `stream:true`;
- asserts the local response is SSE;
- asserts the SSE body contains two separate `choices[0].delta.content` frames for `Hel` and `lo` and does not collapse them into one `Hello` content delta.

**Step 2: Run RED**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-pool-gateway.test.js
```

Expected: FAIL because the current fallback SSE adapter emits one full-text delta from the final JSON response.

---

### Task 2: Preserve stream deltas through protocol and compat layers

**Files:**
- Modify: `src/protocol-tabbit-client.js`
- Modify: `src/openai-compat.js`
- Modify: `src/anthropic-compat.js`

**Step 1: Add protocol result deltas**

Teach `normalizeMessageResponse()` to include `streamDeltas` when `body.kind === "stream"`, derived from parsed stream events with the same text extraction rules used for the aggregate text. Keep `contentBlocks` unchanged.

**Step 2: Add compat stream metadata**

When a normalized request has `stream:true`, have OpenAI and Anthropic compat handlers return an additional non-public top-level field such as:

```js
{
  status: 200,
  body: { ...public response body... },
  stream: { deltas: ["Hel", "lo"] }
}
```

Do not add `stream` or `streamDeltas` to public JSON bodies.

**Step 3: Run targeted GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js test/protocol-pool-gateway.test.js
```

---

### Task 3: Use upstream deltas in HTTP SSE converters

**Files:**
- Modify: `src/http-server.js`
- Modify: `test/http-server.test.js`

**Step 1: Add converter unit coverage**

Add tests for `chatCompletionToSseEvents()`, `responsesToSseEvents()`, and `anthropicMessageToSseEvents()` showing that optional stream deltas produce multiple local SSE delta events. Existing fallback tests must still pass when no stream deltas are supplied.

**Step 2: Wire route conversion**

Pass the compat result's `stream` metadata into the existing SSE conversion helpers in `handleCompatJsonRoute()`.

**Step 3: Run GREEN**

```powershell
node --test test/http-server.test.js test/protocol-pool-gateway.test.js
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

Document that successful `stream:true` routes now preserve parsed upstream text deltas when `ProtocolTabbitClient` receives supported SSE/NDJSON responses. Also document the fallback: if no upstream deltas are present, the adapters still emit one full-text delta from the final response body.

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

- Added RED gateway test `gateway stream preserves configured protocol SSE text deltas as separate OpenAI chat chunks`.
- Added `streamDeltas` to `ProtocolTabbitClient.normalizeMessageResponse()` for parsed SSE/NDJSON stream bodies while keeping public `contentBlocks` unchanged.
- Added non-public compat stream metadata `{ stream:{ deltas } }` from OpenAI Chat/Responses and Anthropic Messages handlers when the normalized request has `stream:true` and runner returned `streamDeltas`.
- Updated HTTP SSE converters to accept optional `stream.deltas` and emit one local SSE delta per upstream parsed text delta.
- Kept fallback behavior: when no `stream.deltas` are present, Chat/Responses/Anthropic SSE helpers still emit complete text as before; non-2xx `stream:true` handler errors still stay JSON.
- Updated README, API docs, M01 message protocol docs, M06 gateway docs, test-case docs, and implementation reference.

Verified:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-pool-gateway.test.js
# RED before implementation: fail: 1, local chat SSE emitted one merged "Hello" content delta instead of "Hel" and "lo".

node --test test/http-server.test.js
# RED before implementation: fail: 1, SSE converter helper ignored optional stream deltas and emitted one merged "Hello" delta.

node --test test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js test/http-server.test.js test/protocol-pool-gateway.test.js
# GREEN targeted suite: pass: 54, fail: 0

npm test
# tabbit-protocol-pool: pass: 158, fail: 0

cd E:\tabbit2api
npm test
# root gateway: pass: 228, fail: 0
```

Documentation quality scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 69 Markdown files, 0 broken local links. The scanner strips fenced and inline code before checking links.
- Sensitive placeholder scan over Markdown: 69 Markdown files, 0 live-format secret hits. Public examples keep using `sk-tabbit-local`.
- Trailing whitespace scan over `tabbit-protocol-pool`: 107 text files, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: passed with no output. The subtree is still untracked in the root worktree, so the custom trailing-whitespace scan above is the effective check for current file contents.
