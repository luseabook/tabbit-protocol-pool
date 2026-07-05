# HTTP 路由层

本文件定义 M06 已实现的原生 HTTP server 契约。当前代码已有 OpenAICompat/AnthropicCompat 纯 handler，并通过 node:http route adapter 暴露本地 JSON 路由；OpenAI Chat/Responses 与 Anthropic Messages 的 `stream:true` 成功结果会被转换为 SSE。handler 提供数组 `stream.deltas` 时，路由层保留上游解析出的文本分片并写有限 SSE；handler 提供 async iterable `stream.deltas` 时，路由层不设置 `Content-Length`，按 delta 到达顺序 chunked flush；字符串 delta 输出文本，`tool_call_delta` 输出对应协议的工具调用事件；没有 `stream.deltas` 时回退为完整文本 delta。Chat JSON 中有 `tool_calls` 时会输出 Chat `tool_calls` delta；Responses output 中有 `function_call` item 时会输出 Responses function call item events。协议客户端 response.body async producer 已能通过 compat 非公开元数据接入这条 chunked flush 路径。

## 目标

端到端流式转换说明见 [流式 SSE 链路](../../10-流式SSE链路.md)。

把内部 handler 暴露为本地兼容接口：

| 方法 | 路径 | 认证 | 状态 |
|---|---|---:|---|
| GET | /health | 否 | 已实现 |
| GET | /v1/models | 是 | 已实现，调用 modelsProvider；无 provider 时返回空列表 |
| POST | /v1/chat/completions | 是 | 已实现，调用 OpenAICompat.handleChatCompletions；支持 SSE adapter |
| POST | /v1/responses | 是 | 已实现，调用 OpenAICompat.handleResponses；支持 SSE adapter |
| POST | /v1/messages | 是 | 已实现，调用 AnthropicCompat.handleMessages；支持 SSE adapter |

Assistants、Threads、Realtime 不在 protocol-pool 第一阶段 HTTP server 范围内。

## 公开工厂

~~~ts
type ToolCallDelta = {
  type: "tool_call_delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
};

type CreateProtocolPoolServerInput = {
  apiKey?: string;
  compat: {
    handleChatCompletions(body: unknown): Promise<{ status: number; body: unknown; stream?: { deltas?: string[] | AsyncIterable<string | ToolCallDelta> } }>;
    handleResponses(body: unknown): Promise<{ status: number; body: unknown; stream?: { deltas?: string[] | AsyncIterable<string | ToolCallDelta> } }>;
    handleMessages(body: unknown): Promise<{ status: number; body: unknown; stream?: { deltas?: string[] | AsyncIterable<string | ToolCallDelta> } }>;
  };
  modelsProvider?: { listModels(input?: object): Promise<unknown[]> } | (() => Promise<unknown[]>);
  health?: object | (() => object | Promise<object>);
};

function createProtocolPoolServer(input): http.Server;
~~~

辅助函数已导出：readJson(req)、writeJson(res, status, body)、sseData(payload)、writeSse(res, events)、writeSseStream(res, eventsOrFactory, { errorEvents? })、chatCompletionToSseEvents(body, stream?)、responsesToSseEvents(body, stream?)、anthropicMessageToSseEvents(body, stream?)、isAuthorized(req, apiKey)、openAiHttpError(status, message, type, code)。

## 认证规则

- apiKey 为空时仍建议使用默认 sk-tabbit-local，不应默认关闭鉴权。
- OpenAI 风格：Authorization: Bearer sk-tabbit-local。
- Anthropic 风格预留：x-api-key: sk-tabbit-local。
- /health 不需要认证，避免本地启动探针因为缺 header 失败。
- 认证失败返回 401 authentication_error。

