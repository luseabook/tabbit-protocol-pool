# 10-流式 SSE 链路

本文解释 protocol-pool 里一次 `stream:true` 请求如何从 Tabbit 上游流式响应，转换成 OpenAI / Anthropic 兼容的本地 SSE。它同时是维护者参考：修改 `ProtocolTabbitClient`、`OpenAICompat`、`AnthropicCompat` 或 `http-server.js` 的流式行为时，先对照本页和对应测试。

## 适用范围

当前已经实现的是 **本地 SSE adapter 与 parser foundation**：

- 外部路由：`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`。
- 上游格式：`text/event-stream`、`application/x-ndjson`、`application/jsonl`、`application/stream+json`。
- 本地输出：OpenAI Chat chunk、OpenAI Responses events、Anthropic Messages events。
- 错误边界：handler 返回非 2xx 时保持 JSON；SSE headers 已发出后的 async iterator 错误写成各协议自己的 SSE error frame。

真实 Tabbit 文本 send endpoint 已校准为 `/api/v1/chat/completion`。只有显式配置 `TABBIT_POOL_PROTOCOL_SEND_PATH`，且上游返回上述 Content-Type 时，协议客户端才会走真实流式解析路径；未配置时仍保持离线/fixture 优先的 `MISSING_SEND_PATH` 边界。

## 总览

~~~text
OpenAI / Anthropic SDK
        │  stream:true
        ▼
HTTP Route Adapter
        │  auth + readJson + streamKind dispatch
        ▼
OpenAICompat / AnthropicCompat
        │  normalize request + call runner
        ▼
PooledRequestRunner
        │  pick account + record success/failure
        ▼
ProtocolTabbitClient.sendMessage({ stream:true })
        │
        ├─ JSON/text response ───────────────► full text fallback
        ├─ SSE/NDJSON buffered response ────► streamDeltas: string[] + buffered tool_use blocks
        └─ readable response.body stream ───► streamDeltas: AsyncIterable<string | tool_call_delta>
                                             │
                                             ▼
HTTP SSE writer
        ├─ writeSse(): finite events with Content-Length
        └─ writeSseStream(): chunked flush, no Content-Length
~~~

设计目标是让兼容 handler 保持纯函数式：它只返回 `{ status, body, stream? }`，不直接写 HTTP response。HTTP 层负责 SSE framing、headers、错误帧和下游断开取消。

## 触发条件

| 条件 | 行为 |
|---|---|
| 请求体 `stream !== true` | 返回普通 JSON。 |
| `stream:true` 且 handler 返回非 2xx | 返回该 handler 的 JSON error，不启动 SSE。 |
| `stream:true`、handler 2xx、无 `stream.deltas` | 把完整成功文本包装成一个本地 delta。 |
| `stream:true`、handler 2xx、`stream.deltas: string[]` | 保留数组中的非空字符串，生成有限 SSE，并设置 `Content-Length`。 |
| `stream:true`、handler 2xx、`stream.deltas: AsyncIterable<string | tool_call_delta>` | 使用 chunked SSE 逐 delta flush，不设置 `Content-Length`；字符串输出文本 delta，`tool_call_delta` 输出工具调用事件。 |

`stream.deltas` 是 handler 和 HTTP route adapter 之间的非公开元数据，不应出现在公开 JSON body 里。

## 上游解析路径

### buffered 路径

当 fake response 或上游 response 只能通过 `text()` 读取时，`ProtocolTabbitClient` 会先读完整响应，再解析：

1. SSE 用空行切 frame，读取 `event:` 和所有 `data:` 行。
2. NDJSON / JSONL 按行解析。
3. 忽略 `[DONE]`。
4. 从稳定字段提取文本：`delta`、`text`、`content`、`message.content`、`data.delta`、`data.text`、`data.content`、`choices[0].delta.content`、`choices[0].message.content`。
5. 从 buffered OpenAI stream `tool_calls` delta（例如 `choices[0].delta.tool_calls`）按 index 聚合 `id/name/arguments`；从 buffered Anthropic stream `content_block_start` + `input_json_delta.partial_json` 按 content block index 聚合 `id/name/input`；二者都会转换为内部 `tool_use` block。
6. 聚合为最终 assistant 文本，同时保留 `raw.events` 和数组 `streamDeltas`。

