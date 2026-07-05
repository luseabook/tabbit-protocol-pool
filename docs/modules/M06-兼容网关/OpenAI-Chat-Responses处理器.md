# OpenAI Chat/Responses 处理器

本文件记录 M06 当前已实现的 OpenAI 兼容纯处理器。它不直接监听端口，只接收已解析 JSON body，调用 runner，并返回 `{ status, body }`；当请求是 `stream:true` 且 runner 结果带有 `streamDeltas` 时，还会返回非公开 `{ stream:{ deltas } }` 元数据给 HTTP SSE adapter。数组 `streamDeltas` 会过滤空字符串后透传，async iterable `streamDeltas` 会原样透传给 HTTP 层做 chunked flush。OpenAI 官方工具字段在非空 `tools` 存在时会透传到 runner/protocol 请求通道；没有真实工具定义时，`tool_choice:auto/none` 与孤立 `parallel_tool_calls` 会作为 no-op 忽略。旧显式 sendPath 可写入 signed body，真实 `/api/v1/chat/completion` 会返回 `TOOL_FIELDS_UNSUPPORTED`。runner 返回内部 `tool_use` block 时，handler 会映射为 Chat `message.tool_calls` 和 Responses `function_call` output item；HTTP 层会为 Chat 输出 `tool_calls` delta，为 Responses function_call 输出 item/arguments events；客户端继续提交的 Chat `tool` message、assistant `tool_calls`、Responses `function_call` / `function_call_output` input item 会保留结构并进入 runner。当前 handler 不执行工具，也不主动循环调用工具；显式 `local_executes_tools` 的本地执行发生在 LocalToolLoopRunner wrapper 层。当前 HTTP server 已复用这些 handler，路由层不重新实现请求归一化和错误映射。

## 定位

~~~text
HTTP route adapter（JSON + SSE 已实现）
  ↓ 已解析 JSON body
OpenAICompat.handleChatCompletions / handleResponses
  ↓ normalized request
PooledRequestRunner.run
  ↓
AccountPool + ProtocolTabbitClient
~~~

这种分层让路由层只负责 HTTP 细节：认证、方法、路径、JSON 解析、响应头。OpenAI 兼容语义集中在 OpenAICompat，便于离线单测。

## Chat Completions handler

### 输入

handleChatCompletions(body) 接收 OpenAI Chat Completions 风格 JSON。当前识别字段：

| 字段 | 类型 | 默认值 | 行为 |
|---|---|---|---|
| model | string | tabbit/priority | 保持客户端可见模型名。 |
| messages | array | [] | 每个元素归一化为 runner message；普通文本保留 `{ role, content }`，assistant `tool_calls` 与 tool message `tool_call_id` 会保留。 |
| stream | boolean | false | 传递到 runner；HTTP route adapter 会在成功 2xx 结果上转换为 SSE，有数组 `stream.deltas` 时逐 delta 输出，有 async iterable `stream.deltas` 时 chunked flush，没有时完整文本 fallback。 |
| attachments | array | [] | 传递到协议客户端；真实 send 分支支持已上传附件引用，完整配置 COS 上传链时支持 raw/base64 自动上传。 |
| tools | array | undefined | OpenAI 工具定义数组，原样传给 runner；不在 compat 层执行。 |
| tool_choice | string/object | auto（仅当 tools 存在时） | 有非空 tools 时映射为内部 `toolChoice`；没有 tools 时忽略 `auto/none` 这类 no-op 选择。 |
| parallel_tool_calls | boolean | undefined | 仅在非空 tools 一起出现时映射为内部 `parallelToolCalls`，再由协议客户端写入 `parallel_tool_calls`。 |
| requiresPremium / requires_premium | boolean | false | 显式传给账号池筛选 Pro 账号；未传时 runner 仍可根据模型目录或 `Claude-Opus-*` 这类模型名自动推断所需 tier，其中 `premium_only` / Opus 会要求 Pro。 |

messages 为空且 attachments 为空时，handler 返回 400 invalid_request_error。

### 成功响应

~~~json
{
  "id": "chatcmpl_test",
  "object": "chat.completion",
  "created": 1700000001,
  "model": "tabbit/priority",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "hello" },
      "finish_reason": "stop"
    }
  ],
  "metadata": {
    "selected_model": "tabbit/Claude-Sonnet-4.6",
    "account_id": "acct_a",
    "attempted_accounts": "acct_a",
    "fallback_happened": "false"
  }
}
~~~

metadata 当前用于调试与测试。正式 HTTP 层可以保留该字段，但日志仍要脱敏账号敏感数据。

如果 runner 返回 `{ type:"tool_use", id, name, input }` content block，Chat 响应会追加 `message.tool_calls`，并把 `finish_reason` 映射为 `tool_calls`。工具参数会序列化为 OpenAI function call `arguments` 字符串。后续回合中客户端提交的 `role:"tool"` 消息会保留 `tool_call_id` 和原始 content，不会被压成普通 user 文本。