~~~json
{
  "error": {
    "message": "Missing or invalid API key.",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
~~~

## JSON 解析规则

- 仅 POST 路由读取 JSON body。
- 空 body 视为 {}，是否有效由 handler 判断。
- 非 JSON 或坏 JSON 返回 400 invalid_request_error。
- Content-Type 缺失但 body 是合法 JSON 时可以接受，兼容 curl 与部分 SDK。
- 后续可加入 body size limit，当前测试已固定坏 JSON 行为。

## 路由行为

### GET /health

最小返回：

~~~json
{
  "status": "ok",
  "mode": "protocol-pool"
}
~~~

可选字段：accountPool、modelCache、lastError、uptimeMs。新增字段不应破坏最小断言。

### GET /v1/models

建议返回 OpenAI models.list shape：

~~~json
{
  "object": "list",
  "data": []
}
~~~

内部模型对象来自 ProtocolTabbitClient.normalizeModelCatalog 时，应映射 selectedModel 到 tabbit_selected_model，并保留 `requires_premium` 给客户端做付费模型提示或过滤。公开 `id` 去掉内部 `tabbit/` 前缀，只显示模型 ID；`priority` 和 `Default` 作为内部默认路由别名不输出。启动工厂传入的公开 provider 会按账号池可选 tier 过滤；账号池没有 active Pro 账号时，`premium_only` / `Claude-Opus-*` 不应出现在 `/v1/models`。

路由层本身不读取 `TABBIT_POOL_PROTOCOL_*`，也不猜测 Tabbit endpoint。没有 `modelsProvider` 时返回空列表；传入 provider 时只负责调用 provider 并做 OpenAI model shape 映射。`createProtocolPoolGateway()` 在显式协议 env opt-in 后会注入默认 provider，让该路由复用 `ProtocolTabbitClient.listModels()`；显式 `options.modelsProvider` 仍覆盖该默认 provider。

### POST /v1/chat/completions

已实现。路由层职责：

1. 校验认证。
2. 读取 JSON body。
3. 调用 compat.handleChatCompletions(body)。
4. 如果 body.stream 不是 true，按返回 status 写 application/json。
5. 如果 body.stream 是 true 且 handler 返回 2xx，把成功 JSON 转换为 `text/event-stream` SSE；有数组 `stream.deltas` 时逐 delta 输出有限 SSE，有 async iterable `stream.deltas` 时 chunked flush（字符串为文本，`tool_call_delta` 为工具事件），没有时完整文本 fallback。
6. 如果 body.stream 是 true 但 handler 返回非 2xx，保持 application/json，不启动 SSE。

不得在路由层重复实现 messages 归一化，也不得在路由层解释或改写 `tools`、`tool_choice`、`parallel_tool_calls`；这些官方工具字段由 OpenAICompat 归一化并透传到 runner/protocol。Chat SSE 事件为：

~~~text
data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"...delta 或完整文本..."}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"...","arguments":"{...}"}}]}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
~~~

`tool_calls` frame 在 handler 成功 JSON 已包含 `choices[0].message.tool_calls` 时输出；async iterable `stream.deltas` 路径如果收到 `{ type:"tool_call_delta" }`，也会按 chunked SSE 输出 `delta.tool_calls[]`，并在结束帧使用 `finish_reason:"tool_calls"`。若 async iterable `stream.deltas` 在 HTTP 已写出 SSE headers 后抛错，路由层不能再改写 status 或返回 JSON。Chat Completions 使用 OpenAI 风格 error data frame，然后发送 `[DONE]` 并结束响应：

~~~text
data: {"error":{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"}}

data: [DONE]
~~~

### POST /v1/responses

已实现。路由层职责同 Chat Completions。`stream:true` 且 handler 返回 2xx 时，Responses SSE 事件为：

路由层同样不解释或改写 Responses 的 `tools`、`tool_choice`、`parallel_tool_calls`；工具字段只随原始 body 进入 OpenAICompat。

~~~text
event: response.created
data: {"type":"response.created","response":{...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"...delta 或完整文本..."}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"function_call","arguments":""}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"{...}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"{...}"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{...}"}}

event: response.completed
data: {"type":"response.completed","response":{...}}

data: [DONE]
~~~

`response.output_item.*` 与 `response.function_call_arguments.*` 只在 compat 成功 JSON 的 `output[]` 中存在 `type:"function_call"` item 时输出。如果 compat 结果包含数组 `stream.deltas`，会输出多个 `response.output_text.delta` 并设置 Content-Length；如果包含 async iterable `stream.deltas`，会使用 chunked SSE 并按 delta 到达顺序 flush：字符串输出 `response.output_text.delta`，`tool_call_delta` 输出 `response.output_item.added`、`response.function_call_arguments.delta/done` 与 `response.output_item.done`；否则只把完整输出包成一次 delta。`ProtocolTabbitClient` 在显式 `sendPath`、支持的流式 Content-Type 和可读 response.body 下可直接产出该 async iterable。

若 async iterable `stream.deltas` 在已开始 SSE 后抛错，Responses route 使用 route-specific error mapper 输出 `response.failed`，把原 response body 保留在 `response` 字段中，并把 `status` 改为 `failed`、附加 OpenAI 风格 `error` 对象，然后发送 `[DONE]`：

