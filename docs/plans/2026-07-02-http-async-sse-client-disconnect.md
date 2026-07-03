# HTTP Async SSE Client Disconnect Implementation Plan

**Goal:** When a downstream client disconnects from an async `stream:true` SSE response, the HTTP route adapter should stop consuming async upstream deltas and request iterator cancellation instead of waiting forever for the next delta.

**Scope:** This slice covers HTTP writer and streaming adapter cancellation for async iterable `stream.deltas`. It does not calibrate real Tabbit endpoints, does not claim complete fetch/body backpressure behavior, and does not change finite buffered SSE responses.

**Architecture:** `writeSseStream()` owns the `ServerResponse` close signal. It accepts either an async iterable or a `(signal) => asyncIterable` factory. The Chat/Responses/Anthropic async SSE adapters receive that signal and consume `stream.deltas` through an abortable iterator wrapper that races `iterator.next()` with downstream close. If close wins, the wrapper requests `iterator.return()` and stops yielding frames.

---

## Task 1: RED client-disconnect cancellation test

**Files:**

- Modify: `test/http-server.test.js`

Add `POST /v1/chat/completions stream true cancels async deltas when client disconnects`:

- compat handler returns 2xx Chat Completion JSON;
- `stream.deltas` is a custom async iterable that yields `"Hel"`, then has a never-ending second `next()`;
- the iterator records `return()` calls;
- client requests `stream:true`, reads until the first content delta, then aborts/cancels the fetch body;
- test waits for iterator `return()`.

### RED evidence

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
```

Observed:

- 24 pass / 1 fail.
- Failure: `server did not cancel async stream deltas after client disconnect`.

---

## Task 2: GREEN close signal and abortable delta consumption

**Files:**

- Modify: `src/http-server.js`

Implementation:

- add `abortableAsyncIterable(iterable, signal)`;
- make `writeSseStream()` create an `AbortController` and abort it on `res.close` before normal completion;
- support `eventsOrFactory` so route adapters can pass the close signal into async SSE generators;
- update Chat/Responses/Anthropic async SSE generators to consume `stream.deltas` through `abortableAsyncIterable()`;
- on downstream close, stop writing SSE, do not write error frames, and request iterator `return()`.

### GREEN evidence

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js
```

Observed:

- 25 pass / 0 fail.

---

## Task 3: Documentation and verification

**Files:**

- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/HTTP路由层.md`

Document the cancellation behavior and boundary:

- HTTP writer requests async iterator `return()` on downstream close;
- this covers cancellable async delta sources;
- real Tabbit upstream fetch/body cancellation timing and backpressure still require fixture calibration.

### Documentation pass

Updated documentation:

- `README.md`: HTTP server summary now mentions downstream disconnect cancellation.
- `docs/04-开发追踪.md`: Phase 5 and risk table now distinguish HTTP writer cancellation from still-uncalibrated real upstream cancellation/backpressure.
- `docs/08-测试用例.md`: added T58 for HTTP async SSE client disconnect cancellation.
- `docs/09-实现接口参考.md`: `writeSseStream()` now documents `eventsOrFactory`, close signal, error frames, and iterator `return()` behavior.
- `docs/modules/M06-兼容网关/_M06-兼容网关.md`: M06 overview and test coverage now mention client-disconnect cancellation.
- `docs/modules/M06-兼容网关/HTTP路由层.md`: route reference now documents close signal propagation and the new regression item.

### Final verification

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/http-server.test.js test/protocol-pool-gateway.test.js test/protocol-tabbit-client.test.js test/openai-compat.test.js test/anthropic-compat.test.js
```

Observed:

- 69 pass / 0 fail.

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
npm test
```

Observed:

- 173 pass / 0 fail.

```powershell
cd E:\tabbit2api
npm test
```

Observed:

- 243 pass / 0 fail.

Documentation and formatting scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 75 files / 0 broken.
- Secret scan over `tabbit-protocol-pool` text sources: 0 hits.
- Trailing whitespace scan over `tabbit-protocol-pool`: 0 hits.
- `git diff --check -- tabbit-protocol-pool`: exit 0, no output.