### async 路径

当满足以下条件时，`sendMessage()` 会立即返回 async iterable，而不是等待上游完整结束：

- 调用方传入 `stream:true`。
- 上游 HTTP status 是 2xx。
- Content-Type 是支持的 SSE/NDJSON 类格式。
- `response.body` 可读，支持 Web `ReadableStream.getReader()` 或 async iterator。

返回形状的关键字段：

~~~ts
type AsyncProtocolResult = {
  ok: true;
  contentBlocks: [{ type: "text"; text: "" }];
  raw: { kind: "stream"; format: "sse" | "ndjson"; async: true; events: unknown[] };
  streamDeltas: AsyncIterable<string | {
    type: "tool_call_delta";
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
};
~~~

消费 `streamDeltas` 时才会读取上游 body；每解析到一个文本 delta 就 yield 字符串，每解析到 OpenAI `tool_calls` chunk 或 Anthropic `tool_use` / `input_json_delta` chunk 就 yield `tool_call_delta` 对象，并把结构化事件追加到 `raw.events`。这样本地客户端可以在上游第二帧到达前收到第一帧，工具调用参数也能按 chunked SSE 继续向外 flush。

## 本地 SSE 事件形状

| 外部 API | 成功事件顺序 | delta 事件 | 结束事件 |
|---|---|---|---|
| Chat Completions | role chunk → content/tool chunks | `data: { choices:[{ delta:{ content } }] }`；有工具调用时输出 `delta.tool_calls[]` | finish chunk（工具调用时 `finish_reason:"tool_calls"`）→ `data: [DONE]` |
| Responses | `response.created` | `event: response.output_text.delta`；有 function call 时输出 `response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done` | `response.completed` → `data: [DONE]` |
| Anthropic Messages | `message_start` → `content_block_start` | `event: content_block_delta` with `text_delta` 或 `input_json_delta` | `content_block_stop` → `message_delta`（工具调用时 `stop_reason:"tool_use"`）→ `message_stop` |

数组 delta 和 async delta 的公开事件形状一致；差异只在传输方式。数组路径会先生成完整事件列表，async 路径会边迭代边写 response。对于工具调用，buffered 路径会在最终 JSON 中聚合为内部 `tool_use`，async 路径会把每个 `tool_call_delta` 直接转成对应协议的流式工具事件。

## 错误边界

| 失败发生时机 | HTTP 层行为 | 原因 |
|---|---|---|
| auth / bad JSON / handler 返回非 2xx | 返回 JSON error，使用 handler status。 | headers 尚未发送，可以保持普通错误 envelope。 |
| Chat async iterator 在 headers 已发送后抛错 | 写 `data: {"error":...}`，再写 `data: [DONE]`。 | OpenAI Chat SSE 没有可改写 status 的机会。 |
| Responses async iterator 在 headers 已发送后抛错 | 写 `event: response.failed`，payload 中 `response.status="failed"`，再写 `[DONE]`。 | 保持 Responses 事件语义。 |
| Anthropic async iterator 在 headers 已发送后抛错 | 写 `event: error`，payload 为 Anthropic `type:"error"`。 | Anthropic 文本流用 error event 表达流内失败。 |
| 下游客户端断开 | abort close signal，并请求 `stream.deltas` iterator 的 `return()`。 | 避免继续消费可取消的上游 delta source。 |

`ProtocolTabbitClient` 会把上游流内错误帧分类为 `ProtocolTabbitError`。已识别的错误信号包括 SSE `event:error`、对象 `type:"error"` / `event:"error"`、`error`、`errorCode`、以及 `code + message`。quota / usage / credit 耗尽类信号会优先成为 `quota_exhausted`，供账号池标记当前账号并 fallback。

## 取消与资源释放

chunked SSE 由 `writeSseStream()` 管理：

1. 为 response `close` 事件创建 `AbortController`。
2. 把 signal 传给路由专属的 async SSE event generator。
3. generator 通过 `abortableAsyncIterable()` 包装 `stream.deltas`。
4. 客户端断开时 signal abort，wrapper 请求 iterator `return()`。
5. 如果上游 body 是 Web `ReadableStream`，协议客户端的 reader 会收到 `cancel("stream_deltas_cancelled")` 并释放锁。

这条链路保证本地路由不会在客户端已经离开后继续等待一个永不结束的上游流。真实 Tabbit fetch 的 backpressure、TCP 断开传播和完整错误帧集合仍要靠后续 fixture 校准。

## 实现地图

| 文件 | 职责 |
|---|---|
| `src/protocol-tabbit-client.js` | 识别上游流式 Content-Type，解析 SSE/NDJSON，产出数组或 async `streamDeltas`，聚合 buffered OpenAI stream `tool_calls` 与 Anthropic stream `input_json_delta`，并在 async 路径产出 `tool_call_delta` 对象，分类流内错误帧。 |
| `src/openai-compat.js` | 在 `stream:true` 时把 runner 的 `streamDeltas` 作为非公开 `stream.deltas` 透传。 |
| `src/anthropic-compat.js` | 与 OpenAICompat 相同，但输出 Anthropic message/error JSON。 |
| `src/http-server.js` | 根据 route kind 把成功 JSON 转成本地 SSE；处理 chunked flush、route-specific error frame 和下游断开取消。 |
| `src/protocol-pool-gateway.js` | 把显式协议 env wiring 到默认 `ProtocolTabbitClient`，让上游 streaming body 进入 HTTP adapter。 |

## 验证清单

修改流式链路后至少运行：

~~~bash
npm test
~~~

重点测试文件：

- `test/protocol-tabbit-client.test.js`：SSE/NDJSON buffered 解析、buffered OpenAI `tool_calls` 聚合、buffered Anthropic `input_json_delta` 聚合、async response.body producer、async OpenAI/Anthropic tool delta、流内错误帧、iterator cancellation。
- `test/openai-compat.test.js`：OpenAI handler 不把 `streamDeltas` 写进 public JSON，只透传非公开 metadata。
- `test/anthropic-compat.test.js`：Anthropic handler 的相同 metadata 边界。
- `test/http-server.test.js`：三类外部 SSE adapter、Responses function_call item events、async 文本与工具调用 flush、错误帧、客户端断开取消、非 2xx JSON error。
- `test/protocol-pool-gateway.test.js`：显式 `TABBIT_POOL_PROTOCOL_SEND_PATH` 下，上游第一段 delta 能在第二段释放前 flush 到本地 Chat SSE。

## 常见维护坑

- 不要为了捕获 async iterator 错误而在 compat handler 里预先消费完整 `streamDeltas`，否则会破坏首 token flush。
- 不要在 `stream:true` 非 2xx 错误上强行写 SSE；客户端更容易处理明确的 JSON error。
- 不要把 `stream.deltas` 暴露到公开 JSON body；它只是 HTTP route adapter 的内部通道。
- 不要把无法识别 file id/path 且未完整配置 COS 上传链的 raw/base64 附件请求降级为纯文本发送；客户端会误以为附件已处理。当前真实 send 分支支持已上传附件引用映射为 `references[].metadata.file_id`，也支持在 presign/complete path 完整配置时先上传 raw/base64 附件。
- 不要猜测新的 Tabbit send URL。已校准的文本路径是 `/api/v1/chat/completion`；未配置 `sendPath` 时继续返回 `MISSING_SEND_PATH`。

## 相关文档

- [API 文档](07-API文档.md)
- [架构文档](02-架构文档.md)
- [M01 消息发送协议](modules/M01-Tabbit协议客户端/消息发送协议.md)
- [M06 兼容网关](modules/M06-兼容网关/_M06-兼容网关.md)
- [HTTP 路由层](modules/M06-兼容网关/HTTP路由层.md)
- [实现接口参考](09-实现接口参考.md)