~~~text
event: response.failed
data: {"type":"response.failed","response":{"id":"resp_test","status":"failed","error":{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"}}}

data: [DONE]
~~~

### POST /v1/messages

已实现 JSON 非流式。路由层职责：

1. 校验认证。
2. 读取 JSON body。
3. 调用 compat.handleMessages(body)。
4. 如果 body.stream 不是 true，按返回 status 写 application/json。
5. 如果 body.stream 是 true 且 handler 返回 2xx，把成功 JSON 转换为 `text/event-stream` SSE；有数组 `stream.deltas` 时逐 delta 输出有限 SSE，有 async iterable `stream.deltas` 时 chunked flush（字符串为文本，`tool_call_delta` 为工具事件），没有时完整文本 fallback。
6. 如果 body.stream 是 true 但 handler 返回非 2xx，保持 application/json，不启动 SSE。

坏 JSON 仍由 HTTP 层返回 OpenAI 风格 `invalid_json`，因为错误发生在 Anthropic handler 之前。路由层不解释或改写 Anthropic `tools`、`tool_choice`；工具字段只随原始 body 进入 AnthropicCompat。Anthropic SSE 事件为：

~~~text
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"...delta 或完整文本..."}}

event: content_block_stop
data: {"type":"content_block_stop"}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}

event: message_stop
data: {"type":"message_stop"}
~~~

如果 compat 结果包含数组 `stream.deltas`，第一个 text block 会输出多个 `content_block_delta` 并设置 Content-Length；如果包含 async iterable `stream.deltas`，会使用 chunked SSE 并按 delta 到达顺序 flush：字符串输出 `text_delta`，`tool_call_delta` 输出 `tool_use` content block 与 `input_json_delta`，结束时 `stop_reason` 为 `tool_use`；否则只把完整 text block 包成一次 delta。`ProtocolTabbitClient` 在显式 `sendPath`、支持的流式 Content-Type 和可读 response.body 下可直接产出该 async iterable。

若 async iterable `stream.deltas` 在已开始 SSE 后抛错，Anthropic route 输出 Anthropic 风格 `event: error`。该路径不附加 `[DONE]`，与 Anthropic 文本事件流习惯保持一致：

~~~text
event: error
data: {"type":"error","error":{"type":"api_error","message":"Current account quota exhausted"},"metadata":{"code":"QUOTA_EXHAUSTED"}}
~~~

### Async SSE 错误边界

`writeSseStream(res, eventsOrFactory, { errorEvents })` 是 async iterable 流式响应的唯一 writer。它先写 `200 text/event-stream` headers，再写入预格式化 SSE frame。`eventsOrFactory` 可以是 async iterable，也可以是 `(signal) => asyncIterable`；路由层使用 factory 形式把 downstream close signal 传给 Chat/Responses/Anthropic streaming adapter。由于 headers 一旦发送就不能切回 JSON，任何 iterator 抛错都会在 writer 内部被捕获，并通过 `errorEvents(error)` 生成剩余 SSE frame：

| 路由 | 默认/定制 mapper | 错误后输出 | 结束标记 |
|---|---|---|---|
| `/v1/chat/completions` | 默认 `streamErrorEvents` | `data: {"error":...}` | `data: [DONE]` |
| `/v1/responses` | `responsesStreamErrorEvents(result.body, error)` | `event: response.failed`，payload 中 `response.status:"failed"` | `data: [DONE]` |
| `/v1/messages` | `anthropicStreamErrorEvents` | `event: error`，payload 为 Anthropic `type:"error"` | 无 `[DONE]` |

错误 shape 统一来自 `streamErrorShape(error)`：`message` 使用 `error.message || "Stream failed."`，`type` 固定为 `api_error`，`code` 使用 `error.code || error.category || "stream_error"`。因此 `ProtocolTabbitClient` 抛出的 `ProtocolTabbitError` 会保留 `QUOTA_EXHAUSTED` 等分类信息，HTTP 层只负责协议兼容 framing，不重新分类账号状态。

客户端断开时，`ServerResponse` 的 `close` 事件会 abort close signal。writer 会停止继续写 SSE、不再输出 error frame，并请求当前 events iterator `return()`；streaming adapter 通过 `abortableAsyncIterable()` 对 `stream.deltas.next()` 与 close signal 做 race，close signal 先到时会请求 `stream.deltas` iterator `return()`。这能让可取消 async source 及时停止。真实 Tabbit fetch/body 是否能被立即中断仍取决于协议客户端和真实 runtime 行为，不在 HTTP route adapter 内猜测；真实 evidence 缺口由 `fixtures audit --scope upstream` 跟踪。

## 未知路由与方法

