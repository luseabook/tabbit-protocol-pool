# Protocol Streaming Response Parser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Teach `ProtocolTabbitClient.sendMessage()` to safely normalize explicit streaming protocol responses instead of returning raw SSE/NDJSON wire text as assistant content.

**Architecture:** Keep endpoint discovery explicit: this does not add or guess any Tabbit URL. When a caller has already configured `sendPath` and asks `stream:true`, the client should parse common text streaming envelopes from the configured response body, aggregate assistant deltas into the same `{ ok:true, contentBlocks }` shape used by non-stream responses, and keep raw parsed events for fixtures. Unsupported stream shapes must classify as `protocol_changed` rather than leaking wire frames as model text.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolTabbitClient`, fake `fetch` fixtures, no external dependencies.

---

### Task 1: RED test for SSE aggregation

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Add `sendMessage parses text/event-stream deltas from configured sendPath`. The fake fetch should return sign key first, then a `text/event-stream` body like:

```text
data: {"type":"message_delta","delta":"Hel"}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: [DONE]
```

Call `sendMessage({ stream:true })` and assert:

- `result.ok === true`;
- `result.contentBlocks` equals `[{ type:"text", text:"Hello" }]`;
- `result.raw.kind === "stream"`;
- parsed raw events do not collapse into raw `data:` wire text.

**Step 2: Run RED**

```powershell
node --test test/protocol-tabbit-client.test.js
```

Expected: FAIL because current `parseBody()` treats SSE as plain text and `normalizeMessageResponse()` returns the raw wire text.

---

### Task 2: Implement minimal stream parser

**Files:**
- Modify: `src/protocol-tabbit-client.js`

**Step 1: Add stream envelope helpers**

Add internal helpers that:

- detect `text/event-stream` content type;
- split SSE frames by blank lines;
- collect `data:` lines;
- ignore `[DONE]`;
- JSON-parse data lines when possible;
- extract text deltas from stable generic fields: `delta`, `text`, `content`, `message.content`, `choices[0].delta.content`, `choices[0].message.content`, and `data.delta` / `data.text` / `data.content`.

**Step 2: Wire `parseBody()` and `normalizeMessageResponse()`**

Return a structured body for streams, for example:

```js
{ kind: "stream", events, text }
```

Teach `messageFromBody()` / `normalizeMessageResponse()` to prefer `body.text` for `kind:"stream"`. If no text is extracted, keep the existing `protocol_changed` failure path.

**Step 3: Run GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js
```

---

### Task 3: Documentation and verification

**Files:**
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`

**Step 1: Document behavior**

Document that this is a parser foundation only. It does not implement client-facing token-level gateway streaming yet, and it does not guess real Tabbit endpoints.

**Step 2: Verify**

```powershell
node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js
npm test
cd E:\tabbit2api
npm test
```

Also run Markdown local link scan, sensitive placeholder scan, trailing whitespace scan, and:

```powershell
git diff --check -- tabbit-protocol-pool
```

---

## Implementation and verification evidence

Implemented:

- Added RED test `sendMessage parses text/event-stream deltas from configured sendPath`; verified it failed because the previous implementation returned raw `data:` wire text as assistant content.
- Added SSE stream parsing inside `ProtocolTabbitClient` response parsing for explicit configured `sendPath` calls.
- Added RED/GREEN follow-up for newline-delimited JSON streaming: `sendMessage parses newline-delimited JSON deltas from configured sendPath`.
- Added NDJSON/JSONL/stream+json detection and parsing into the same `{ kind:"stream", events, text }` shape with `raw.format === "ndjson"`.
- `sendMessage({ stream:true })` now aggregates supported `data:` delta shapes into final `contentBlocks`, stores parsed events under `raw.events`, and still uses `protocol_changed` when no assistant text can be extracted.
- Updated README, M01 protocol docs, development tracker, API docs, test cases, and implementation reference.

Verified:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
# RED before implementation: fail: 1, expected raw SSE text to become "Hello"
# GREEN after implementation: pass: 14, fail: 0

node --test test/protocol-tabbit-client.test.js
# RED follow-up before NDJSON implementation: fail: 1, expected raw NDJSON text to become "Hello"
# GREEN after NDJSON implementation: pass: 15, fail: 0

node --test test/protocol-tabbit-client.test.js test/protocol-pool-gateway.test.js
# pass: 23, fail: 0

npm test
# pass: 155, fail: 0

cd E:\tabbit2api
npm test
# pass: 225, fail: 0

# Markdown local link scan
# OK markdown local links: 67 files

# Sensitive placeholder scan
# OK sensitive placeholder scan: 67 markdown files

# Trailing whitespace scan
# OK trailing whitespace scan: 105 files considered

git diff --check -- tabbit-protocol-pool
# OK, no whitespace errors
```