### Chat 流式错误边界

OpenAICompat 不直接消费 async iterable `streamDeltas`，也不在 handler 内写 SSE。`stream:true` 且 runner 返回 async iterable 时，handler 只把它作为非公开 `response.stream.deltas` 透传给 HTTP route adapter；如果 iterator 后续在 headers 已发送后抛错，HTTP 层负责输出 OpenAI Chat SSE error frame：

~~~text
data: {"error":{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"}}

data: [DONE]
~~~

这条边界避免 handler 为了“提前知道错误”而缓冲完整上游 body。Chat 的 JSON 非 2xx 错误仍由 OpenAICompat 在 handler 返回阶段生成；只有已开始 SSE 的 async iterator 错误才走 HTTP writer 的 error frame。

## Responses handler

### 输入

handleResponses(body) 接收 OpenAI Responses 风格 JSON。当前识别字段：

| 字段 | 类型 | 默认值 | 行为 |
|---|---|---|---|
| model | string | tabbit/priority | 保持客户端可见模型名。 |
| input | string/array | [] | 字符串变成 user message；数组元素支持 message、role、input_text、text；`function_call` 与 `function_call_output` item 会原样保留。 |
| stream | boolean | false | 传递到 runner；HTTP route adapter 会在成功 2xx 结果上转换为 SSE，有数组 `stream.deltas` 时逐 delta 输出，有 async iterable `stream.deltas` 时 chunked flush，没有时完整文本 fallback。 |
| attachments | array | [] | 传递到协议客户端；真实 send 分支支持已上传附件引用，完整配置 COS 上传链时支持 raw/base64 自动上传。 |
| tools | array | undefined | OpenAI Responses 工具定义数组，原样传给 runner；不在 compat 层执行。 |
| tool_choice | string/object | auto（仅当 tools 存在时） | 有非空 tools 时映射为内部 `toolChoice`；没有 tools 时忽略 `auto/none` 这类 no-op 选择。 |
| parallel_tool_calls | boolean | undefined | 仅在非空 tools 一起出现时映射为内部 `parallelToolCalls`，再由协议客户端写入 `parallel_tool_calls`。 |
| requiresPremium / requires_premium | boolean | false | 传给账号池。 |

input 无法归一化且 attachments 为空时，handler 返回 400 invalid_request_error。

### 成功响应

~~~json
{
  "id": "resp_test",
  "object": "response",
  "created_at": 1700000001,
  "model": "tabbit/priority",
  "output_text": "response text",
  "output": [
    {
      "id": "msg_resp_test",
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "response text" }]
    }
  ],
  "metadata": {
    "selected_model": "tabbit/Claude-Sonnet-4.6",
    "account_id": "acct_b",
    "attempted_accounts": "acct_a,acct_b",
    "fallback_happened": "true"
  }
}
~~~

## 错误映射

OpenAICompat 只输出 OpenAI 风格错误 envelope：

~~~json
{
  "error": {
    "message": "No accounts",
    "type": "api_error",
    "code": "NO_AVAILABLE_ACCOUNT"
  }
}
~~~

| runner error category | HTTP status | OpenAI type |
|---|---:|---|
| invalid_request | 400 | invalid_request_error |
| login_required | 401 | authentication_error |
| timeout | 504 | api_error |
| no_available_account | 503 | api_error |
| 其他 | 502 | api_error |

### Responses 流式错误边界

Responses 与 Chat 共享同一个 compat pass-through 设计：OpenAICompat 只把 async iterable `streamDeltas` 暴露给 HTTP 层，不把它写入 public JSON body。若 iterator 在 SSE 已开始后失败，HTTP route adapter 使用 Responses 专用 mapper 输出：

~~~text
event: response.failed
data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"}}}

data: [DONE]
~~~

payload 会以 handler 已生成的 response body 为基础，因此 `id`、`model`、`output`、`metadata` 等字段可继续保留；HTTP 层只覆盖 `status:"failed"` 并附加 `error`。这保持 Responses SSE 事件语义，同时避免 headers sent 后再尝试返回 JSON。

Responses 非流式成功响应会把 runner 的 `tool_use` content block 追加为 `type:"function_call"` output item，字段包括 `call_id`、`name`、`arguments` 和 `status:"completed"`。`stream:true` 的有限 SSE adapter 会为这些 item 输出 `response.output_item.added`、`response.function_call_arguments.delta/done` 和 `response.output_item.done`，然后再输出 `response.completed`。客户端提交 `function_call_output` 后，handler 会保留该 input item 并交给 runner；旧显式 sendPath 可继续写入 signed body。handler 本身不执行工具，也不主动驱动多轮 loop；如 gateway 使用 LocalToolLoopRunner 且显式 `local_executes_tools`，工具执行发生在 runner wrapper 层。

