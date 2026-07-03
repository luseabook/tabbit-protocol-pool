# Tabbit Protocol Pool

这是一个独立新项目的文档起点，用于探索和实现：

- Tabbit Web 全协议调用，不依赖浏览器 UI 作为运行时通道。
- 多账号 session/cookie 池轮询。
- YYDS Mail/215 邮箱 API 接码。
- 账号注册初始化、活动权益领取、每日签到、额度/重置券维护。
- 对外保持 OpenAI / Anthropic 兼容网关能力。

当前阶段：**基础实现与文档契约并行推进**。已落地配置/脱敏、YYDS Mail 客户端、M01 协议客户端、M02 账号池、账号 JSON 元数据持久化、文件型 secret 引用存储、pooled request runner、受控 `LocalToolLoopRunner`、AccountProvisioner 离线注册/导入编排层、BenefitsMaintainer 离线单账号/批量权益编排层与明确协议错误状态转移、M08 观测运维基础层、M08 本地运维 CLI foundation、protocol probe fixture foundation、protocol probe input payload/schema validation CLI、protocol probe template CLI、可配置 session verify protocol client、显式 `TABBIT_POOL_PROTOCOL_*` 环境变量 wiring、显式 attachment upload path 的 `uploadAttachment()` 协议骨架与真实 COS 三步上传、显式 quota usage path 的 `refreshQuota()` 真实额度查询、显式 activity/newbie/placement/reward/lottery read-only path 的 commerce 状态/资源探针、显式 daily sign-in / reset coupon activity participate / lottery draw 等 M05 side-effect probe 方法、gateway 协议模型目录 provider、protocol fixture list/show CLI、OpenAI Chat/Responses 纯 handler、Anthropic Messages 纯 handler、OpenAI/Anthropic 官方工具字段到 runner/旧显式 sendPath signed body 的透传通道、基础 tool call 输出映射（OpenAI Chat `tool_calls`、OpenAI Responses `function_call`、Anthropic `tool_use`，以及 Chat SSE tool_calls delta）、OpenAI `tool` message / Responses `function_call_output` / Anthropic `tool_result` 等工具回合输入保真、OpenAI buffered stream `tool_calls` 与 Anthropic buffered stream `tool_use` 聚合解析、async 上游 `tool_call_delta` 转换、Responses `function_call` SSE item events、原生 HTTP server JSON 路由骨架、OpenAI Chat/Responses 与 Anthropic Messages `stream:true` SSE adapter（有上游 delta 时保留分片、无 delta 时完整文本 fallback）、HTTP async SSE flush foundation、HTTP async SSE 错误帧、`ProtocolTabbitClient` 的 SSE/NDJSON 响应聚合、delta 保留、response.body async delta producer、async stream consumer cancellation 与 stream error frame 基础分类传播、真实 `/api/v1/chat/completion` 文本发送请求体、已上传附件 `references[].metadata.file_id` 映射、完整配置 upload + complete path 时 raw/base64 附件自动上传后发送、浏览器校准签名头、真实 `display_name` 模型目录解析、真实 `GET /api/v0/user/base-info` session verify 校准，以及 protocol-pool gateway 启动工厂、`tabbit-pool serve/start` 本地网关启动命令；注册/登录协议和真实上游私有工具语义仍需按文档契约继续校准。默认 `maintain` 仍不触网；显式配置 quota usage path 后可自动刷新额度，显式配置每日签到 path 后可自动执行已验证签到；活动 Pro、抽奖和真实用券仍只允许显式 probe 或注入实现。

## 文档入口

- [项目说明书](docs/00-项目说明书.md)
- [需求文档](docs/01-需求文档.md)
- [架构文档](docs/02-架构文档.md)
- [模块索引](docs/03-索引.md)
- [开发追踪](docs/04-开发追踪.md)
- [术语表](docs/05-术语表.md)
- [数据字典](docs/06-数据字典.md)
- [API 文档](docs/07-API文档.md)
- [测试用例](docs/08-测试用例.md)
- [实现接口参考](docs/09-实现接口参考.md)
- [流式 SSE 链路](docs/10-流式SSE链路.md)
- [Codex/Claude 与三方工具接入](docs/11-Codex-Claude与三方工具接入.md)
- [账号风控与 403 排障](docs/12-账号风控与403排障.md)
- [真实协议校准与端到端验收](docs/13-真实协议校准与端到端验收.md)

## 关键模块

