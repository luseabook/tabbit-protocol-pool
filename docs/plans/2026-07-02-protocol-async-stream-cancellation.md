# Protocol Async Stream Cancellation Implementation Plan

**Goal:** When a caller stops consuming `ProtocolTabbitClient.sendMessage({ stream:true })` async `streamDeltas`, cancel the underlying Web `ReadableStream` reader so the protocol client does not keep pulling upstream response body after the consumer is done.

**Scope:** This slice only defines local consumer cancellation for the Web `ReadableStream` branch. It does not guess real Tabbit endpoints, does not implement HTTP client disconnect propagation, and does not claim full upstream backpressure calibration.

**Architecture:** `decodeBodyTextChunks(body)` owns the Web stream reader. Natural completion should release the lock without cancellation. Abrupt async generator close via iterator `return()` should call `reader.cancel("stream_deltas_cancelled")`, ignore cancellation cleanup errors, and then release the lock.

---

## Task 1: RED cancellation test

**Files:**

- Modify: `test/protocol-tabbit-client.test.js`

Add `async streamDeltas cancellation cancels the upstream readable body`:

- fake fetch returns sign key first;
- second response has `Content-Type: text/event-stream` and a Web `ReadableStream`;
- stream enqueues one `data: {"delta":"Hel"}` frame, then waits;
- underlying source records `cancel(reason)`;
- call `sendMessage({ stream:true })`;
- consume first delta;
- call async iterator `return()`;
- assert source `cancel()` is called with `"stream_deltas_cancelled"`.

### RED evidence

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
```

Observed:

- 19 pass / 1 fail.
- Failure: `Error: upstream body was not cancelled`.

---

## Task 2: GREEN Web reader cancellation

**Files:**

- Modify: `src/protocol-tabbit-client.js`

In the Web `ReadableStream` branch of `decodeBodyTextChunks(body)`:

- track whether `reader.read()` reached `done:true`;
- in `finally`, if the stream did not complete naturally and `reader.cancel` exists, call `reader.cancel("stream_deltas_cancelled")`;
- always release the lock after cancellation handling.

### GREEN evidence

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
```

Observed:

- 20 pass / 0 fail.

---

## Task 3: Documentation and verification

**Files:**

- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`

Document the local cancellation guarantee and the remaining boundary: HTTP disconnect propagation, true upstream backpressure, and real Tabbit stream behavior still need fixture calibration.

### Documentation pass

Updated documentation:

- `README.md`: current-stage and `src/protocol-tabbit-client.js` summaries now mention async stream consumer cancellation.
- `docs/04-开发追踪.md`: M01 checklist and risk table now distinguish local consumer cancellation from still-uncalibrated HTTP disconnect/backpressure behavior.
- `docs/08-测试用例.md`: added T57 for async stream consumer cancellation.
- `docs/09-实现接口参考.md`: `sendMessage()` async path now documents iterator `return()` canceling the Web stream reader with `"stream_deltas_cancelled"`.
- `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`: response parsing and fixture lists now cover local reader cancellation.

### Final verification

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js test/http-server.test.js test/protocol-pool-gateway.test.js
```

Observed:

- 68 pass / 0 fail.

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test
```

Observed:

- 172 pass / 0 fail.

```powershell
cd E:\tabbit2api
npm test
```

Observed:

- 242 pass / 0 fail.

Documentation and formatting scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 74 files / 0 broken.
- Secret scan over `tabbit-protocol-pool` text sources: 0 hits.
- Trailing whitespace scan over `tabbit-protocol-pool`: 0 hits.
- `git diff --check -- tabbit-protocol-pool`: exit 0, no output.