## 当前边界

- 不解析 HTTP Authorization header。
- 不限制 body 大小。
- 不处理非 JSON 或坏 JSON。
- handler 不直接写 SSE。`stream:true` 会传给 runner；HTTP 路由层只在 handler 返回 2xx 后，把成功 JSON 转换为 SSE。handler 的 `stream` 元数据是非公开字段，不写入 JSON body。
- handler 不捕获或重写 async `stream.deltas` 迭代期错误；该错误发生在 HTTP SSE headers 已发送之后，由 `writeSseStream()` 按 Chat `data:error` 或 Responses `response.failed` 写成 SSE error frame。
- handler 透传工具定义和工具选择，保留 Chat/Responses 工具回合输入，并把内部 `tool_use` block 映射为 OpenAI `tool_calls` / Responses `function_call`。它不执行本地工具，也不主动驱动工具调用 loop；本地执行只由外层 LocalToolLoopRunner 在 `local_executes_tools` 模式处理。
- handler 只透传顶层 `attachments`。真实协议客户端会把已上传附件引用映射为 Tabbit `references`；完整配置 COS 上传链时会先上传 raw/base64 附件再写入 file id。未完整配置时，raw/base64 附件缺少 file id/path 会返回兼容错误，不会静默降级为纯文本。
- 不提供 Anthropic Messages handler。
- 当前 OpenAI SSE adapter 能保留 `ProtocolTabbitClient` 已解析出的上游文本 delta；没有 delta 时仍完整文本 fallback。Chat 有限 SSE 会输出 `tool_calls` delta；Responses 有限 SSE 会输出 function_call item events。HTTP 层已支持 async iterable `stream.deltas` 的 chunked flush；协议客户端在显式 `sendPath`、支持的流式 Content-Type 和可读 response.body 下会直接产出 async iterable `streamDeltas`，并经 OpenAICompat 非公开 metadata 透传；async 路径可承载文本字符串和 `{ type:"tool_call_delta" }`，分别转换为 Chat `delta.tool_calls[]` 与 Responses function_call item/arguments 事件。
- 不查询模型目录。GET /v1/models 已由 HTTP route adapter 通过 modelsProvider 处理；无 provider 时返回空列表。

## 测试契约

已有 openai-compat.test.js 覆盖：

- Chat Completions 请求归一化。
- Responses 字符串输入与 message 数组归一化。
- 成功响应 shape 与 metadata。
- 空输入 400。
- invalid_request、timeout、no_available_account 错误映射。
- Chat Completions 在非空 `tools` 存在时透传 `tools`、`tool_choice`、`parallel_tool_calls` 到 runner；没有 tools 时忽略 no-op 工具选项。
- Responses 在非空 `tools` 存在时透传 `tools`、`tool_choice`、`parallel_tool_calls` 到 runner，且有 `tools` 无 `tool_choice` 时默认 `toolChoice:"auto"`；没有 tools 时忽略 no-op 工具选项。
- Chat Completions 保留 assistant `tool_calls` 与 tool message `tool_call_id`。
- Responses 保留 `function_call` 与 `function_call_output` input item，以及 message content array。
- Chat Completions 将 runner `tool_use` block 映射为 `message.tool_calls` 与 `finish_reason:"tool_calls"`。
- Responses 将 runner `tool_use` block 映射为 `function_call` output item。
- Chat Completions 和 Responses 顶层 `attachments` 会透传到 runner。
- ProtocolTabbitClient 将 buffered OpenAI stream `tool_calls` chunks 聚合为内部 `tool_use` block。
- Responses SSE converter 为 `function_call` output item 输出 `response.output_item.added`、`response.function_call_arguments.delta/done` 和 `response.output_item.done`。
- `stream:true` 且 runner 返回 async iterable `streamDeltas` 时，handler 返回非公开 `response.stream.deltas` 且 public JSON body 不包含 `stream` 或 `streamDeltas`。

HTTP server 测试已断言路由层把 body 正确交给 handler，并把 `{ status, body }` 写回客户端；`stream:true` 成功时转成 Chat/Responses SSE，覆盖完整文本 fallback、数组 `stream.deltas` 分片保留、Chat `tool_calls` delta 与 async iterable chunked flush；非 2xx handler 错误仍保持 JSON；async iterable 在已输出第一段 delta 后 reject 时，Chat 输出 OpenAI `data:error` + `[DONE]`，Responses 输出 `event: response.failed` + `[DONE]`。Gateway 测试覆盖显式协议 sendPath 的 streaming response.body：第一段上游 delta 能在第二段释放前被本地 SSE flush。

## 相关文档

- [M06-兼容网关](./_M06-兼容网关.md)
- [HTTP 路由层](./HTTP路由层.md)
- [流式 SSE 链路](../../10-流式SSE链路.md)
- [实现接口参考](../../09-实现接口参考.md)