- [M01-Tabbit协议客户端](docs/modules/M01-Tabbit协议客户端/_M01-Tabbit协议客户端.md)
- [M02-账号池调度](docs/modules/M02-账号池调度/_M02-账号池调度.md)
  - [账号元数据持久化](docs/modules/M02-账号池调度/账号元数据持久化.md)
- [M03-YYDS邮箱接码](docs/modules/M03-YYDS邮箱接码/_M03-YYDS邮箱接码.md)
- [M04-账号注册初始化](docs/modules/M04-账号注册初始化/_M04-账号注册初始化.md)
- [M05-权益额度维护](docs/modules/M05-权益额度维护/_M05-权益额度维护.md)
- [M06-兼容网关](docs/modules/M06-兼容网关/_M06-兼容网关.md)
  - [OpenAI Chat/Responses 处理器](docs/modules/M06-兼容网关/OpenAI-Chat-Responses处理器.md)
  - [Anthropic Messages 处理器](docs/modules/M06-兼容网关/Anthropic-Messages处理器.md)
  - [HTTP 路由层](docs/modules/M06-兼容网关/HTTP路由层.md)
  - [启动工厂](docs/modules/M06-兼容网关/启动工厂.md)
- [M07-配置密钥](docs/modules/M07-配置密钥/_M07-配置密钥.md)
  - [Secret 引用存储](docs/modules/M07-配置密钥/Secret引用存储.md)
- [M08-观测运维](docs/modules/M08-观测运维/_M08-观测运维.md)

## 当前实现