- 未知路由返回 404 not_found_error。
- 已知路径但方法不允许返回 404 或 405 均可，但实现前测试需固定一种。推荐 404，以贴近现有 OpenAI 风格错误 envelope。

~~~json
{
  "error": {
    "message": "Route not found.",
    "type": "invalid_request_error",
    "code": "not_found"
  }
}
~~~

## 回归测试清单

当前 test/http-server.test.js 已覆盖：

1. GET /health 返回 200 与 status/mode。
2. 缺少 Authorization 的 POST /v1/chat/completions 返回 401。
3. 坏 JSON 返回 400。
4. POST /v1/chat/completions 调用 compat.handleChatCompletions 并回写状态码。
5. POST /v1/responses 调用 compat.handleResponses 并回写状态码。
6. 未知路由返回 404 OpenAI 风格错误。
7. GET /v1/models 返回 object:list 与 data 数组。
8. POST /v1/messages 调用 compat.handleMessages 并回写状态码。
9. POST /v1/messages 缺认证返回 401，坏 JSON 返回 400。
10. POST /v1/chat/completions `stream:true` 成功时返回 chat.completion.chunk SSE，并覆盖数组 `stream.deltas` 分片保留、async 文本 chunked flush 与 async `tool_call_delta` 输出 `delta.tool_calls[]`。
11. POST /v1/responses `stream:true` 成功时返回 response.created/output_text.delta/function_call item events/completed SSE，并覆盖数组 `stream.deltas` 分片保留、function_call item events、async 文本 chunked flush 与 async `tool_call_delta` function_call item events。
12. OpenAI route `stream:true` 但 handler 返回非 2xx 时保持 JSON error。
13. POST /v1/messages `stream:true` 成功时返回 Anthropic message_start/content_block_delta/message_stop SSE，并覆盖数组 `stream.deltas` 分片保留、async 文本 chunked flush 与 async `tool_call_delta` 输出 `tool_use` / `input_json_delta`。
14. Anthropic route `stream:true` 但 handler 返回非 2xx 时保持 JSON error。
15. Protocol-pool gateway 使用显式 `TABBIT_POOL_PROTOCOL_SEND_PATH` 和 streaming upstream response.body 时，会在上游第二帧释放前先把第一段 OpenAI Chat SSE delta flush 给客户端，且响应不包含 `Content-Length`。
16. async iterable `stream.deltas` 在已输出第一段 delta 后 reject 时，HTTP 层保持 `200 text/event-stream`，Chat 输出 OpenAI `data:error` + `[DONE]`，Responses 输出 `response.failed` + `[DONE]`，Anthropic 输出 `event:error`，且不触发 headers sent 后的 JSON 写回。
17. `/v1/chat/completions` async SSE 在客户端读取第一段 delta 后断开时，请求 `stream.deltas` iterator `return()`，且不会继续等待永不完成的下一段 delta。
18. Responses SSE converter 在 output 中存在 `function_call` item 时输出 `response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done`，再输出 `response.completed`。
18. Chat Completion JSON 包含 `message.tool_calls` 时，有限 SSE adapter 会输出 OpenAI `tool_calls` delta，并把 finish_reason 保持为 `tool_calls`。
19. async `stream.deltas` 产生 `tool_call_delta` 时，Chat/Responses/Anthropic 三类路由分别输出官方风格的工具调用流式事件。

## 安全边界

- 默认 host 继续使用 127.0.0.1。
- 文档示例只使用 sk-tabbit-local。
- 不新增公网部署说明。
- 日志不能打印 Authorization、x-api-key、cookie、session 或完整邮箱 localPart。

## 相关文档

- [OpenAI Chat/Responses 处理器](./OpenAI-Chat-Responses处理器.md)
- [API 文档](../../07-API文档.md)
- [流式 SSE 链路](../../10-流式SSE链路.md)
- [HTTP server 实施计划](../../plans/2026-07-02-http-server-foundation.md)
- [OpenAI SSE fallback 计划](../../plans/2026-07-02-openai-sse-fallback.md)
- [Anthropic SSE fallback 计划](../../plans/2026-07-02-anthropic-sse-fallback.md)
- [Gateway upstream token streaming 计划](../../plans/2026-07-02-gateway-upstream-token-streaming.md)
- [HTTP async SSE flush 计划](../../plans/2026-07-02-http-async-sse-flush.md)
- [HTTP async SSE error frames 计划](../../plans/2026-07-02-http-async-sse-error-frames.md)
- [HTTP async SSE client disconnect 计划](../../plans/2026-07-02-http-async-sse-client-disconnect.md)
