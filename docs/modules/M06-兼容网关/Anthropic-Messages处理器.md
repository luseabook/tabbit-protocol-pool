# Anthropic Messages 处理器

本文件记录 M06 当前已实现的 Anthropic Messages 兼容处理器。它和 OpenAICompat 一样是纯 handler：接收已解析 JSON body，调用 runner，并返回 `{ status, body }`；当请求是 `stream:true` 且 runner 结果带有 `streamDeltas` 时，还会返回非公开 `{ stream:{ deltas } }` 元数据给 HTTP SSE adapter。数组 `streamDeltas` 会过滤空字符串后透传，async iterable `streamDeltas` 会原样透传给 HTTP 层做 chunked flush。Anthropic 官方工具字段 `tools`、`tool_choice` 会透传到 runner/protocol 请求通道；旧显式 sendPath 可写入 signed body，真实 `/api/v1/chat/completion` 会返回 `TOOL_FIELDS_UNSUPPORTED`。runner 返回内部 `tool_use` block 时，handler 会保留为 Anthropic `tool_use` content block；客户端继续提交的 `tool_use` / `tool_result` content block 会保留结构并进入 runner。当前 handler 不执行工具，也不主动驱动 `tool_result` loop；显式 `local_executes_tools` 的本地执行发生在 LocalToolLoopRunner wrapper 层。HTTP route adapter 只负责认证、JSON 解析、JSON 写回和 `stream:true` 成功结果的 SSE framing。

## 定位

~~~text
POST /v1/messages
  ↓ auth + JSON parse
AnthropicCompat.handleMessages
  ↓ normalizeAnthropicMessagesRequest
PooledRequestRunner.run
  ↓ AccountPool + ProtocolTabbitClient
AnthropicCompat.buildAnthropicMessageResponse / anthropicErrorForCategory
  ↓
HTTP JSON response / SSE adapter
~~~

当前实现范围包括 JSON 非流式和 HTTP SSE adapter。`stream:true` 会传递到 runner；handler 返回 2xx Anthropic message JSON 后，HTTP 路由层转换为 `message_start`、content block events、`message_delta`、`message_stop`。有数组 `stream.deltas` 时，第一个 text block 会输出多个 `content_block_delta`；有 async iterable `stream.deltas` 时，HTTP 层 chunked flush；没有时完整文本 fallback。协议客户端在显式 `sendPath`、支持的流式 Content-Type 和可读 response.body 下会直接产出 async iterable `streamDeltas`，并经 AnthropicCompat 非公开 metadata 透传。

协议客户端的 buffered SSE/NDJSON parser 还能把 Anthropic 上游 `content_block_start` 中的 `tool_use` 与后续 `content_block_delta` 的 `input_json_delta.partial_json` 按 index 聚合为内部 `tool_use` block。该能力发生在 ProtocolTabbitClient 层，AnthropicCompat 继续只负责把内部 block 映射为 Anthropic JSON/SSE 兼容输出。

## 请求归一化

`normalizeAnthropicMessagesRequest(body)` 识别字段：

| 字段 | 类型 | 默认值 | 行为 |
|---|---|---|---|
| `model` | string | `tabbit/priority` | 保持客户端请求模型名。 |
| `system` | string 或 content array | 空 | 非空时变成第一条 `{ role:"system" }` runner message。 |
| `messages` | array | [] | 每条消息归一化为 `{ role, content }`；普通 content array 只拼接 text block；包含 `tool_use`、`tool_result`、`server_tool_use` 或 `server_tool_result` 时保留 content array 结构。 |
| `stream` | boolean | false | 传给 runner；HTTP route adapter 会在成功 2xx 结果上转换为 SSE，有数组 `stream.deltas` 时逐 delta 输出，有 async iterable `stream.deltas` 时 chunked flush，没有时完整文本 fallback。 |
| `max_tokens` | number/null | null | 归一化为 `maxTokens`，当前记录但不直接截断。 |
| `attachments` | array | [] | 透传给 runner；真实 send 分支支持已上传附件引用，完整配置 COS 上传链时支持 raw/base64 自动上传。 |
| `tools` | array | undefined | Anthropic 工具定义数组，原样传给 runner；不在 compat 层执行。 |
| `tool_choice` | object/string | `{ type:"auto" }`（仅当 tools 存在时） | 有非空 tools 时映射为内部 `toolChoice`；没有 tools 时忽略 `{ type:"auto" }` 这类 no-op 选择。 |
| `requiresPremium` / `requires_premium` | boolean | false | 显式传给账号池筛选 Pro 账号；未传时 runner 仍可根据模型目录或 `Claude-Opus-*` 这类模型名自动推断所需 tier，其中 `premium_only` / Opus 会要求 Pro。 |

空 messages 且空 attachments 会返回 400 Anthropic error envelope，不调用 runner。工具字段只参与协议请求透传，不会绕过该最小输入校验。

## 成功响应

非流式成功响应 shape：