- `src/config.js`：本地配置、环境变量覆盖、状态目录推导，以及显式协议 endpoint opt-in 配置，包含 send、attachment upload、attachment complete upload、quota usage、activity lottery、newbie exploration、placement resources、reward card records、lottery hit records、daily sign-in、benefit coupon list、activity participate、usage reset coupon sku、lottery chance/pool/draw、model catalog、model catalog scene、默认 chat session、req ctx、session verify path、默认关闭的 compat client-tool stripping 开关与工具 loop 决策模式。
- `src/redact.js`：API key、cookie、token、邮箱、验证码脱敏。
- `src/yyds-mail-provider.js`：YYDS Mail 创建 inbox、读取邮件、提取验证码、限流错误处理。
- `src/protocol-tabbit-client.js`：sign-key 获取/缓存、浏览器校准签名头（`x-signature` UUID、`x-nonce` HMAC-SHA256）、真实模型目录归一化、`/api/v1/chat/completion` 文本发送请求体、旧显式 sendPath 骨架兼容、旧显式 sendPath 下官方工具字段与工具回合消息写入 signed body 的兼容通道、OpenAI `tool_calls` 与 Anthropic `tool_use` 响应归一化、buffered SSE/NDJSON 中 OpenAI `tool_calls` delta 与 Anthropic `input_json_delta` 工具输入聚合、显式 `attachmentUploadPath` 的附件上传请求骨架、显式 `attachmentUploadPath + attachmentCompleteUploadPath` 的真实 COS 三步上传、显式 `quotaUsagePath` 的真实 `GET /api/commerce/quota/v1/usage?user_id=...` 额度查询、显式只读 `getLotteryExplorationMe()` / `getNewbieExplorationMe()` / `getPlacementResources()` / `listRewardCardRecords()` / `listLotteryHitRecords()` commerce 状态/资源查询、显式 `getDailySignInStatus()` / `listBenefitCoupons()` / `getUsageResetCouponSku()` / lottery chance/pool/records 查询，以及受 `confirmSideEffect:true` 保护的 `dailySignIn()` / `participateResetCouponActivity()` / `participateActivity()` / `drawLottery()` 副作用探针、已上传附件到真实 `references` 的映射、raw/base64 附件自动上传后发送、`metadatas.html_content` 默认补齐、SSE/NDJSON buffered 响应聚合解析与数组 `streamDeltas` 保留、可读 response.body 的 async iterable `streamDeltas` producer、async OpenAI/Anthropic 工具 delta producer、async stream consumer cancellation、stream error frame 基础分类传播、已校准 `GET /api/v0/user/base-info` session verifier（`user_info.id` 归一化为 `userId`）、协议错误分类。真实 `/api/v1/chat/completion` 分支会拒绝未校准的原生工具字段；未配置完整 COS 上传链时，缺少 file id/path 的附件仍会返回 `unsupported_feature/ATTACHMENT_REFERENCE_REQUIRED`。
- `src/account-pool.js`：账号状态归一化、账号选择、失败状态转移、fallback 决策。
- `src/account-store.js`：账号 JSON 元数据 store、直接 secret 字段剥离、`StoredAccountPool` 成功/失败状态持久化。
- `src/secret-store.js`：文件型 secret 引用存储，约束 `cookieJarRef` 等相对路径位于 stateDir 内，并支持 gateway 运行时 hydrate。
- `src/pooled-request-runner.js`：把账号池选择、协议发送、成功/失败记录和账号 fallback 串成一次请求闭环，并等待异步状态持久化完成；官方工具字段会原样传给协议客户端。
- `src/local-tool-loop-runner.js`：受控本地工具 loop wrapper。默认 `client_executes_tools_first` 保持既有透传；`disabled` 会剥离工具字段；显式 `local_executes_tools` 且注入 `executeToolUse` / `localToolExecutor.execute` 时，会把工具定义转成文本约束、剥离原生工具字段后调用协议客户端、解析 JSON tool_use、执行注入工具并把 tool result 带入下一轮。默认不内置 shell/web/js 工具。
- `src/account-provisioner.js`：M04 账号注册初始化基础编排层，通过注入邮箱与协议操作执行 inbox 创建、验证码发送/等待、注册/登录提交、session 保存、账号导入、resume hook 和 session 验证；raw cookie/session 只写入 secret store。真实注册/登录 endpoint 尚未还原时，可通过 `tabbit-pool accounts import-session` 临时导入已登录账号 cookie。
- `src/benefits-maintainer.js`：M05 权益额度维护基础编排层，通过注入协议操作执行额度刷新、每日签到、活动 Pro 领取和重置券使用，支持批量维护账号数组或绑定的 accountStore，并能把明确的 login_required、rate_limited、network_error、upstream_error、protocol_changed、forbidden、quota_exhausted 维护错误转为账号状态；只执行已注入的协议操作，不硬编码未知 Tabbit 接口路径。默认 CLI 仅在显式配置 `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH` 时注入真实 `refreshQuota`，在显式配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH` 时注入已验证的 `dailyCheckin`；活动 Pro、抽奖和真实重置券消耗仍不会自动执行。
- `src/openai-compat.js`：纯函数式 OpenAI Chat/Responses 兼容处理，返回 `{ status, body }`，透传非空 `tools`、`tool_choice`、`parallel_tool_calls`，没有真实工具定义时忽略 `tool_choice:auto/none` 与孤立 `parallel_tool_calls` 这类 no-op 工具选项，保留 Chat `assistant.tool_calls`、`role:"tool"` / `tool_call_id`，并保留 Responses `function_call` / `function_call_output` input item，避免工具回合被压成文本；可在显式 compat 配置下剥离已知 Codex 客户端内置协作工具用于文本链路验收；把内部 `tool_use` block 映射为 Chat `message.tool_calls` 与 Responses `function_call` output item，并在 `stream:true` 时把数组或 async iterable `streamDeltas` 作为非公开 `stream.deltas` 元数据交给 HTTP 路由。
- `src/anthropic-compat.js`：纯函数式 Anthropic Messages 兼容处理，返回 Anthropic message/error JSON，透传非空 `tools`、`tool_choice`，没有真实工具定义时忽略 `tool_choice:{type:"auto"}` 这类 no-op 工具选项，保留请求中的 `tool_use` / `tool_result` content block 和响应中的内部 `tool_use` content block，并在 `stream:true` 时把数组或 async iterable `streamDeltas` 作为非公开 `stream.deltas` 元数据交给 HTTP 路由。
- `src/http-server.js`：原生 `node:http` 路由层，提供 `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，并处理本地 API key、坏 JSON、404，以及 OpenAI Chat/Responses/Anthropic Messages `stream:true` 成功结果的 SSE framing；handler 提供数组 `stream.deltas` 时逐 delta 生成有限 SSE，提供 async iterable `stream.deltas` 时以 chunked SSE 逐帧 flush，否则回退为完整文本 delta；Chat Completion JSON 中存在 `tool_calls` 时会输出 OpenAI `tool_calls` delta，Responses output 中存在 `function_call` 时会输出 `response.output_item.*` 与 `response.function_call_arguments.*` events；async `tool_call_delta` 会分别转换为 Chat `delta.tool_calls[]`、Responses function_call item events 与 Anthropic `tool_use` / `input_json_delta` events；若 async iterator 在 SSE headers 已发送后抛错，路由层按兼容协议输出 SSE error frame，而不是再尝试改写 JSON；若下游客户端断开，路由层会请求 async iterator `return()`，避免继续消费可取消的上游 delta。
- `src/protocol-pool-gateway.js`：启动工厂，组合 config、JsonAccountStore、StoredAccountPool、PooledRequestRunner、LocalToolLoopRunner、OpenAICompat 与 HTTP server；显式配置 `TABBIT_POOL_PROTOCOL_SEND_PATH` / `TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID` / `TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH` / `TABBIT_POOL_PROTOCOL_ATTACHMENT_COMPLETE_UPLOAD_PATH` / `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH` / 只读 commerce path / M05 side-effect probe path 时默认协议客户端会使用对应路径和默认会话，secret-hydrating factory 会在 `sendMessage()`、`verifySession()`、`uploadAttachment()`、`refreshQuota()`、只读 commerce 查询和显式 side-effect probe 前读取 `cookieJarRef`，显式协议 env opt-in 时 `/v1/models` 可复用 `ProtocolTabbitClient.listModels()`，显式 `TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS=true` 时会把剥离策略传给 OpenAI/Anthropic handler；`TABBIT_POOL_TOOL_LOOP_MODE=local_executes_tools` 只在调用方注入本地工具 executor 时执行工具，否则返回明确 invalid_request，返回可 `start()` / `close()` 的 gateway。
- `src/observability.js`：M08 观测运维基础层，生成账号池健康摘要、脱敏账号展示、维护 action log、协议探针建议、403 细分、真实协议校准 readiness 快照和 protocol fixture 覆盖审计，并默认接入 gateway `/health`。
- `src/ops-cli.js`：M08 本地运维 CLI dispatcher，提供 `accounts list`、`accounts import-session`、`accounts probe`、`health`、`readiness`、`readiness mark`、`serve/start`、`smoke gateway`、`maintain`、`fixtures list`、`fixtures audit`、`fixtures show`、`probe advice`、`probe template`、`probe protocol`，并支持 `readiness mark --codex-verified/--claude-verified` 把人工端到端验收结果写入本地 `readiness.json`、`serve/start --host/--port` 启动本地 OpenAI/Anthropic 兼容 gateway、`smoke gateway` 验证 `/health`、`/v1/models`、OpenAI Chat/Responses 与 Anthropic Messages 路由、`fixtures audit` 离线审计成功 verifySession、成功 sendMessage、流式文本、工具调用或明确不支持工具字段的证据、403 fixture 覆盖，`probe template` 生成 verifySession/sendMessage/listModels/refreshQuota/uploadAttachment/只读 commerce 查询和 M05 side-effect probe payload，副作用模板默认 `confirmSideEffect:false`，`probe protocol --input-json/--input-file` 传入探针 payload，且在调用 runner 前校验 sendMessage/listModels/refreshQuota/uploadAttachment/getNewbieExplorationMe/getPlacementResources/记录查询/side-effect probe 的稳定字段（`placementCode` 必须非空，`requestNo` 必须非空且不超过 64 字符）；所有命令支持依赖注入，默认无网络维护，只有显式 `TABBIT_POOL_PROTOCOL_*` opt-in 后才会使用真实协议客户端。配置 `TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH` 后，`maintain` 会把 `refreshQuota` 接到真实 quota usage 查询；配置 `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH` 后，`maintain` 会用短 `request_no` 执行已验证每日签到，并在配置 status path 时先查 `signedToday`。
- `src/protocol-probe.js`：protocol probe fixture foundation，生成脱敏协议探针 fixture，支持 verifySession/sendMessage/listModels/refreshQuota/uploadAttachment、已校准只读 commerce GET 查询和 M05 side-effect probe 注入协议操作、写入 `stateDir/fixtures/protocol-probes/`，并提供本地 fixture list/read 安全边界；uploadAttachment fixture 会屏蔽 `attachment.data`，避免把探针附件 payload 写入仓库。
- `bin/tabbit-pool.js`：`tabbit-pool` 可执行入口，只负责把命令行参数转给 `runProtocolPoolCli()`。
- `docs/09-实现接口参考.md`：记录当前 `src/index.js` 导出的实现接口、默认值和错误分类。
- `docs/modules/M06-兼容网关/HTTP路由层.md`：记录原生 HTTP server 的路由、认证、JSON 解析、OpenAI/Anthropic SSE adapter 和测试契约。
- `test/`：离线单元测试，不依赖真实 Tabbit 或 YYDS 网络。

## 密钥约定

任何真实密钥、账号密码、cookie、session token 都不写入仓库。运行时通过环境变量或本地加密状态注入：

~~~powershell
$env:YYDS_MAIL_API_KEY="AC-..."
~~~

示例中的 `AC-...`、`sk-tabbit-local` 都是占位符，不代表真实服务密钥。
