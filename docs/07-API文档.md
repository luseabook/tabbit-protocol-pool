# 07-API文档

本文件记录目标 API 契约。外部兼容 API 尽量复用 Tabbit2API 现有行为；内部 API 以当前实现和测试为准。新增公开路径、错误 envelope 或导出接口时，同步更新本文件、测试用例和实现接口参考。

## 当前状态

- 已实现 OpenAICompat.handleChatCompletions(body)、OpenAICompat.handleResponses(body) 与 AnthropicCompat.handleMessages(body) 纯 handler。
- 已实现官方工具字段通道、基础 tool call 输出映射、工具回合输入保真与受控本地工具 loop：OpenAI Chat/Responses 的非空 `tools`、`tool_choice`、`parallel_tool_calls` 与 Anthropic Messages 的非空 `tools`、`tool_choice` 默认会从 compat handler 透传到 `PooledRequestRunner`；没有真实工具定义时，compat 会忽略 no-op 工具选项，避免纯文本请求误触发真实工具未支持错误。旧显式 sendPath 骨架会把这些字段写入 `ProtocolTabbitClient.sendMessage()` 的签名请求 body，真实 `/api/v1/chat/completion` 分支明确返回 `unsupported_feature/TOOL_FIELDS_UNSUPPORTED`，避免静默丢工具字段。协议客户端可把 OpenAI `tool_calls` 与 Anthropic `tool_use` 响应归一化为内部 `tool_use` block，buffered OpenAI stream `tool_calls` chunks 与 Anthropic stream `tool_use` / `input_json_delta` chunks 也会聚合为内部 `tool_use` block；compat 会输出 Chat `message.tool_calls`、Responses `function_call` output item、Anthropic `tool_use` content block，Chat SSE adapter 会输出 `tool_calls` delta，Responses SSE adapter 会为 `function_call` 输出 `response.output_item.*` 与 `response.function_call_arguments.*` events；当客户端执行工具后继续提交 OpenAI Chat `role:"tool"` / `tool_call_id`、Responses `function_call` / `function_call_output` input item 或 Anthropic `tool_use` / `tool_result` content block 时，compat 会保留结构并传入 runner。`TABBIT_POOL_TOOL_LOOP_MODE=local_executes_tools` 且宿主注入本地 executor 时，LocalToolLoopRunner 会剥离真实协议不支持的原生工具字段、解析 JSON tool_use 文本、执行注入工具并追加 tool result 继续多轮；本地执行受 allowlist、最大轮数、单工具超时和结果截断约束，默认不启用，也不内置 shell/web/js/fetch 工具。async 上游 OpenAI `tool_calls` 与 Anthropic `tool_use` / `input_json_delta` 已能转换为内部 `tool_call_delta` 并由 HTTP SSE adapter 输出官方风格工具事件。
- 已实现 PooledRequestRunner、AccountPool、ProtocolTabbitClient 的离线可测骨架。
- 已实现 AccountProvisioner 注册/导入/session 验证基础编排层。真实 Tabbit session 验证 endpoint 已校准为 `GET /api/v0/user/base-info`；发送验证码和提交验证码已有可配置协议入口，但真实 endpoint/body success evidence 仍待还原。
- 已实现 Observability foundation，并默认接入 protocol-pool gateway `/health` 账号池摘要。
- 已实现 M08 本地运维 CLI foundation：`tabbit-pool accounts list`、`tabbit-pool accounts import-session`、`tabbit-pool accounts probe`、`tabbit-pool health`、`tabbit-pool readiness`、`tabbit-pool readiness doctor`、`tabbit-pool readiness mark`、`tabbit-pool production preflight`、`tabbit-pool production init-key`、`tabbit-pool serve/start`、`tabbit-pool smoke gateway`、`tabbit-pool maintain`、`tabbit-pool fixtures list`、`tabbit-pool fixtures audit`、`tabbit-pool fixtures show`、`tabbit-pool probe advice`、`tabbit-pool probe template`、`tabbit-pool probe validate`、`tabbit-pool probe protocol`（含 `--input-json/--input-file`、refreshQuota/uploadAttachment/只读 commerce 查询/M05 side-effect probe 模板、离线 recoverSession evidence 模板/校验/fixture 写入、离线 consumeResetCoupon evidence 模板/校验/fixture 写入、operation-aware schema validation 和 `--require-confirmed-side-effect` 离线副作用确认门禁）。
- 已实现原生 HTTP server JSON 骨架与 OpenAI/Anthropic SSE adapter：`/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。详见 [HTTP 路由层](modules/M06-兼容网关/HTTP路由层.md) 与 [流式 SSE 链路](10-流式SSE链路.md)。
- 已实现内置 Web 运维后台：`GET /admin` 返回静态管理页面，`GET /admin/api/status` 使用 gateway API key 认证后返回脱敏聚合状态，不输出 API key、cookie、session、token、`cookieJarRef`、prompt 或 raw fixture payload。
- 已实现 protocol-pool gateway 启动工厂和 `tabbit-pool serve/start` CLI，可从 config/stateDir 组合 JSON account store、FileSecretStore、StoredAccountPool、runner、OpenAICompat 与 HTTP server，并输出 OpenAI/Anthropic base URL。详见 [启动工厂](modules/M06-兼容网关/启动工厂.md)。
- 真实 Tabbit 文本发送 endpoint `/api/v1/chat/completion`、session verify endpoint `/api/v0/user/base-info`、quota usage endpoint `/api/commerce/quota/v1/usage`、已验证只读 commerce 状态/资源 endpoint、M05 显式 side-effect probe endpoint、真实重置券消耗 endpoint/body/result 语义、浏览器校准签名头、真实 `display_name` 模型目录、`Default` 可用模型映射、已上传附件引用结构和完整配置上传链时的 raw/base64 附件自动上传已接入；注册/登录 auth 入口已有显式配置和响应归一化，但真实 send-code delivery/session-material success evidence、活动 Pro 成功领取 body 和抽奖成功响应仍待安全 evidence 后接入。`ProtocolTabbitClient.sendMessage()` 已具备真实 SSE/旧显式 sendPath SSE/NDJSON buffered 响应聚合解析、buffered OpenAI stream `tool_calls` 聚合、buffered Anthropic stream `tool_use` / `input_json_delta` 聚合、数组 `streamDeltas` 保留、可读 response.body 的 async `streamDeltas` producer、async OpenAI/Anthropic 工具 delta producer，以及 stream error frame 基础分类传播。`ProtocolTabbitClient.uploadAttachment()` 已具备显式 `attachmentUploadPath` 的签名上传骨架和真实 COS 三步上传；`sendMessage({ attachments })` 在真实分支支持已上传文件引用并映射为 `references[].metadata.file_id`，完整配置上传链时会自动上传 raw/base64 附件后发送。`ProtocolTabbitClient.refreshQuota()` 只有显式 `quotaUsagePath` 时才会用已登录 Cookie + `user_id` 查询 usage 百分比；只读 activity/newbie/placement/reward/lottery 方法只做 GET 查询。默认 `maintain` 不触网；显式配置 quota usage path 后可自动刷新额度，显式配置 sign-in path 后可自动执行已验证每日签到；活动 Pro、抽奖和真实重置券消耗仍不会自动执行，真实用券当前只通过显式 `useResetCoupon` probe/gateway 方法触发。OpenAI Chat/Responses 与 Anthropic Messages handler 会把这些 deltas 作为非公开 `stream.deltas` 元数据交给 HTTP SSE adapter；没有上游 delta 时仍支持基于完整 JSON 结果的 fallback SSE。

## 认证约定

除 /health 外，外部兼容路由都需要本地 API key。

| 客户端风格 | Header | 示例 |
|---|---|---|
| OpenAI | Authorization | Bearer sk-tabbit-local |
| Anthropic | x-api-key | sk-tabbit-local |

默认 key 是 sk-tabbit-local，仅表示本地占位密钥，不是 Tabbit、OpenAI 或 Anthropic 官方密钥。默认监听地址仍应是 127.0.0.1。

认证失败返回：

~~~json
{
  "error": {
    "message": "Missing or invalid API key.",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
~~~

## 外部兼容 API（目标）

### GET /health

健康检查不触发 Tabbit 消息请求，不需要认证。第一阶段最小返回：

~~~json
{
  "status": "ok",
  "mode": "protocol-pool"
}
~~~

后续可扩展 accountPool、modelCache、lastError、uptimeMs 等字段，但不能破坏 status 和 mode 的最小契约。

### GET /admin

返回内置 Web 运维后台 HTML。页面本身不包含密钥或账号明细；浏览器会让操作者输入 gateway API key，并用 `x-api-key` 请求 `/admin/api/status`。生产环境应通过内网、VPN 或 HTTPS 反向代理限制访问。

### GET /admin/api/status

返回后台状态摘要，需要 gateway API key。输出包含 `status`、`stateDir`、`productionState.source`、`gatewayApiKey.status/source`、协议配置布尔值和 `/health` 同源账号池摘要。该接口不返回真实 API key、cookie、session、token、`cookieJarRef`、账号邮箱、prompt 或 raw fixture payload。

### GET /v1/models

返回聚合后的模型列表，建议使用 OpenAI models.list shape：

~~~json
{
  "object": "list",
  "data": [
    {
      "id": "tabbit/priority",
      "object": "model",
      "owned_by": "tabbit",
      "tabbit_selected_model": null,
      "supports_tools": true,
      "supports_images": true,
      "model_access_type": "priority"
    }
  ]
}
~~~

内部 ProtocolTabbitClient.normalizeModelCatalog() 字段映射：

| 内部字段 | 外部字段 |
|---|---|
| id | id |
| selectedModel | tabbit_selected_model |
| supports_tools | supports_tools |
| supports_images | supports_images |
| model_access_type | model_access_type |
| displayName | 可选 metadata 或保持内部使用 |

默认未启用协议 env 且未注入 `modelsProvider` 时，HTTP server 返回安全的 `tabbit/priority` fallback。通过 `TABBIT_POOL_PROTOCOL_ENABLED=true` 或 `TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH` 显式启用协议配置后，`createProtocolPoolGateway()` 会默认用 `ProtocolTabbitClient.listModels()` 支撑 `/v1/models`；`TABBIT_POOL_PROTOCOL_ENABLED=true` 会填充已校准的公共 Tabbit Web 默认 `baseUrl`、sign-key、模型目录、send、session verify 与 `REQ_CTX`。显式传入 `options.modelsProvider` 时仍以注入 provider 为准。

### POST /v1/chat/completions

OpenAI Chat Completions 兼容入口。

处理逻辑：

1. HTTP Route Adapter 校验认证。
2. 解析 JSON body。
3. 调用 OpenAICompat.handleChatCompletions(body)。
4. OpenAICompat 归一化 model、messages、stream、attachments、requiresPremium，以及 OpenAI 官方工具字段 `tools`、`tool_choice`、`parallel_tool_calls`。
5. PooledRequestRunner 从账号池选择账号并调用协议客户端。
6. `stream:true` 且 handler 返回 2xx 时，HTTP 层把成功 JSON 转换为 SSE；如果 handler 提供数组 `stream.deltas`，生成有限 SSE；如果 handler 提供 async iterable `stream.deltas`，不设置 `Content-Length` 并逐 delta flush；否则输出完整文本 fallback；其他情况返回 OpenAI 兼容 JSON。

最小请求：

~~~json
{
  "model": "tabbit/priority",
  "messages": [
    { "role": "user", "content": "hello" }
  ]
}
~~~

非流式成功响应由 OpenAICompat.buildChatCompletionResponse() 生成，object 固定为 chat.completion，choices[0].message.content 包含助手文本。

`stream:true` 的当前行为是 **SSE adapter**：HTTP route adapter 仍先调用同一个 handler；如果返回 2xx，就写出 `text/event-stream`，依次包含 assistant role delta、一个或多个 content delta、finish chunk 和 `data: [DONE]`。当 `ProtocolTabbitClient` 从显式 `sendPath` 的 SSE/NDJSON 响应中解析出 `streamDeltas` 时，每个 delta 会变成一个本地 content chunk；没有 `streamDeltas` 时回退为一个完整文本 content delta。handler 返回非 2xx 时不启动 SSE，仍返回原 status 与 JSON error。若 `ProtocolTabbitClient` 在可读 response.body 上返回 async iterable `streamDeltas`，OpenAICompat 会把它作为非公开 `stream.deltas` 透传，HTTP 层使用 chunked SSE，不设置 `Content-Length`，并在每个 delta 到达时写出 frame。若 async iterable 在 SSE headers 已发送后抛错，Chat Completions 会写 `data: {"error":...}`，随后写 `data: [DONE]` 并结束响应。

工具字段当前已形成输入/输出基础通道：`tools` 为非空数组时保留原始工具定义；`tool_choice` 映射为内部 `toolChoice`，未提供但存在 `tools` 时默认 `"auto"`；`parallel_tool_calls` 仅在非空 tools 一起出现时映射为内部 `parallelToolCalls` 布尔值。没有 tools 时，`tool_choice:auto/none` 与孤立 `parallel_tool_calls` 会被当作 no-op 忽略。runner/protocol 返回内部 `tool_use` block 时，Chat JSON 会输出 `message.tool_calls`，`finish_reason` 映射为 `tool_calls`；Chat 有限 SSE fallback 会输出 `tool_calls` delta；async 上游 `tool_call_delta` 会在 chunked Chat SSE 中输出 `delta.tool_calls[]`，并在结束帧使用 `finish_reason:"tool_calls"`。工具回合输入会保持官方结构：assistant 消息的 `tool_calls`、tool 消息的 `tool_call_id` 与 `role:"tool"` 不会被丢弃。compat 层仍不执行工具，也不主动循环调用工具。

### POST /v1/responses

OpenAI Responses 兼容入口。目标是保留现有 Tabbit2API 的文本输入、消息归一化、工具调用结构和 SSE 事件习惯。

最小请求：

~~~json
{
  "model": "tabbit/priority",
  "input": "hello"
}
~~~

当前纯 handler 支持：

- input 为字符串。
- input 为 message 数组。
- input item 是 message、role、input_text 或 text 结构。
- input item 是 `function_call` 或 `function_call_output` 时原样保留到 runner messages，避免工具结果被转成空字符串或 `[object Object]`。
- attachments 数组透传到 runner。
- 非空 `tools`、`tool_choice`、`parallel_tool_calls` 透传到 runner；有 `tools` 但缺少 `tool_choice` 时默认 `toolChoice:"auto"`；没有 tools 时 no-op 工具选项会被忽略。

非流式成功响应包含 output_text 和 output message；runner/protocol 返回内部 `tool_use` block 时，还会追加 Responses `function_call` output item。`stream:true` 的当前行为是 **SSE adapter**：HTTP route adapter 先调用同一个 handler；如果返回 2xx，就写出 `event: response.created`、一个或多个 `event: response.output_text.delta`、Responses `function_call` item events（`response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done`）、`event: response.completed` 和 `data: [DONE]`。有数组 `streamDeltas` 时逐 delta 输出有限 SSE；有 async iterable `streamDeltas` 时经 OpenAICompat 透传为 `stream.deltas` 并 chunked flush，其中字符串生成文本 delta，`tool_call_delta` 生成 Responses function_call item/arguments 事件；没有 `streamDeltas` 时 `response.output_text.delta` 携带完整 `output_text`。handler 返回非 2xx 时保持 JSON error。若 async iterable 在 SSE headers 已发送后抛错，Responses 会写 `event: response.failed`，payload 中 `response.status` 为 `failed` 且包含 OpenAI 风格 error，随后写 `[DONE]`。

### POST /v1/messages

Anthropic Messages 兼容入口。当前已实现 JSON 非流式 handler、HTTP route adapter，以及 `stream:true` SSE adapter。

最小请求：

~~~json
{
  "model": "tabbit/priority",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "max_tokens": 1024
}
~~~

当前纯 handler 支持：

- system 字符串或 text content array。
- messages 数组，content 可为字符串或 text block 数组。
- messages 中含 `tool_use` / `tool_result` / `server_tool_use` / `server_tool_result` content block 时保留数组结构，不再只拼接 text block。
- stream 布尔值透传到 runner；HTTP route adapter 会在 2xx 成功结果上转换为 SSE，有数组 `stream.deltas` 时逐 delta 输出有限 SSE，有 async iterable `stream.deltas` 时 chunked flush，没有时完整文本 fallback。
- attachments 数组透传到 runner。
- `tools`、`tool_choice` 透传到 runner；有 `tools` 但缺少 `tool_choice` 时默认 `toolChoice:{ type:"auto" }`。
- requiresPremium / requires_premium 传给账号池。

非流式成功响应包含 `type:"message"`、`role:"assistant"`、`content:[{type:"text"}]`、`stop_reason:"end_turn"` 与 metadata。

`stream:true` 的当前行为是 **SSE adapter**：HTTP route adapter 先调用同一个 handler；如果返回 2xx，就写出 `message_start`、每个 content block 的 `content_block_start` / `content_block_delta` / `content_block_stop`、`message_delta` 和 `message_stop`。有数组 `streamDeltas` 时会为第一个 text block 输出多个 `text_delta`；有 async iterable `streamDeltas` 时经 AnthropicCompat 透传为 `stream.deltas` 并 chunked flush，其中字符串生成 `text_delta`，`tool_call_delta` 生成 `tool_use` content block 与 `input_json_delta`，结束时 `stop_reason` 为 `tool_use`；没有 `streamDeltas` 时 text delta 携带完整 text block。handler 返回非 2xx 时保持 Anthropic JSON error。若 async iterable 在 SSE headers 已发送后抛错，Anthropic route 会写 `event: error`，payload 为 Anthropic 风格 `type:"error"`。

## 外部错误规则

OpenAI 风格错误 envelope：

~~~json
{
  "error": {
    "message": "Pooled request failed.",
    "type": "api_error",
    "code": "unknown"
  }
}
~~~

| 场景 | HTTP status | type | code |
|---|---:|---|---|
| 缺少或错误 API key | 401 | authentication_error | invalid_api_key |
| 非 JSON / 坏 JSON | 400 | invalid_request_error | invalid_json |
| 空 Chat messages 且无附件 | 400 | invalid_request_error | invalid_request |
| 空 Responses input 且无附件 | 400 | invalid_request_error | invalid_request |
| login_required | 401 | authentication_error | 上游 code 或 category |
| no_available_account | 503 | api_error | NO_AVAILABLE_ACCOUNT |
| timeout | 504 | api_error | TIMEOUT |
| protocol_changed | 502 | api_error | protocol_changed |
| 未知路由 | 404 | invalid_request_error | not_found |

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

| 场景 | HTTP status | Anthropic error.type | metadata.code |
|---|---:|---|---|
| 空 messages 且无附件 | 400 | invalid_request_error | invalid_request |
| login_required | 401 | authentication_error | 上游 code 或 category |
| no_available_account | 503 | api_error | NO_AVAILABLE_ACCOUNT |
| timeout | 504 | api_error | TIMEOUT |
| 其他 pooled error | 502 | api_error | 上游 code 或 category |

## 内部模块 API（当前实现）

完整导出参考见 [09-实现接口参考](09-实现接口参考.md)。本节列出与外部 API 最相关的接口。

### OpenAICompat.handleChatCompletions(body)

~~~ts
type HandlerResult = {
  status: number;
  body: unknown;
};
~~~

输入字段：model、messages、stream、attachments、requiresPremium、requires_premium、tools、tool_choice、parallel_tool_calls。返回 { status, body }，不直接操作 HTTP response；有非空 tools 时工具字段会透传，没有 tools 时 `tool_choice:auto/none` 与孤立 `parallel_tool_calls` 会作为 no-op 忽略；assistant `tool_calls` 与 tool message `tool_call_id` 会保留到 runner messages，内部 `tool_use` block 会映射为 OpenAI `message.tool_calls`，但不在 handler 层执行。

### OpenAICompat.handleResponses(body)

输入字段：model、input、stream、attachments、requiresPremium、requires_premium、tools、tool_choice、parallel_tool_calls。返回 { status, body }；有非空 tools 时工具字段会透传，没有 tools 时 `tool_choice:auto/none` 与孤立 `parallel_tool_calls` 会作为 no-op 忽略；`function_call` 与 `function_call_output` input item 会保留到 runner messages，内部 `tool_use` block 会映射为 Responses `function_call` output item，但不在 handler 层执行。

### AnthropicCompat.handleMessages(body)

输入字段：model、system、messages、stream、max_tokens、attachments、requiresPremium、requires_premium、tools、tool_choice。返回 { status, body }，不直接操作 HTTP response；有非空 tools 时工具字段会透传，没有 tools 时 `tool_choice:{type:"auto"}` 会作为 no-op 忽略；请求中的 `tool_use` / `tool_result` content block 会保留到 runner messages，内部 `tool_use` block 会保留为 Anthropic `tool_use` content block，但不在 handler 层执行。详见 [Anthropic Messages 处理器](modules/M06-兼容网关/Anthropic-Messages处理器.md)。

### PooledRequestRunner.run(input)

~~~ts
type RunnerInput = {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  attachments?: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean | null;
  requiresPremium?: boolean;
  requestId?: string | null;
};
~~~

成功时返回 ok:true，并附加 accountId、attemptedAccounts、fallbackHappened、selectedModel。失败时返回 ok:false 和标准化 error，不让 HTTP 层直接处理账号池内部异常。

### ProtocolTabbitClient.sendMessage(input)

~~~ts
type SendMessageInput = {
  account?: { cookie?: string; cookieHeader?: string };
  model: string;
  messages?: Array<{ role: string; content: string }>;
  attachments?: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean | null;
  chatSessionId?: string | null;
  content?: string | null;
  references?: unknown[];
};
~~~

已校准文本发送接口：

~~~text
GET  https://web.tabbit.ai/chat/sign-key
POST https://web.tabbit.ai/api/v1/chat/completion
~~~

当前 `sendPath` 必须显式配置。`sendPath === "/api/v1/chat/completion"` 时，协议客户端构造真实 Tabbit body：`chat_session_id`、`message_id:null`、`content`、`selected_model`、`parallel_group_id:null`、`task_name:"chat"`、`agent_mode:false`、`metadatas.html_content`、`references` 和空 tab `entity`。`chat_session_id` 来自 input、账号元数据或 `TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID`；`tabbit/priority` 会映射为 `selected_model:"Default"`。真实分支使用浏览器签名头：`x-signature` 为 UUID/randomUUID 风格字符串，`x-nonce` 为 `HMAC-SHA256(signKey, timestamp.signature.sha256(bodyText))`。

真实 `/api/v1/chat/completion` 分支中，`sendMessage({ attachments })` 支持已上传附件引用：`path/file_id/fileId/id/metadata.file_id` 会被归一化为 Tabbit `references[].metadata.file_id`，document 使用 `{ type:"document", title, content:"", metadata:{ file_id } }`，image 使用 `{ type:"image", title, content, metadata:{ file_id, source_url? } }`。如果附件缺少 file id/path 但包含 `data`、`base64`、`raw` 或 `body`，并且已配置 `attachmentUploadPath=/proxy/v0/cos/presigned-upload-url` 与 `attachmentCompleteUploadPath=/api/v0/cos/complete-upload`，客户端会先走 presign -> COS PUT -> complete-upload，再把 file id 放入 `references`；未完整配置上传链时仍返回 `unsupported_feature/ATTACHMENT_REFERENCE_REQUIRED`。旧显式 sendPath 骨架收到附件引用仍返回 `unsupported_feature/ATTACHMENTS_UNSUPPORTED`。旧显式 sendPath 骨架仍会把 `tools`、`toolChoice`、`parallelToolCalls` 分别写入签名 body 的 `tools`、`tool_choice`、`parallel_tool_calls` 字段；真实 `/api/v1/chat/completion` 在官方工具字段协议完成 fixture 校准前返回 `unsupported_feature/TOOL_FIELDS_UNSUPPORTED`，不触发上游发送。响应侧已能把上游 OpenAI `tool_calls` 与 Anthropic `tool_use` JSON 归一化为内部 `tool_use` block。

响应解析支持两类成功形状：

- JSON / text 完整响应：从 `text`、`content`、`message.content`、`message.text`、`data.text`、`data.content`、`choices[0].message.content` 提取 assistant 文本。
- `Content-Type: text/event-stream`：把 SSE frame 的 `data:` 行解析为 events，忽略 `[DONE]`，再从 `delta`、`text`、`content`、`message.content`、`data.delta`、`data.text`、`data.content`、`choices[0].delta.content`、`choices[0].message.content` 聚合文本。
- `Content-Type: application/x-ndjson`、`application/jsonl` 或 `application/stream+json`：按行解析 JSON / 文本 delta，使用同一组字段提取文本，`raw.format` 为 `ndjson`。

流式响应有两种返回路径；端到端 HTTP 转换规则见 [流式 SSE 链路](10-流式SSE链路.md)：

- buffered 路径：当 `response.body` 不可读或 fake response 只提供 `text()` 时，协议客户端先读取完整响应文本，再返回 `{ ok:true, contentBlocks:[{ type:"text", text }], raw, streamDeltas:string[] }`。如果 buffered OpenAI stream frame 携带 `choices[0].delta.tool_calls`，会按 tool call index 聚合 `id/name/arguments` 并返回内部 `tool_use` block；如果 buffered Anthropic stream frame 携带 `content_block_start` 的 `tool_use` 和 `content_block_delta` 的 `input_json_delta.partial_json`，会按 content block index 聚合为内部 `tool_use` block；`raw.kind === "stream"` 且 `raw.events` 保留结构化事件，方便 protocol probe fixture 复现。
- async 路径：当 `stream:true`、上游 2xx、Content-Type 是 SSE/NDJSON 且 `response.body` 可读时，协议客户端立即返回 `{ ok:true, contentBlocks:[{ type:"text", text:"" }], raw:{ kind:"stream", format, async:true, events:[] }, streamDeltas:AsyncIterable<string | tool_call_delta> }`。迭代 `streamDeltas` 时会边读 response.body 边解析 delta，并把结构化事件追加到 `raw.events`；文本 chunk 以字符串 yield，OpenAI `tool_calls` / Anthropic `tool_use` / `input_json_delta` 以 `{ type:"tool_call_delta", index, id?, name?, argumentsDelta? }` yield。
- 错误帧路径：如果 SSE `event:error`、`type:"error"`、`event:"error"`、`error`、`errorCode` 或 `code + message` 形状出现在 buffered stream 中，`sendMessage()` 会返回 `{ ok:false, error }`；如果出现在 async stream 中，`streamDeltas` 会在记录该 raw event 后抛出 `ProtocolTabbitError`。错误分类复用 `classifyProtocolError()`，因此 quota/usage/credit 耗尽信号会成为 `quota_exhausted`。

真实 `/api/v1/chat/completion` 已通过 `Default` 模型完成文本 SSE 探针，并通过已上传附件 `references[].metadata.file_id` 与 raw/base64 自动上传后发送完成附件探针。真实上游私有工具语义、更多错误帧和取消/backpressure 仍需后续 fixture 校准；官方原生工具字段已确认返回 `TOOL_FIELDS_UNSUPPORTED`，真实上游 stream boundary 缺口可用 `fixtures audit --scope upstream` 只读跟踪。

### ProtocolTabbitClient.sendVerificationCode(input)

~~~ts
type SendVerificationCodeInput = {
  email?: string;
  mobile?: string;
  uuid?: string;
  body?: Record<string, unknown> | null;
  input?: { authSendCodeBody?: Record<string, unknown>; mobile?: string; uuid?: string; authClientUuid?: string };
};
~~~

该方法是 M04 注册/登录校准入口，不代表真实验证码投递成功已闭环。必须显式配置 `authSendCodePath` 或 `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH`；未配置时返回 `{ ok:false, error.code:"MISSING_AUTH_SEND_CODE_PATH" }` 且不触网。默认 method 是 `POST`，可用 `authSendCodeMethod` / `TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_METHOD` 覆盖。

非 `/proxy/v0/oauth/*` path 仍使用旧签名 auth 占位 body：

~~~json
{ "email": "new-user@example.test" }
~~~

真实登录页 chunk 已校准 `/proxy/v0/oauth/send-verification-code` 的浏览器 body：

~~~json
{ "uuid": "<64-char-alnum>", "platform": "1", "version": "", "app": "1000", "mobile": "10000000000" }
~~~

proxy OAuth 分支不获取 sign-key，不发送 `x-signature` / `x-nonce` / `x-timestamp`；`uuid` 是登录组件生成并复用的 64 位字母数字 auth client value。若传入显式 `body` 或 `input.authSendCodeBody`，实现会优先使用显式 body。Yoda/captcha 成功仍 blocked：真实页面在 send-code 错误体含 `data.verifyUrl + data.requestCode` 时调用 `window.YodaSeed(...)`，项目尚未捕获安全验证码投递成功 fixture。

### ProtocolTabbitClient.submitRegistrationOrLogin(input)

~~~ts
type SubmitRegistrationOrLoginInput = {
  email?: string;
  mobile?: string;
  uuid?: string;
  code: string;
  body?: Record<string, unknown> | null;
  input?: { authSubmitCodeBody?: Record<string, unknown>; mobile?: string; uuid?: string; authClientUuid?: string; channel?: string };
};
~~~

必须显式配置 `authSubmitCodePath` 或 `TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH`；未配置时返回 `{ ok:false, error.code:"MISSING_AUTH_SUBMIT_CODE_PATH" }` 且不触网。非 proxy path 默认 body 是 `{ "email": "...", "code": "..." }`，只用于旧校准占位。真实登录页 chunk 已校准 `/proxy/v0/oauth/login` body 为 `{ "uuid": "<64-char-alnum>", "platform": "1", "version": "", "app": "1000", "mobile": "...", "smsCode": "..." }`，可选 `channel`；proxy OAuth 分支不获取 sign-key。成功响应会归一化 `cookieHeader`、`cookie`、`session`、`sessionToken`、`token`、`userId`、`accessTier`，供 `AccountProvisioner.extractSessionSecret()` 写入 secret store。raw cookie/session/token 不应进入 stdout、文档、fixture 原文或账号 JSON 元数据。

### ProtocolTabbitClient.uploadAttachment(input)

~~~ts
type UploadAttachmentInput = {
  account?: { cookie?: string; cookieHeader?: string };
  attachment?: {
    filename?: string;
    mimeType?: string;
    data?: string;
    [key: string]: unknown;
  };
};
~~~

`attachmentUploadPath` 必须显式配置。未配置时返回 `protocol_missing/MISSING_ATTACHMENT_UPLOAD_PATH` 且不触网。只配置 `attachmentUploadPath` 时保留旧上传骨架：先请求 sign key，再对 `POST + attachmentUploadPath + { attachment }` 生成签名头，携带 `Content-Type: application/json` 和可用 `Cookie`，并把响应中的 `id/attachmentId/fileId`、`name/filename/fileName`、`mimeType/contentType/type`、`size/bytes` 归一化为 `attachment.id/name/mimeType/size`。同时配置 `attachmentCompleteUploadPath` 时使用真实 COS 三步链：`POST /proxy/v0/cos/presigned-upload-url`、`PUT <presigned COS url>`、`POST /api/v0/cos/complete-upload`；两个 Tabbit POST 只携带 `Content-Type`、`trace-id` 和 Cookie，不请求 sign key、不发送 `x-signature/x-nonce`。

### ProtocolTabbitClient.refreshQuota(input)

~~~ts
type RefreshQuotaInput = {
  account?: { cookie?: string; cookieHeader?: string; userId?: string };
  userId?: string | null;
};
~~~

真实额度 usage 查询接口已校准为：

~~~text
GET https://web.tabbit.ai/api/commerce/quota/v1/usage?user_id=<user_id>
~~~

`quotaUsagePath` 必须显式配置，推荐值是 `/api/commerce/quota/v1/usage`。未配置时抛出 `protocol_missing/MISSING_QUOTA_USAGE_PATH`，缺少 `userId` 时抛出 `invalid_request/MISSING_USER_ID`，缺少 Cookie/session 时抛出 `session_missing/SESSION_MISSING`，这些前置失败都不会触网。真实抓包未看到该接口使用 `x-signature` 或 `x-nonce`，因此当前实现不获取 sign key、不加签；请求 header 只包含 `accept: application/json`、可选 `x-req-ctx`、`unique-uuid` 和 hydrated `Cookie`。

成功响应会归一化为：

- `source: "tabbit-quota-usage"`。
- `accessTier` 来自 `member_level` 等字段。
- `resetCouponCount` 来自 `unused_reset_coupon_count` 等字段。
- `quotaState[0]` 使用 `model:"tabbit/priority"`、`unit:"usage_percentage"`、`remaining:null`、`limit:null`、`resetAt` 来自 `current_cycle_end`，并保留扩展字段 `usagePercentage`；`usagePercentage >= 100` 时 `exhausted:true`。

该接口只说明当前账号 usage 百分比、周期结束和未用重置券数量；不会自动触发活动 Pro 领取、抽奖或重置券使用。每日签到已有独立成功 evidence，可在显式 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH` 下由默认维护链执行；其它 M05 side-effect endpoint 仍只作为显式 probe 校准，默认维护链不调用这些 POST。

### ProtocolTabbitClient 只读 commerce 状态/资源方法

已校准多条 `/api/commerce` 只读 GET；构造参数必须显式提供对应 path，缺 path、缺 Cookie、缺 `placementCode` 或记录查询缺 `userId` 时不会触网。请求 header 与 quota usage 类似：`accept: application/json`、可选 `x-req-ctx`、`unique-uuid` 和 hydrated `Cookie`；不获取 sign key，不发送 `x-signature` / `x-nonce`。

| 方法 | 真实路径 | 关键输入 |
|---|---|---|
| `getLotteryExplorationMe({ account })` | `/api/commerce/activity/v1/lottery/me` | 已登录 Cookie。 |
| `getNewbieExplorationMe(input)` | `/api/commerce/activity/v1/newbie-exploration/me` | `viewMode` 必须是 `event_gate`、`float_collapsed`、`float_expanded` 或 `activity_page`；`includeCompletions` / `includeRewards` 可选。 |
| `getPlacementResources(input)` | `/api/commerce/placement/v1/resources?placement_code=...` | `placementCode` 默认 `home.input_below`，可选 `clientVersion` 会写入 `client_version` query。 |
| `listRewardCardRecords(input)` | `/api/commerce/reward/v1/card-records?user_id=...` | `userId`、`offset`、`limit`、`order`，可选 `rewardPackageId` / `awardStatus`。 |
| `listLotteryHitRecords(input)` | `/api/commerce/lottery/v1/hit-records?user_id=...` | `userId`、`offset`、`limit`，可选 `mainPoolId`。 |

这些方法只用于状态/资源探针和脱敏 fixture，不会执行活动领取、抽奖或重置券使用。默认 `BenefitsMaintainer.maintainAccount()` 只在配置 `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH` 后执行真实 `refreshQuota`，只在配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH` 后执行已验证 `dailyCheckin`；其它维护动作继续依赖注入协议方法。

### ProtocolTabbitClient M05 side-effect probe 方法

已校准的 M05 辅助接口均必须显式配置对应 path，缺 path、缺 Cookie、缺 `userId` 或缺业务必填字段时不会触网。GET 方法不请求 sign key，不发送 `x-signature` / `x-nonce`；POST 方法使用生产调用点观察到的 header 族，并且必须传入 `confirmSideEffect:true`。

| 方法 | 真实路径 | 关键输入与边界 |
|---|---|---|
| `getDailySignInStatus(input)` | `/api/commerce/activity/v1/sign-in/status` | GET，`scene_codes` 可重复，默认场景为 `desktop_pet`。 |
| `dailySignIn(input)` | `/api/commerce/activity/v1/sign-in` | POST，body 为 `{ request_no, scene_codes }`；`request_no` 由调用方生成，必须非空且不超过 64 字符；使用 `trace-id + Content-Type`；必须显式确认副作用。 |
| `listBenefitCoupons(input)` | `/api/commerce/benefit/v1/coupon/list` | GET，默认 `coupon_type=weekly_reset_coupon`、offset 0、limit 50；使用账号 `userId` 或 input 覆盖。 |
| `participateResetCouponActivity(input)` | `/api/commerce/activity/v1/participate` | POST，body 为 `{ user_id, request_no }`；`request_no` 由调用方生成，必须非空且不超过 64 字符；使用 `x-req-ctx + unique-uuid + Content-Type`；200 不能直接解释为真实用券成功。 |
| `participateActivity(input)` | `/api/commerce/activity/v1/participate` | POST，body 由调用方提供；使用 `trace-id + Content-Type`；尚未绑定到“活动 Pro 成功领取”维护动作。 |
| `getUsageResetCouponSku(input)` | `/api/commerce/product/v1/sku/usage-reset-coupon` | GET，当前 live evidence 可返回 `PRODUCT_NOT_PURCHASABLE`。 |
| `getAvailableLotteryChanceCount(input)` | `/api/commerce/lottery/v1/available-chances` | GET，query 为 `user_id` 与 `activity_id`。 |
| `getActiveMainPools(input)` | `/api/commerce/lottery/v1/active-main-pools` | GET，query 为 `activity_id`。 |
| `listLotteryChanceRecords(input)` | `/api/commerce/activity/v1/lottery/chance-records` | GET，query 为 `activity_id`、`offset`、`limit`。 |
| `drawLottery(input)` | `/api/commerce/lottery/v1/draw` | POST，body 由调用方提供；使用 `trace-id + Content-Type`；必须显式确认副作用。 |

`dailySignIn()` 会把返回中的 `sign_in_date`、首个 `results[].signed_today`、`results[].sign_in_result`、`signed_days` 和 `total_signed_days` 归一化为 `signInDate`、`signedToday`、`signInResult`、`signedDays` 和 `totalSignedDays`，方便显式 probe fixture 直接判断签到状态。`participateResetCouponActivity()` / `participateActivity()` / `drawLottery()` 这类通用 commerce object 响应会保留 `activity_id` -> `activityId`、`participation_result` -> `participationResult`。

2026-07-03 live 脱敏 evidence `output/tabbit-benefits-side-effects/side-effect-live-20260703T082435232Z.sanitized.json` 验证：短生产形态 `request_no` 可让 `dailySignIn` 返回 `sign_in_result:"success"`，后续状态从 `signed_today:false` 变为 `signed_today:true`；`participateResetCouponActivity` 返回 `participation_result:"already_participated"`，但重置券列表和 quota usage 前后 hash 不变，因此不能视为“消耗已有重置券恢复额度”。

### ProtocolTabbitClient.verifySession(input)

~~~ts
type VerifySessionInput = {
  account?: { cookie?: string; cookieHeader?: string };
  session?: string | null;
};
~~~

默认不会猜测真实 Tabbit session verifier 路径。构造参数未配置 `sessionVerifyPath` 时返回 `ok:false/category:"protocol_missing"/code:"MISSING_SESSION_VERIFY_PATH"`，且不会调用 `fetch()`。当前真实路径已校准为 `GET /api/v0/user/base-info`，配置 `sessionVerifyPath` 后仍要求 `session`、`account.cookie` 或 `account.cookieHeader` 至少有一个存在；缺失时返回 `session_missing/SESSION_MISSING`，也不会获取 sign key。

会话材料存在时，客户端先调用 `getSignKey()`，再按 `sessionVerifyMethod`（默认 `GET`）和 `sessionVerifyPath` 生成签名头，把会话写入 `Cookie` header，并请求 `baseUrl + sessionVerifyPath`。真实 `GET /api/v0/user/base-info` 成功响应中的 `user_info.id` 会归一化为 `userId`；其他 2xx 响应归一化为 `{ ok:true, userId?, accessTier?, raw }`。401 返回 `category:"login_required"`、`accountStatus:"login_expired"`、`httpStatus:401`；其他 HTTP 错误沿用 `classifyProtocolError()`。

### ProtocolTabbitClient.listModels(input)

请求：

~~~text
GET https://web.tabbit.ai/proxy/v1/model_config/models?a=0&scene=chat
~~~

返回 normalizeModelCatalog() 的结果，第一项始终是 tabbit/priority。真实目录使用 `models/status` 包装和 `display_name`、`supports_images`、`supports_tools`、`model_access_type` 字段；`Default` 当前是 `free_unlimited`，`GPT-5.5` 当前是 `premium_only`。

### AccountPool.pickAccount(input)

~~~ts
type PickAccountInput = {
  model?: string;
  requiresPremium?: boolean;
  excludeAccountIds?: string[];
};

type PickAccountResult = {
  account: Account;
  reason: string;
  candidates: Array<{ accountId: string; score: number | null; excludedReason?: string }>;
};
~~~

### AccountPool.recordFailure(input)

代码接口是 recordFailure(accountId, error, options)。该接口只更新账号状态，不负责把错误写给客户端；外部错误映射由兼容网关处理。

### FileSecretStore

`FileSecretStore` 已实现本地 secret 引用读写，默认把 `cookieJarRef` 解析到 `stateDir` 内。它拒绝空 ref、绝对路径、`..` 路径段和 drive-letter 路径；缺失 secret 返回 `null`。详见 [Secret 引用存储](modules/M07-配置密钥/Secret引用存储.md)。

### JsonAccountStore / StoredAccountPool

`JsonAccountStore` 已实现账号元数据 JSON 读写，默认路径为 `<stateDir>/accounts.json`。它会剥离 `cookie`、`cookieHeader`、`token`、`session`、`password`、`authorization`、`apiKey` 等直接 secret 字段，并保留 `cookieJarRef` 等本地 secret 引用。

`StoredAccountPool.load({ store })` 从 store 加载账号；`recordSuccess()` 与 `recordFailure()` 会在内存状态变更后写回 store。`PooledRequestRunner` 会等待这些异步写回完成。详见 [账号元数据持久化](modules/M02-账号池调度/账号元数据持久化.md)。

## 账号注册初始化 API（已实现基础层）

M04 当前实现的是离线可测的 AccountProvisioner 编排层。它不猜测真实 Tabbit 发送验证码、提交验证码、注册/登录或 session 验证 endpoint，而是通过注入的 `mailProvider` 和 `protocolClient` 方法执行外部操作。raw cookie/session 只写入 `secretStore`，账号元数据只保存 `cookieJarRef`。

### extractSessionSecret(result)

从注册/登录结果或导入输入中提取 session secret。读取顺序：

1. `cookieHeader`
2. `cookieJar`，对象或数组会 JSON.stringify
3. `cookie`
4. `session`
5. `sessionToken`
6. `token`

全部缺失时返回 `null`。

### new AccountProvisioner(options)

~~~ts
type AccountProvisionerOptions = {
  accountStore: {
    loadAccounts(): Promise<Account[]>;
    saveAccounts(accounts: Account[]): Promise<Account[]>;
  };
  secretStore: {
    writeSecret(ref: string, value: string): Promise<unknown>;
    readSecret(ref: string): Promise<string | null>;
  };
  mailProvider?: {
    createInbox?: (input: object) => Promise<{ id?: string; address: string }>;
    waitForVerificationCode?: (input: object) => Promise<{ code: string } | string>;
  };
  protocolClient?: {
    sendVerificationCode?: (input: object) => Promise<unknown>;
    submitRegistrationOrLogin?: (input: object) => Promise<object>;
    resumeProvisioning?: (input: object) => Promise<{ account?: Account }>;
    verifySession?: (input: { account: Account; session: string }) => Promise<object>;
  };
  benefitsMaintainer?: { maintainAccount(account: Account): Promise<{ account: Account; changed: boolean; actions?: unknown[] }> };
  now?: () => Date;
  idGenerator?: (input: object) => string;
  secretRefGenerator?: (accountId: string, account: Account, input: object) => string;
};
~~~

`accountStore` 与 `secretStore` 必填，否则抛出 `AccountProvisionerError`。邮箱和协议方法可按场景注入；缺少必要方法时，对应动作返回 `failed` 或 `skipped`，不会硬编码未知 endpoint。

### AccountProvisioner.createAccount(input)

~~~ts
type CreateAccountInput = {
  accountId?: string;
  localPartPrefix?: string;
  domain?: string;
  subdomain?: string;
  timeoutMs?: number;
  cookieJarRef?: string;
};
~~~

固定动作顺序：

1. `createInbox`
2. 保存 `status:"provisioning"` 账号元数据
3. `sendVerificationCode`
4. `waitForVerificationCode`
5. `submitRegistrationOrLogin`
6. `saveSession`
7. 可选 `initializeBenefits`
8. 保存 `status:"active"` 账号元数据

返回 `{ account, changed, actions }`。验证码等待、发送验证码或提交验证码失败时，账号保持 `provisioning` 并写入脱敏 `lastError`。注册响应缺少 session material 时，账号标记为 `suspect`。`secretStore.writeSecret()` 成功之前不会保存 active 账号。

### AccountProvisioner.importSession(input)

导入已有 session/cookie：

~~~ts
type ImportSessionInput = {
  accountId?: string;
  email?: string;
  cookieHeader?: string;
  cookieJar?: unknown;
  cookie?: string;
  session?: string;
  sessionToken?: string;
  token?: string;
  cookieJarRef?: string;
  userId?: string;
  accessTier?: string;
};
~~~

`importSession()` 先提取 session secret，再写入 `secretStore`，最后保存 `active` 账号。缺少 session material 或 secret 写入失败时，返回 failed action，不持久化 active 账号。

### AccountProvisioner.resumeProvisioning(accountId)

读取账号并检查状态。账号不是 `provisioning` 时返回 `skipped`；缺少 `protocolClient.resumeProvisioning` 时也返回 `skipped`。注入 resume hook 后可由真实协议实现继续未完成注册流程。

### AccountProvisioner.verifyAccount(accountId)

读取账号 `cookieJarRef` 指向的 secret 并调用 `protocolClient.verifySession({ account, session })`。成功时账号转 `active`，可更新 `userId` 和 `accessTier`；secret 缺失或 verifier 返回失败时，账号转 `login_expired` 或协议指定状态，并写入脱敏 `lastError`。

## 维护模块 API（已实现基础层）

M05 当前实现的是离线可测的 BenefitsMaintainer 编排层。它不猜测真实 Tabbit 额度、签到、活动权益或重置券 endpoint，而是通过注入的 `protocolClient` 方法执行协议操作。协议方法缺失时，对应动作返回 `skipped`；协议方法抛错时，对应动作返回 `failed`，错误 message 会脱敏，后续动作继续执行。若错误携带明确 category，维护层会把账号转为对应状态并写入脱敏 `lastError`。

### normalizeQuotaState(entry, options)

把协议返回或 fixture 中的额度项归一化为 `QuotaState`。

~~~ts
type NormalizeQuotaOptions = {
  source?: string;
};

type QuotaState = {
  model: string;
  remaining: number | null;
  limit: number | null;
  unit: string;
  resetAt: string | null;
  exhausted: boolean;
  source: string;
};
~~~

规则：

- `model` 取 `entry.model`、`entry.name`，否则为 `"unknown"`。
- `remaining`、`limit` 会转换为有限数字；空值或不可解析值为 `null`。
- `exhausted` 优先使用布尔型 `entry.exhausted`；未提供时，`remaining === 0` 视为耗尽。
- `resetAt` 同时接受 `resetAt` 与 `reset_at`。
- `source` 优先使用 `entry.source`，否则使用 `options.source`，默认 `"unknown"`。

### new BenefitsMaintainer(options)

~~~ts
type BenefitsMaintainerOptions = {
  protocolClient: {
    refreshQuota?: (account: Account) => Promise<{
      quotaState?: unknown[];
      resetCouponCount?: number;
      accessTier?: string;
      source?: string;
    }>;
    dailyCheckin?: (account: Account) => Promise<unknown>;
    claimProIfAvailable?: (account: Account) => Promise<{
      accessTier?: string;
      proClaimed?: boolean;
    }>;
    useResetCoupon?: (account: Account) => Promise<{
      quotaState?: unknown[];
      source?: string;
    }>;
  };
  accountStore?: {
    loadAccounts(): Promise<Account[]>;
    saveAccounts?: (accounts: Account[]) => Promise<Account[]>;
  };
  now?: () => Date;
};
~~~

`protocolClient` 必填且必须是对象，否则抛出 `BenefitsMaintainerError`，错误 code 为 `MISSING_PROTOCOL_CLIENT`。`accountStore` 可选；用于 `maintainAllAccounts()` 无参数模式读取并按需保存账号。`now` 可注入固定时间，便于离线测试每日签到和维护时间戳。

### BenefitsMaintainer.refreshQuota(account)

调用 `protocolClient.refreshQuota(account)` 并返回 `{ account, changed, action }`。

成功时：

- 写入归一化后的 `quotaState`。
- 如果返回 `resetCouponCount`，写回账号元数据。
- 如果返回 `accessTier`，写回账号元数据。
- 任一额度项 `exhausted:true` 时，账号状态转为 `quota_exhausted`。
- `quota_exhausted` 账号发现可用额度时，恢复为 `active`。
- 更新 `lastMaintainedAt`。

未分类失败时保留原账号额度和状态，返回 `action.status:"failed"`。明确 `login_required`、`quota_exhausted`、`rate_limited`、`network_error`、`upstream_error`、`protocol_changed` 或 `forbidden` 错误会更新账号状态与 `lastError`。

### BenefitsMaintainer.dailyCheckin(account)

同一 UTC 日期内已存在 `lastCheckinAt` 时返回 `skipped`。否则调用 `protocolClient.dailyCheckin(account)`；成功后写入 `lastCheckinAt` 和 `lastMaintainedAt`。

真实 Tabbit 签到窗口是否按服务端日期计算仍待协议还原。当前基础层用 UTC 日期提供稳定离线行为；若签到协议抛出 `category:"login_required"`，账号会转为 `login_expired`。

### BenefitsMaintainer.claimProIfAvailable(account)

账号 `accessTier` 已是 `pro` 或 `premium` 时返回 `skipped`；`proClaimed === true` 时也返回 `skipped`。否则调用 `protocolClient.claimProIfAvailable(account)`；成功后写入返回的 `accessTier`，并把 `proClaimed` 设为返回值或默认 `true`。

### BenefitsMaintainer.useResetCoupon(account)

仅当账号状态为 `quota_exhausted` 且 `resetCouponCount > 0` 时调用 `protocolClient.useResetCoupon(account)`。成功后：

- `resetCouponCount` 扣减 1，最低为 0。
- 如果协议返回 `quotaState`，写入归一化结果。
- 账号状态转为 `active`。
- 更新 `lastMaintainedAt`。

账号未耗尽、无券或协议方法缺失时返回 `skipped`。若使用重置券时遇到明确的 `rate_limited` / `network_error` / `upstream_error` 错误，账号会转入 `cooldown`，保留原 `resetCouponCount`。

### BenefitsMaintainer.maintainAccount(account)

按固定顺序执行四个动作，并在单个动作失败后继续后续维护：

1. `refreshQuota`
2. `claimProIfAvailable`
3. `dailyCheckin`
4. `useResetCoupon`

返回：

~~~ts
type MaintenanceAction = {
  name: "refreshQuota" | "claimProIfAvailable" | "dailyCheckin" | "useResetCoupon";
  status: "success" | "skipped" | "failed";
  changed: boolean;
  detail?: string;
  error?: { message: string; code?: string; category?: string };
};

type MaintainAccountResult = {
  account: Account;
  changed: boolean;
  actions: MaintenanceAction[];
};
~~~

### BenefitsMaintainer.maintainAllAccounts(accounts?)

批量维护账号。传入 `accounts` 数组时按顺序执行 `maintainAccount()` 并返回 `{ accounts, changed, results }`，不直接写盘。未传入数组时，必须在构造时提供 `accountStore`；方法会先调用 `loadAccounts()`，再在任一账号 `changed:true` 时调用 `saveAccounts()`。全部动作 skipped/failed 且账号未变化时不会写盘。

已校准的真实接口中，quota usage 查询和每日签到可进入默认维护链，但都需要显式配置对应 path。activity/newbie/placement/reward/lottery records 只读 commerce 探针不执行默认维护动作；activity participate、`useResetCoupon`、抽奖 POST 等其它 M05 side-effect path 仍只作为显式 probe 接入。真实重置券消耗已通过 `useResetCoupon` endpoint/body/result 语义闭环；活动 Pro 成功领取 body、抽奖成功响应和默认调度策略仍待安全 evidence 与回归 fixture 后再接入维护链。

## 观测运维 API（已实现基础层）

M08 当前实现的是离线可测的 observability helper，并通过 `createProtocolPoolGateway()` 默认接入 `/health`。直接使用 `createProtocolPoolServer()` 时，`/health` 仍只返回调用者传入的 `health`。

### summarizeAccounts(accounts)

输入账号数组，输出：

~~~ts
type AccountSummary = {
  total: number;
  active: number;
  unavailable: number;
  byStatus: Record<string, number>;
  health: "ok" | "degraded" | "unhealthy";
  alerts: Array<{ code: string; severity: string; message: string }>;
};
~~~

告警规则：

- 无账号：`no_accounts_configured`。
- 有账号但 active 为 0：`no_active_accounts`。
- 所有账号都是 `quota_exhausted`：`all_accounts_quota_exhausted`。
- 存在 `lastError.category === "protocol_changed"`：`protocol_changed_errors`。

### redactAccountForDisplay(account)

输出账号 ID、状态、accessTier、quotaState、resetCouponCount、failureStreak、冷却和最近维护时间等可展示字段。会脱敏 email 和 lastError.message，并移除 `cookie`、`cookieHeader`、`cookieJar`、`cookieJarRef`、`session`、`sessionToken`、`token` 等 raw secret 字段。

### buildHealthSnapshot(input)

组合账号摘要、modelCache、observedAt 和 uptimeMs。返回对象可直接作为 `/health` 扩展字段：

~~~ts
type HealthSnapshot = {
  status: "ok" | "degraded" | "unhealthy";
  mode: "protocol-pool";
  observedAt: string;
  uptimeMs?: number;
  accounts: {
    total: number;
    active: number;
    unavailable: number;
    byStatus: Record<string, number>;
  };
  alerts: Array<{ code: string; severity: string; message: string }>;
  modelCache?: object;
};
~~~

### createGatewayHealthProvider(input)

从 `accountPool.listAccounts()` 读取账号并调用 `buildHealthSnapshot()`。`createProtocolPoolGateway()` 在 `options.health` 未显式提供时默认使用它，因此 gateway `/health` 会包含账号池摘要，但不包含账号明细。


### buildCalibrationReadinessSnapshot(input)

组合账号、协议配置和本地 protocol probe fixture，输出真实协议校准 readiness。它不触发网络，只判断四类验收：`protocolCalibration`、`codexClaudeE2E`、`toolLoopDecision`、`forbidden403`；其中 `protocolCalibration` 要求 protocol enabled、sendPath、sessionVerifyPath、active account、successful verifySession fixture 和 successful sendMessage fixture。`toolLoopDecision.decision` 来自 `config.compat.toolLoopMode`，默认 `client_executes_tools_first`，也可显式为 `disabled` 或 `local_executes_tools`。返回 `status` 为 `ready`、`partial` 或 `blocked`，并给出 `nextActions`。`tabbit-pool readiness --json` 使用该 helper。

### buildProtocolFixtureAudit(input)

离线审计 protocol probe fixture 覆盖，输出 `{ status, observedAt, counts, coverage, missing, nextActions }`。默认 scope 为 `protocol`，覆盖项为成功 verifySession、成功 sendMessage、流式文本、工具调用或明确不支持原生工具字段的证据、403/forbidden fixture。`scope:"auth"` 会输出 `scope:"auth"`，只审计成功 `sendVerificationCode` 与成功 `submitRegistrationOrLogin` fixture；其中 send coverage 要求响应形状包含 send/delivery/verification/code-send 专属成功字段，单纯 2xx、`ok:true` 或泛 `status/result:"success"` 只计入 `counts.successfulSendVerificationCode`，不让 coverage ready；submit coverage 还要求响应形状包含 `cookieHeader`、`cookieJar`、`cookie`、`session`、`sessionToken` 或 `token` 等可导入 session material 字段，单纯 2xx/`ok:true` 不计为闭环。`counts.successfulSendVerificationCodeWithDeliverySignal` 表示有投递成功信号的发送验证码成功数；`counts.successfulSubmitRegistrationOrLogin` 保留 submit transport success 数，`counts.successfulSubmitRegistrationOrLoginWithSessionMaterial` 表示可导入 session material 的成功数。`scope:"benefits"` 会输出 `scope:"benefits"`，并只审计每日签到、活动 Pro 成功、真实重置券消耗和抽奖成功 fixture 覆盖；真实用券消耗必须来自消费类 operation，且同时有脱敏 `endpointHash/bodyHash/resultHash`、`safe:true`、`sanitized:true`、`rawPayload:false` evidence 和真实消费成功信号；`participateResetCouponActivity` 只作为活动参与 evidence，永不满足真实用券消耗 coverage；`drawLottery` 只有 draw/lottery 专属成功字段或非空奖品/命中记录才满足 lottery coverage，泛 `ok/status/result:"success"` 不计为抽奖成功；`total/success/failed` 也只统计 M05 side-effect 白名单 operation。`scope:"session"` 会输出 `scope:"session"`，并审计成功 `verifySession`、上游 401/login_required 过期 fixture 和自动恢复策略 evidence；本地 `session_missing` 只计数，不当成上游过期。成功/过期 lifecycle coverage ready 但没有显式脱敏 `session_recovery_strategy` / `recoverSession` evidence 时，session scope 仍因 `automated_session_refresh_strategy` 保持 blocked；同时 `manualCookieOperations.blockingMissing` 只列当前手动 cookie 发布目标缺口，`manualCookieOperations.backlogMissing` 保留后续自动恢复缺口，避免把 `automated_session_refresh_strategy` 误当成 manual-cookie 当前版本硬阻塞；恢复 evidence 必须声明安全、已脱敏、无 raw payload 且使用已校准自动 re-auth/refresh 模式。`scope:"upstream"` 会输出 `scope:"upstream"`，只审计 `sendMessage` 真实上游 stream boundary evidence；`real_upstream_error_frame_fixture`、`real_upstream_cancellation_fixture` 和 `real_upstream_backpressure_fixture` 只有在 fixture 同时带显式真实上游 marker 与 stream/SSE/NDJSON 元数据时才 ready，非流式 `protocol_probe` sendMessage 只可满足默认 send readiness，本地 HTTP route、compat handler、unit/fake stream evidence 不计入。`tabbit-pool fixtures audit --json` 使用默认 scope；`tabbit-pool fixtures audit --scope auth --json` 使用 auth scope；`tabbit-pool fixtures audit --scope benefits --json` 使用 benefits scope；`tabbit-pool fixtures audit --scope session --json` 使用 session scope；`tabbit-pool fixtures audit --scope upstream --json` 使用 upstream scope。所有 scope 都只输出聚合结果，不返回 raw payload。

### buildReadinessDoctorReport(input)

组合 `buildCalibrationReadinessSnapshot()` 与 `buildProtocolFixtureAudit()`，输出 `{ status, observedAt, stateDir, protocol, readiness, fixtureAudit, calibrationBacklog, remainingWork, commands }`。`protocol` 只包含布尔配置状态和 `toolLoopMode`，不输出 API key、`TABBIT_POOL_PROTOCOL_REQ_CTX`、cookie、session、`cookieJarRef`、raw request/response 或账号明细。`status` 只有在 readiness 和默认 fixture audit 都 ready 时为 `ready`；任一为 blocked 时为 `blocked`，否则为 `partial`。`calibrationBacklog` 复用 auth、benefits、session 与 upstream scoped audit，用于显示注册/登录、M05 副作用、session lifecycle 和真实上游 stream boundary evidence 缺口，但不改变 top-level `status` 或 core `remainingWork`。`tabbit-pool readiness doctor --json` 使用该 helper。

### formatMaintenanceActionLog(input)

把维护 actions 转换为结构化事件，包含 observedAt、requestId、accountId、action、status、changed、detail 和脱敏 error。错误 message 会额外屏蔽 4 到 8 位裸数字，避免验证码写入日志。

### classifyForbiddenSignal(input)

把 403/forbidden 信号细分为 `risk_control`、`signature_or_protocol`、`session_or_cookie`、`entitlement_or_model`、`unknown_forbidden` 或 `not_forbidden`，返回 `{ kind, severity, accountAction, retryable, recommendation }`。它只根据脱敏后的 status/code/message/body 信号生成建议，不执行网络请求。

### protocolProbeAdvice(error)

把 protocol_changed、login_required、403、rate_limited、network_error 等错误映射为可执行建议。403 会先调用 `classifyForbiddenSignal()`，并在返回值中附加 `forbidden:{ kind, accountAction, retryable }`。`tabbit-pool probe advice` 已暴露该 helper，并支持 `--status`、`--category`、`--code`、`--message`；它不执行真实 probe，只生成建议文本；真实 endpoint 校准应通过 `probe protocol` 生成脱敏 fixture 后补回归。

### createProtocolPoolServer(input)

已实现。签名和路由行为见 [HTTP 路由层](modules/M06-兼容网关/HTTP路由层.md)，当前支持 JSON 路由，并在 OpenAI Chat/Responses 与 Anthropic Messages `stream:true` 成功结果上提供 SSE adapter：有上游 delta 时保留分片，没有时完整文本 fallback。

### createProtocolPoolGateway(options)

已实现。该异步工厂返回 `{ config, store, secretStore, accountPool, runner, compat, server, start, close }`，默认从 `TABBIT_POOL_STATE_DIR` 加载 `<stateDir>/accounts.json`，创建 `FileSecretStore` 读取 `cookieJarRef`，通过 `StoredAccountPool` 持久化请求成功/失败状态，并在未传入 `options.health` 时使用 `createGatewayHealthProvider()` 为 `/health` 提供脱敏账号池摘要。显式协议 env opt-in 后，默认 `modelsProvider` 会调用 `ProtocolTabbitClient.listModels()`；未 opt-in 时 `/v1/models` 仍使用本地 fallback。详见 [启动工厂](modules/M06-兼容网关/启动工厂.md)。

## 运维 CLI（当前实现）

CLI 入口是 package bin `tabbit-pool`，本地开发也可直接运行 `node bin/tabbit-pool.js ...`。CLI 默认只访问本地账号元数据；`maintain` 默认使用空协议客户端，缺失真实协议方法时只输出 skipped actions。显式配置 `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH` 后，默认 maintainer 会读取本地 `cookieJarRef` 并执行真实 `refreshQuota`；显式配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH` 后，会用短 `request_no` 执行已验证 `dailyCheckin`，并在同时配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH` 时先检查 `signedToday`。其余未校准维护动作仍是 skipped。

### tabbit-pool accounts list [--json]

读取账号 store 并输出脱敏账号列表。`--json` 输出 `{ accounts }`；非 JSON 输出 tab 分隔表格。输出不包含 raw cookie/session/token/cookieJarRef。

### tabbit-pool accounts import-session [--id <id>] [--email <email>] [--cookie-header <text> | --session <text> | --cookie-file <path> | --session-file <path>] [--json]

导入本机已登录 Tabbit 的 cookie/session。命令只写本地 stateDir：原始 session 写入 secret store，账号元数据保存 active 状态和 `cookieJarRef`，输出会移除 `cookieJarRef` 并脱敏 email/error。四种 session 来源必须且只能选一个；文件不存在、来源为空或来源冲突返回 exitCode 2。

建议优先使用文件输入，避免 shell history 保存 cookie：

~~~powershell
node bin/tabbit-pool.js accounts import-session --id acct_default --email user@example.test --access-tier pro --cookie-file .\tabbit-cookie.txt --json
~~~

### tabbit-pool accounts probe <id> [--read-only] [--json]

调用 `AccountProvisioner.verifyAccount(accountId)` 验证单个账号，输出 `{ readOnly, changed, wouldChange, account, events, advice }`。默认会按 verifier 结果保存账号状态；加 `--read-only` 时只读取本地账号/secret、调用已配置 verifier 并返回 projected account 状态，不调用 `saveAccounts()`、不写 fixture。`account` 使用 `redactAccountForDisplay()`，`events` 使用 `formatMaintenanceActionLog()`，`advice` 使用失败 action error 或账号 lastError 调用 `protocolProbeAdvice()`。默认 verifier 不配置真实 `verifySession`，所以不会触发 Tabbit 网络；显式配置协议 env 后，`--read-only` 仍可能触发真实 `verifySession`，但不会持久化账号变化。

### tabbit-pool health [--json]

读取账号 store 并调用 `buildHealthSnapshot()`。`--json` 输出完整快照；非 JSON 输出 `status`、active 数和 total 数。


### tabbit-pool readiness [--json]

读取账号 store 和本地 protocol probe fixture，调用 `buildCalibrationReadinessSnapshot()` 输出四项 readiness：真实协议校准、Codex/Claude 端到端、工具 loop 决策和 403 fixture。工具 loop 决策来自 `TABBIT_POOL_TOOL_LOOP_MODE` / `config.compat.toolLoopMode`，只表达运行策略；`local_executes_tools` 仍需要 gateway 宿主注入 executor 才会执行工具，并会应用 `config.compat.localToolLoop` 的 allowlist、轮数、超时和截断策略。协议校准要求 session verify path 与 verifySession/sendMessage 成功 fixture。命令会对带 `ref` 的 fixture 摘要读取脱敏详情，以便识别 `result.error` 中的工具不支持和 403 证据；它不触发 Tabbit 网络，只帮助判断下一步该跑哪个 probe 或人工验收。

JSON 输出包含：

~~~json
{
  "status": "blocked",
  "checks": {
    "protocolCalibration": { "status": "blocked", "missing": [] },
    "codexClaudeE2E": { "status": "blocked", "missing": [] },
    "toolLoopDecision": { "status": "ready", "decision": "client_executes_tools_first" },
    "forbidden403": { "status": "blocked", "missing": [] }
  },
  "nextActions": []
}
~~~

### tabbit-pool readiness doctor [--json]

读取账号 store、本地 protocol probe fixture 和 `readiness.json`，调用 `buildReadinessDoctorReport()` 输出当前状态目录诊断。它不触发 Tabbit 网络、不调用 `accounts probe`、不调用 `probe protocol`、不写 `readiness.json`。

JSON 输出包含：

~~~json
{
  "status": "blocked",
  "stateDir": "E:\\tabbit-live-state",
  "protocol": {
    "enabled": true,
    "baseUrlConfigured": true,
    "sendPathConfigured": true,
    "sessionVerifyPathConfigured": true,
    "compatStripClientTools": true,
    "toolLoopMode": "client_executes_tools_first"
  },
  "readiness": {},
  "fixtureAudit": {},
  "manualCookieMode": {
    "status": "blocked",
    "mode": "manual_reimport_then_probe",
    "releaseTarget": "manual_cookie_operations",
    "expiredSessionAction": "login_expired_then_manual_reimport",
    "missing": [],
    "blockingMissing": [],
    "backlogMissing": [
      "automated_session_refresh_strategy"
    ],
    "automatedSessionRefresh": {
      "status": "backlog",
      "requiredForCurrentRelease": false,
      "missing": [
        "automated_session_refresh_strategy"
      ]
    }
  },
  "calibrationBacklog": {
    "status": "blocked",
    "scopes": {
      "auth": {},
      "benefits": {},
      "session": {},
      "upstream": {}
    },
    "missing": [],
    "nextActions": [],
    "captureCommands": []
  },
  "remainingWork": [],
  "commands": {
    "setStateDir": "$env:TABBIT_POOL_STATE_DIR = \"...\"",
    "readinessDoctor": "node bin\\tabbit-pool.js readiness doctor --json",
    "readiness": "node bin\\tabbit-pool.js readiness --json",
    "fixturesAudit": "node bin\\tabbit-pool.js fixtures audit --json",
    "authFixturesAudit": "node bin\\tabbit-pool.js fixtures audit --scope auth --json",
    "benefitsFixturesAudit": "node bin\\tabbit-pool.js fixtures audit --scope benefits --json",
    "sessionFixturesAudit": "node bin\\tabbit-pool.js fixtures audit --scope session --json",
    "upstreamFixturesAudit": "node bin\\tabbit-pool.js fixtures audit --scope upstream --json",
    "serveGateway": "node bin\\tabbit-pool.js serve --host 127.0.0.1 --port 50124"
  }
}
~~~

输出不会包含 API key、cookie、session、token、`cookieJarRef`、`TABBIT_POOL_PROTOCOL_REQ_CTX` 或 raw fixture payload。它用于把“默认状态目录 blocked”拆解成可执行下一步，或确认外部脱敏 evidence state 是否已满足 readiness/audit。`remainingWork:[]` 只代表基础 gateway/chat gate 没有剩余阻塞；`manualCookieMode.missing` 和 `manualCookieMode.blockingMissing` 只代表当前手动 cookie 发布阻塞项，plain `manual_cookie_mode` 行对应 `release_blocking_missing=<csv>`；`manualCookieMode.backlogMissing` 和 plain `backlog_missing=<csv>` 代表后续增强，`automated_session_refresh_strategy` 可继续出现在这里但不阻塞当前 manual-cookie 发布。若 `calibrationBacklog.status:"blocked"`，注册/登录、M05 副作用、session lifecycle 或真实上游 stream boundary 真实校准仍需继续补 evidence。非 JSON 输出除 backlog 计数外，也会为缺口打印 `capture_command` 行；这些行只包含 `<account-id>` / `<redacted-input.json>` 占位符、固定 reason，以及 template/validate/confirm_validate/probe 四段命令。JSON `captureCommands[*].confirmedValidateCommand` 只对已校准 side-effect operation 有值，等价于 `probe validate --require-confirmed-side-effect`；read-only operation 和 offline-only evidence 缺口为 `null`。所有 sendMessage capture command 会额外带 `requiresReviewedInput:true` 与 `reviewRequirement:"replace_redacted_message_content"`；plain 行对应 `review=replace_redacted_message_content`，表示必须替换 `<redacted-message-content>` 后才能运行真实 `probe protocol`。`validateCommand` 只运行本地 schema 与形状预检，`confirmedValidateCommand` 只离线确认 `confirmSideEffect:true`；二者都不读取账号/secret、不触网、不证明真实 endpoint/body 已校准。真实副作用 probe 仍需先人工审查 input file 与 `confirmSideEffect`。真实用券消耗缺口现在给出 `useResetCoupon` template/validate/confirm_validate/probe 命令，并要求 `TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH` 前置配置；离线 `consumeResetCoupon` 模板仅保留给外部脱敏 evidence 导入。session scope 的当前恢复策略是 `manual_reimport_then_probe`，自动刷新路径仍为 `not_calibrated`；`automated_session_refresh_strategy` 只给出离线 `recoverSession` template/validate 命令且 `probeCommand:null`，不代表刷新 endpoint 已校准。upstream scope 只统计显式真实上游 evidence marker，不把本地 HTTP/compat/fake stream 测试当作真实上游校准。

### tabbit-pool production preflight [--json]

只读生产上线门禁。该命令复用 `readiness doctor` 的账号、fixture 和 readiness state 聚合证据，再额外检查本地网关认证 key 是否仍为默认 `sk-tabbit-local`。当唯一缺口是非默认 gateway key 时，JSON 报告会给出 `commands.initGatewayKey`，指向 `node bin\\tabbit-pool.js production init-key --json`。它不会触发 Tabbit 网络、不会运行 probe、不会写 state，也不会输出 API key、cookie、session、token、`cookieJarRef`、`REQ_CTX` 或 raw fixture payload。

### tabbit-pool production init-key [--json]

显式生产初始化命令。当前配置已指向仓库外生产 stateDir 且 gateway key 仍为默认值时，该命令通过 `FileSecretStore` 写入 `secrets/gateway-api-key.txt`，内容为随机 `sk-tabbit-pool-*` key；若已通过 env 或 state secret 配置非默认 key，则只报告已有来源。stdout 只包含 `changed`、`stateDir`、`secretRef` 和 `apiKeySource`，不打印 key 内容、cookie、session、token 或 raw fixture payload。

JSON 输出形状：

~~~json
{
  "status": "blocked",
  "stateDir": "...",
  "checks": {
    "gatewayApiKey": {
      "status": "blocked",
      "missing": ["non_default_api_key"]
    },
    "readinessDoctor": {
      "status": "ready",
      "missing": []
    },
    "manualCookieMode": {
      "status": "ready",
      "mode": "manual_reimport_then_probe",
      "missing": [],
      "backlogMissing": ["automated_session_refresh_strategy"]
    }
  },
  "missing": ["non_default_api_key"],
  "nextActions": []
}
~~~

`status:"ready"` 只表示当前手动 cookie 运维发布口径可上线：非默认本地 API key、doctor top-level ready、`manualCookieMode.blockingMissing:[]`。它不要求 `automated_session_refresh_strategy` ready，也不代表自动注册、自动短信/Yoda 登录、Pro 领取或抽奖自动化可用。

### tabbit-pool maintain [--json]

逐个调用 `BenefitsMaintainer.maintainAccount(account)`。有任一账号 `changed:true` 时保存账号数组。默认 maintainer 也可通过 `maintainAllAccounts()` 读取绑定的本地 accountStore；未配置协议 path 时不触发网络，返回 refreshQuota、claimProIfAvailable、dailyCheckin、useResetCoupon 四个 skipped action。配置 `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH=/api/commerce/quota/v1/usage` 后，默认 dependencies 会给 maintainer 注入真实 `refreshQuota`，先从 secret store 读取 `cookieJarRef`，再以账号 `userId` 查询 quota usage。配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH=/api/commerce/activity/v1/sign-in` 后，默认 dependencies 会给 maintainer 注入真实 `dailyCheckin`，使用 `daily-sign-in-YYYYMMDD-<12 hex>` 短 `request_no` 和 `confirmSideEffect:true` 发送签到 POST；若同时配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH`，会先查询状态，`signedToday:true` 时不再 POST。`claimProIfAvailable`、`useResetCoupon` 仍不会猜测真实 endpoint。配置只读 activity/newbie/placement/reward/lottery path 不会改变 maintain 动作链。

### tabbit-pool fixtures list [--json]

调用 `FileProtocolFixtureStore.listFixtures()`，只列出 `stateDir/fixtures/protocol-probes/*.json` 中审计允许的 `protocol_probe`、`session_recovery_strategy` 与 `reset_coupon_consumption_evidence` 文件。`--json` 输出 `{ fixtures }`，每个摘要包含 `ref`、`observedAt?`、`operation?`、`status`、`accountId?`、`adviceCategory?`。不触发网络，摘要不包含 evidence/result/raw payload。

### tabbit-pool fixtures audit [--scope protocol|auth|benefits|session|upstream] [--json]

调用 `FileProtocolFixtureStore.listFixtures()`，对带 `ref` 的摘要调用 `readFixture(ref)`，再用 `buildProtocolFixtureAudit()` 离线输出 fixture 覆盖。默认 `protocol` scope 输出成功 verifySession、成功 sendMessage、流式文本、工具调用或明确不支持原生工具字段的证据、403 fixture 覆盖；`auth` scope 输出成功发送验证码，以及成功提交验证码且响应形状含可导入 session material 字段的 fixture 覆盖；`benefits` scope 输出成功每日签到、活动 Pro 成功、真实重置券消耗和抽奖成功 fixture 覆盖；`session` scope 输出成功 `verifySession`、上游 401/login_required 过期证据、`session_missing` 本地缺失计数、`lifecycle`、`manualCookieOperations`、`recoveryStrategy` 和 `automated_session_refresh_strategy` 缺口；其中 `manualCookieOperations.blockingMissing` 是 manual-cookie 当前发布阻塞项，`manualCookieOperations.backlogMissing` 是后续增强项；session plain 输出在 `manual_cookie_mode` 行打印 `release_blocking_missing` 与 `backlog_missing`。session scope 会读取 `verifySession` 与 `recoverSession` 摘要，但只有安全脱敏恢复策略 evidence 能让恢复策略 ready；`upstream` scope 只读取同时具备真实上游 marker 与 stream/SSE/NDJSON 元数据的 `sendMessage` fixture，输出真实上游 error-frame、cancellation 和 backpressure evidence 覆盖。JSON 输出包含 `status`、`counts`、`coverage`、`missing`、`nextActions`；auth/benefits/session/upstream scope 额外包含 `scope`。非 JSON 输出为 tab 分隔摘要。不触发网络，不输出 raw fixture payload；未知 scope 返回 exitCode 2。

### tabbit-pool fixtures show <ref> [--json]

调用 `FileProtocolFixtureStore.readFixture(ref)` 并通过 `sanitizeProtocolProbeFixture()` 输出脱敏 fixture。ref 必须位于 `stateDir/fixtures/protocol-probes/`；缺少 ref、路径穿越或文件不存在返回 exitCode 2。`--json` 和非 JSON 模式都输出格式化 JSON。

### tabbit-pool probe validate [--operation <name>] [--input-json <json> | --input-file <path>] [--require-confirmed-side-effect] [--write-fixture] [--json]

解析并校验 probe input JSON，复用 `probe protocol` 调用 runner 前的 operation-aware schema validation；默认只读，不读取账号、不读取 secret、不读取 fixture、不触发网络、不写文件。JSON 输出为 `{ status:"valid", operation, source, sideEffect, confirmSideEffect?, fields, bodyKeys, attachmentKeys, evidenceKeys?, sendMessageReview?, sessionRecovery?, resetCouponConsumption?, fixtureRef?, fixture? }`，只包含字段存在性、类型、object key 列表和有限枚举 evidence 摘要，不输出 email、验证码、cookie、session、token、raw payload、prompt、hash 值或 body 值。对 `sendMessage`，`sendMessageReview` 只包含 `requiresReviewedInput:true`、`reviewRequirement:"replace_redacted_message_content"`、`redactedMessageContentPresent` 和 `protocolDispatchReady` 四个脱敏字段；`protocolDispatchReady:true` 只表示至少一条消息字符串不是 `<redacted-message-content>` 占位，不等价于内容安全确认、真实协议成功或 readiness ready。建议把 `readiness doctor` 的 `capture_command` 占位符落成真实 input file 后，先运行 `probe validate --operation <name> --input-file <redacted-input.json> --json`；若该 operation 是 auth/M05 副作用并准备写 fixture，再运行 `probe validate --operation <name> --input-file <redacted-input.json> --require-confirmed-side-effect --json`，离线确认 `confirmSideEffect:true` 后再决定是否执行 `probe protocol --write-fixture`。`recoverSession` 必须提供显式 `session_recovery_strategy` evidence，并要求 `safe:true`、`sanitized:true`、`rawPayload:false` 和已校准 re-auth/refresh mode。`consumeResetCoupon` 必须提供显式 `reset_coupon_consumption_evidence`，要求消费类 operation、`status:"success"`、`endpointHash/bodyHash/resultHash` 三个 `sha256:` 脱敏哈希、`safe:true`、`sanitized:true`、`rawPayload:false` 和真实消费成功信号；`already_participated` 等非消费信号会被拒绝。`--write-fixture` 只支持 `recoverSession` 与 `consumeResetCoupon` 这两个离线 evidence operation，写入前复用同一校验，写入时只保留白名单 evidence/result 字段，并丢弃 input 中额外 raw payload；非离线 evidence operation 会在触碰 fixture store 前拒绝。该 strict flag 和离线写入都不证明真实 endpoint/body 已校准。

### tabbit-pool probe protocol --account <id> [--operation <name>] [--input-json <json> | --input-file <path>] [--write-fixture] [--json]

调用 `ProtocolProbeRunner.probeAccount()`。返回 `{ status, account, fixture, advice, fixtureRef? }`。默认 dependencies 不配置 protocol client factory，因此不会触发真实 Tabbit 网络；真实 probe 需要后续注入或配置 protocol client factory。`--write-fixture` 会通过 `FileProtocolFixtureStore` 写入 `stateDir/fixtures/protocol-probes/`。对 auth 或 M05 side-effect 输入，建议先运行 `probe validate` 确认 schema 和 `confirmSideEffect` 形状，再用 `--require-confirmed-side-effect` 做最后的只读确认门禁，最后执行真实 probe。`recoverSession` 和 `consumeResetCoupon` 是离线 evidence operation，该命令会返回 exitCode 2 且不调用 runner。

对需要 `userId` 的只读 commerce probe，runner 会先使用 input 中的 `userId`，其次使用账号元数据中的 `userId`。如果二者都缺失且同一个协议客户端提供 `verifySession()`，runner 会用当前 session 在内存中恢复一次 user id，并只把它用于本次 `refreshQuota`、`listRewardCardRecords`、`listLotteryHitRecords`、`listBenefitCoupons` 或 `getAvailableLotteryChanceCount` 调用；该值不会写回账号 store，也不会在 fixture 或日志中明文输出。若恢复失败，目标 operation 继续按原有协议错误分类返回。

支持的 operation 是 `verifySession`、`sendVerificationCode`、`submitRegistrationOrLogin`、`sendMessage`、`listModels`、`refreshQuota`、`uploadAttachment`、`getLotteryExplorationMe`、`getNewbieExplorationMe`、`getPlacementResources`、`listRewardCardRecords`、`listLotteryHitRecords`、`getDailySignInStatus`、`dailySignIn`、`listBenefitCoupons`、`participateResetCouponActivity`、`participateActivity`、`useResetCoupon`、`getUsageResetCouponSku`、`getAvailableLotteryChanceCount`、`getActiveMainPools`、`listLotteryChanceRecords` 和 `drawLottery`。`--input-json` 与 `--input-file` 可把 JSON object 作为 runner 的 `input` 传入，二者互斥；CLI 在调用 runner 前校验稳定字段：auth send/submit 的 `email` 或 `mobile` 至少一个必须非空，submit 的 `code` 必须非空，auth `uuid` 如出现必须是 64 位字母数字，auth `body` 如出现必须是 object，auth `confirmSideEffect` 如出现必须是 boolean，`sendMessage.model` 如出现必须是非空字符串，`sendMessage.messages` 如出现必须是非空数组，`listModels.force` 如出现必须是 boolean，`refreshQuota.userId` 如出现必须是非空字符串，`getNewbieExplorationMe.viewMode` 如出现必须是四个合法值之一，`includeCompletions` / `includeRewards` 如出现必须是 boolean，`getPlacementResources.placementCode` 和 `clientVersion` 如出现必须是非空字符串，记录查询和权益券查询的 `userId` 必须是非空字符串且 `offset` / `limit` 必须是非负整数，side-effect probe 的 `confirmSideEffect` 如出现必须是 boolean，`sceneCodes` 必须是非空字符串数组，`requestNo` 必须是非空字符串且不超过 64 字符，`activityId` 必须是非空字符串，`body` 必须是 object，`useResetCoupon` 的券码/类型字段必须非空，`uploadAttachment.attachment` 如出现必须是 object，且 `filename`、`mimeType`、`data` 如出现必须是非空字符串。未知字段会原样保留用于真实协议校准。非法 JSON、缺少值、文件不存在、非 object 输入或 schema 非法返回 exitCode 2，stderr 不回显原始 payload，且不调用 runner。fixture 固定包含 `version:1`、`kind:"protocol_probe"`、`observedAt`、`operation`、`status` 和 `advice`；有账号时包含脱敏 `account`，有请求/响应/错误时包含脱敏 `input`、`result`、`error`。Auth operation 缺少 `confirmSideEffect:true` 会在读取 secret 或调用协议客户端前失败，并可使用没有 session secret 的 provisioning 账号；其它 POST 型 side-effect operation 缺少 `confirmSideEffect:true` 会在协议客户端触网前失败；`attachment.data` 会在 fixture 中屏蔽，避免保存探针附件 payload。常见结果包括 `failed/session_missing`、`skipped/protocol_missing`、`failed/account_not_found`、`failed/invalid_request` 和 `success`。

### tabbit-pool probe template [--operation <name>] [--json]

输出 protocol probe input 模板，便于保存为 JSON 文件后传给 `probe protocol --input-file`；`recoverSession` 和 `consumeResetCoupon` 模板例外，只用于 `probe validate` 和后续脱敏 fixture 准备。支持 `verifySession`（默认，输出 `{}`）、`sendVerificationCode`、`submitRegistrationOrLogin`、`sendMessage`（输出 `tabbit/priority` 与一条 `<redacted-message-content>` user message 占位）、`listModels`（输出 `{ "force": true }`）、`refreshQuota`（输出 `{}`，默认用账号 `userId`）、`getLotteryExplorationMe`（输出 `{}`）、`getNewbieExplorationMe`（输出 `activity_page` 和 include flags）、`getPlacementResources`（输出 `{ "placementCode": "home.input_below" }`）、`listRewardCardRecords`（输出 offset/limit）、`listLotteryHitRecords`（输出 offset/limit）、`getDailySignInStatus`、`dailySignIn`、`listBenefitCoupons`、`participateResetCouponActivity`、`participateActivity`、`useResetCoupon`、`getUsageResetCouponSku`、`getAvailableLotteryChanceCount`、`getActiveMainPools`、`listLotteryChanceRecords`、`drawLottery`、`recoverSession`（输出安全 `session_recovery_strategy` evidence 骨架）、`consumeResetCoupon`（输出安全 `reset_coupon_consumption_evidence` endpoint/body/result hash 骨架）和 `uploadAttachment`（输出 `probe.txt` 文本附件占位 payload）。副作用模板默认 `confirmSideEffect:false`，auth 模板也默认 `confirmSideEffect:false`，并使用已逆向的 proxy OAuth 手机号 body 形状和占位 `mobile/code/uuid`。该命令不读取账号、不触发网络、不输出 secret；不支持的 operation 返回 exitCode 2。`probe validate --operation sendMessage` 可接受 `<redacted-message-content>` 进行形状预检，并通过 `sendMessageReview` 提示是否仍含占位；但 `probe protocol --operation sendMessage` 会要求替换为已审查的非占位消息内容。

### tabbit-pool probe advice [--category <category>] [--status <status>] [--code <code>] [--message <text>] [--json]

调用 `protocolProbeAdvice()`，根据 category/status/code/message 生成建议，不读取账号、不触发网络。`--message` 用于粘贴脱敏或待脱敏的错误摘要；输出不会回显原始 message，并会对 403 附加 `forbidden.kind`。

### runProtocolPoolCli(argv, options)

可测试 dispatcher，返回 `{ exitCode }`。常用注入项：`accountStore`、`benefitsMaintainer`、`accountVerifier`、`protocolFixtureStore`、`protocolProbeRunner`、`stdout`、`stderr`、`now`、`startedAt`。未知命令返回 2；带 `exitCode` 的 fixture store 错误会按错误指定退出码返回；其他运行时错误返回 1，stderr 中的错误消息会脱敏。

### createProtocolPoolCliDependencies(options)

创建默认 CLI 依赖：`loadConfig()`、`JsonAccountStore({ stateDir })`、`FileSecretStore({ stateDir })`、`FileProtocolFixtureStore({ stateDir })`、`ProtocolProbeRunner`、安全默认 `BenefitsMaintainer({ protocolClient: {}, accountStore })`、lazy `AccountProvisioner` verifier、`now` 和 `startedAt`。未设置 `TABBIT_POOL_PROTOCOL_*` 时保持离线安全；设置 `TABBIT_POOL_PROTOCOL_ENABLED=true` 或显式协议 path 后，会创建 `ProtocolTabbitClient`，供 `accounts probe` 和 `probe protocol` 使用，fixture 输出仍会脱敏。

## YYDS Mail API 摘要

YYDS Mail 官方摘要： https://vip.215.im/v1/llms.txt 。

认证方式：

~~~text
X-API-Key: AC-xxxxxx
Authorization: Bearer <temp-token-or-jwt>
~~~

公共临时邮箱相关端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /v1/accounts | 创建临时 inbox |
| POST | /v1/accounts/wildcard | 强制 wildcard child-domain 创建 |
| POST | /v1/token | 刷新当前 temp inbox token |
| GET | /v1/accounts/me | 获取当前 temp inbox profile |
| GET | /v1/accounts/{id} | 获取 temp inbox 详情 |
| DELETE | /v1/accounts/{id} | 停用临时 inbox |
| GET | /v1/messages?address=xxx | 列出 inbox 邮件 |
| POST | /v1/messages/mark-read | 标记当前邮箱已读 |
| GET | /v1/messages/{id}?address=xxx | 获取邮件详情 |
| PATCH | /v1/messages/{id}?address=xxx | 更新邮件状态 |
| DELETE | /v1/messages/{id}?address=xxx | 删除邮件 |
| GET | /v1/sources/{id}?address=xxx | 获取原始邮件源码 JSON 包装 |

文档中真实 key 不落盘。

## 相关文档

- [M02-账号元数据持久化](modules/M02-账号池调度/账号元数据持久化.md)
- [Secret 引用存储](modules/M07-配置密钥/Secret引用存储.md)
- [M06-兼容网关](modules/M06-兼容网关/_M06-兼容网关.md)
- [OpenAI Chat/Responses 处理器](modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md)
- [Anthropic Messages 处理器](modules/M06-兼容网关/Anthropic-Messages处理器.md)
- [HTTP 路由层](modules/M06-兼容网关/HTTP路由层.md)
- [启动工厂](modules/M06-兼容网关/启动工厂.md)
- [实现接口参考](09-实现接口参考.md)
