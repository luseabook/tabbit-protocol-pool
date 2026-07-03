# Protocol Stream Error Frames Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Classify and propagate upstream SSE/NDJSON stream error frames instead of silently treating them as empty text.

**Architecture:** Keep endpoint discovery explicit. This slice only changes parser behavior after a caller has explicitly configured `sendPath` and the upstream response is already identified as SSE/NDJSON. Buffered stream parsing fails the `sendMessage()` result immediately; async stream parsing throws `ProtocolTabbitError` from the `streamDeltas` iterator after recording the raw event.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolTabbitClient`, SSE/NDJSON parser helpers, `classifyProtocolError()`.

---

### Task 1: RED buffered stream error frame

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Add `sendMessage classifies buffered stream error frames`:

- fake fetch returns sign key first;
- fake send response is `Content-Type: text/event-stream`;
- stream body contains:

```text
event: error
data: {"error":{"code":"QUOTA_EXHAUSTED","message":"Current account quota exhausted"}}
```

- call `sendMessage({ stream:true })`;
- assert `result.ok === false`;
- assert `result.error.category === "quota_exhausted"`;
- assert `result.error.code === "QUOTA_EXHAUSTED"`;
- assert `result.error.retryable === true`.

**Step 2: Run RED**

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
```

Expected: FAIL because the parser currently ignores non-text error events and returns `protocol_changed`.

### Task 2: RED async stream error frame

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write the failing test**

Add `async streamDeltas rejects when an upstream stream error frame arrives`:

- fake fetch returns sign key first;
- fake send response is `Content-Type: text/event-stream` with a Web `ReadableStream`;
- first frame is `data: {"delta":"Hel"}`;
- second frame is the same `event: error` quota frame above, released by a deferred promise;
- call `sendMessage({ stream:true })`;
- assert the first iterator item is `"Hel"`;
- release the deferred promise;
- assert the next iterator call rejects with `ProtocolTabbitError` category `quota_exhausted`;
- assert `raw.events` contains both the text event and the error event.

**Step 2: Run RED**

```powershell
node --test test/protocol-tabbit-client.test.js
```

Expected: FAIL because the async iterator currently skips the error frame and completes normally.

### Task 3: Implement stream error detection

**Files:**
- Modify: `src/protocol-tabbit-client.js`

**Step 1: Add helpers**

Add helpers near stream text extraction:

- `normalizeStreamErrorBody(value)`;
- `streamErrorFromEvent(event)`;
- `findStreamError(events)`.

Recognize:

- explicit SSE `event: error`;
- object `type:"error"` or `event:"error"`;
- object with `error`, `errorCode`, or `code + message`.

Normalize nested `{ error:{ code, message } }` to a body that `classifyProtocolError()` can classify.

**Step 2: Wire buffered path**

In `normalizeMessageResponse()`, before extracting text:

- if `body.kind === "stream"` and any parsed event is an error frame, throw `ProtocolTabbitError`.

`sendMessage()` already catches thrown errors and returns `{ ok:false, error }`.

**Step 3: Wire async path**

In `appendStreamEvent(raw, event)`:

- push the raw event first;
- if it is an error frame, throw `ProtocolTabbitError`;
- otherwise return extracted text.

This preserves `raw.events` for protocol probe fixtures and still fails the async iterator.

**Step 4: Run GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js
```

Expected: PASS.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`

**Step 1: Document behavior**

Document that:

- stream error frames are not silently ignored;
- buffered stream errors fail `sendMessage()` immediately;
- async stream errors reject from `streamDeltas` after recording the raw event;
- error classification reuses `classifyProtocolError()`;
- this still does not guess any real Tabbit endpoint or complete real error-frame fixture calibration.

**Step 2: Run verification**

```powershell
node --test test/protocol-tabbit-client.test.js
```

Then run the full suite before closing the larger implementation goal.

---

## Implementation and verification evidence

### RED

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
```

Observed result after adding tests:

- 17 pass / 2 fail.
- `sendMessage classifies buffered stream error frames` failed with actual category `protocol_changed` instead of `quota_exhausted`.
- `async streamDeltas rejects when an upstream stream error frame arrives` failed because the expected rejection was missing.

### GREEN

```powershell
node --test test/protocol-tabbit-client.test.js
```

Observed result after implementation:

- 19 pass / 0 fail.

### Final verification after documentation pass

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test

cd E:\tabbit2api
npm test
```

Observed results:

- `tabbit-protocol-pool npm test`: 168 pass / 0 fail.
- root `npm test`: 238 pass / 0 fail.

Documentation and formatting scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 72 files, 0 broken local links.
- Markdown live-format secret scan: 72 files, 0 hits.
- Trailing whitespace scan over `tabbit-protocol-pool`: 110 files, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: clean.