~~~json
{
  "id": "msg_test",
  "type": "message",
  "role": "assistant",
  "model": "tabbit/priority",
  "content": [{ "type": "text", "text": "hello" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "metadata": {
    "selected_model": "tabbit/priority",
    "account_id": "acct_a",
    "attempted_accounts": "acct_a",
    "fallback_happened": "false",
    "created_at": "1782961200"
  }
}
~~~

`usage` 当前为占位 0/0，因为 protocol-pool 还没有稳定 token accounting。后续如果还原 Tabbit token 用量，应保持字段存在并补真实数值。

工具调用当前做到输入字段透传、工具回合输入保真与基础输出映射：`tools` 和 `tool_choice` 会进入 runner；旧显式 sendPath 会进入协议客户端签名 body，真实 send 分支明确拒绝原生工具字段。成功响应会保留 runner/protocol 返回的 `tool_use` content block，并把 `stop_reason` 设为 `tool_use`；客户端后续提交的 `tool_result` content block 会保留到 runner。handler 本身不执行工具，也不主动驱动 loop；如 gateway 使用 LocalToolLoopRunner 且显式 `local_executes_tools`，工具执行发生在 runner wrapper 层。

附件当前只做顶层 `attachments` 透传。真实协议客户端会把已上传附件引用映射为 Tabbit `references`；完整配置 COS 上传链时会先上传 raw/base64 附件再写入 file id。未完整配置时，raw/base64 附件缺少 file id/path 会返回兼容错误，不会静默降级为纯文本。

## SSE adapter

`stream:true` 且 handler 返回 2xx 时，HTTP route adapter 会把成功 message JSON 转换为 SSE：

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

如果 handler 结果包含数组 `stream.deltas`，第一个 text content block 会产生多个 `text_delta`；如果包含 async iterable `stream.deltas`，HTTP 层会在每个 delta 到达时写一个 chunked SSE frame；否则每个 text content block 只产生一个完整 `text_delta`。handler 返回非 2xx 时不启动 SSE，仍返回 Anthropic JSON error。

若 async iterable `stream.deltas` 在 SSE headers 已发送后抛错，HTTP 层不能再返回 Anthropic JSON error envelope。route adapter 会把错误写成 Anthropic 文本事件流的 error event，并结束响应：

~~~text
event: error
data: {"type":"error","error":{"type":"api_error","message":"Current account quota exhausted"},"metadata":{"code":"QUOTA_EXHAUSTED"}}
~~~

Anthropic handler 只负责在返回阶段生成 JSON 成功/失败结果，并把 async iterable 作为非公开 `response.stream.deltas` 透传；迭代期错误由 HTTP `writeSseStream()` 捕获并 framed。这样可以保留已 flush 的正常 `content_block_delta`，同时给客户端一个协议内可解析的失败信号。

## 错误映射

Anthropic 风格错误 envelope：

~~~json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Pooled request failed."
  },
  "metadata": { "code": "unknown" }
}
~~~

| runner error category | HTTP status | Anthropic error.type |
|---|---:|---|
| `invalid_request` | 400 | `invalid_request_error` |
| `login_required` | 401 | `authentication_error` |
| `timeout` | 504 | `api_error` |
| `no_available_account` | 503 | `api_error` |
| 其他 | 502 | `api_error` |

## HTTP 路由行为

`POST /v1/messages` 已在 `createProtocolPoolServer()` 中接入。认证规则与 OpenAI 路由相同：支持 `Authorization: Bearer sk-tabbit-local` 和 `x-api-key: sk-tabbit-local`。坏 JSON 仍使用 HTTP 层现有 OpenAI 风格 `invalid_json` envelope，因为错误发生在 Anthropic handler 之前。`stream:true` 成功结果写 `text/event-stream`；非 2xx handler 错误保持 `application/json`。

async iterable 迭代期错误不属于“handler 返回非 2xx”场景：此时 HTTP status 和 headers 已经发出，路由层保持 `200 text/event-stream`，追加 `event:error` 后结束，不再调用 JSON writer。

## 测试契约

- `test/anthropic-compat.test.js` 覆盖请求归一化、成功响应、空输入、pooled error 映射，以及 `stream:true` 时 async iterable `streamDeltas` 作为非公开 `response.stream.deltas` 透传且不进入 public JSON body。
- `test/anthropic-compat.test.js` 覆盖非空 `tools`、`tool_choice` 透传到 runner，有 `tools` 无 `tool_choice` 时默认 `toolChoice:{ type:"auto" }`，没有 tools 时 no-op `tool_choice:{ type:"auto" }` 会被忽略，也覆盖请求中的 `tool_use` / `tool_result` content block 保真，以及 runner `tool_use` block 会保留为 Anthropic content block。
- `test/anthropic-compat.test.js` 覆盖顶层 `attachments` 会透传到 runner。
- `test/protocol-tabbit-client.test.js` 覆盖 buffered Anthropic stream `tool_use` / `input_json_delta` 聚合为内部 `tool_use` block。
- `test/http-server.test.js` 覆盖 `/v1/messages` 认证、JSON 解析、handler wiring、坏 JSON、Anthropic SSE adapter、数组 `stream.deltas` 分片保留、async iterable chunked flush，`stream:true` 非 2xx 错误保持 JSON，以及 async iterable 在已输出第一段 delta 后 reject 时输出 Anthropic `event:error`。
- `test/protocol-pool-gateway.test.js` 覆盖 gateway 中 Anthropic handler 与同一个 pooled runner 链路，也覆盖显式协议 sendPath 的 streaming response.body 到 OpenAI Chat SSE 的提前 flush。

## 相关文档

- [M06-兼容网关](./_M06-兼容网关.md)
- [HTTP 路由层](./HTTP路由层.md)
- [流式 SSE 链路](../../10-流式SSE链路.md)
- [启动工厂](./启动工厂.md)
- [实现接口参考](../../09-实现接口参考.md#anthropiccompat-接口)
