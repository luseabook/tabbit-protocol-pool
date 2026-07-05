# Claude Code beta 工具字段 502 修复计划

## 背景

线上 `tabbit-pool` 与 Nginx 都处于运行状态。`/admin`、`/health`、`/v1/models` 可访问，说明域名和源站不是整体宕机。

日志定位到失败集中在：

- `POST /v1/messages?beta=true`
- User-Agent: `claude-cli/2.1.191`
- HTTP 状态：`502`

服务端本机复现显示，带 Anthropic `tools/tool_choice` 的请求会返回：

- code: `TOOL_FIELDS_UNSUPPORTED`
- message: `Native tool fields are not calibrated for the restored Tabbit chat completion protocol.`

根因是 Claude Code 新版 beta 请求默认携带客户端工具定义，而恢复版 Tabbit `/api/v1/chat/completion` 协议尚未校准原生工具字段。当前网关把这个兼容性缺口映射成 502，导致 Claude Code 认为上游失败。

## 目标

在不宣称 Tabbit 原生工具调用已支持的前提下，让 Claude Code beta 的普通文本请求不再因为客户端工具字段直接 502。

## 非目标

- 不启用本地工具执行器。
- 不伪造工具调用能力。
- 不改变账号池、模型目录或后台 UI。
- 不打印或记录真实请求正文、API key、cookie、session。

## 实现步骤

1. TDD：新增 Anthropic 兼容层测试，证明 `stripClientTools:true` 会剥离 Claude Code/Anthropic 客户端工具字段，并且不会留下 `toolChoice`。
2. 实现：调整 `src/anthropic-compat.js` 的工具字段剥离策略，使该开关对 Claude Code beta 工具请求有效。
3. 错误分类：把上游 `temporarily unavailable` 文案归类为可重试上游错误，避免误记为不可重试 `unknown`。
4. 配置：线上 systemd 设置 `TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS=true`，让生产网关采用降级兼容策略。
5. 验证：运行相关单测、全量测试、diff 检查、线上本机复现和公网 smoke。

## 风险

- 开启剥离后，Claude Code 不会从 Tabbit 上游拿到原生 tool_use；这是当前协议能力的真实限制。
- 该修复目标是避免工具字段导致请求入口失败，不能等同于 Claude Code 工具链完整可用。

## 2026-07-05 线上复查

用户在 16:06-16:14 继续复现 `POST /v1/messages?beta=true` 失败。服务器复查结论：

- `tabbit-pool` 与 Nginx 均为 active，Node 监听 `127.0.0.1:50124`。
- systemd 已启用 `TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS=true`。
- Nginx access log 对 Claude Code beta 请求仍记录 `502 191`，说明源站实际返回的是网关的 191 字节 Anthropic 错误包；Cloudflare 在客户端侧把源站 502 改写为 `origin_bad_gateway` JSON。
- 服务器本机用有效请求 Key、无工具字段请求 `127.0.0.1:50124/v1/messages?beta=true` 返回 `502 153`，错误为 `upstream_error` / `AI service temporarily unavailable, please try again later`，与 191 字节工具字段错误不同。

新的根因假设：兼容开关已经生效，但 Claude Code beta 2.1.191 的工具名集合比当前白名单更宽，或 `tool_choice` 指向已剥离工具时仍被透传，导致恢复版 Tabbit 协议继续触发 `TOOL_FIELDS_UNSUPPORTED`。

追加实现步骤：

1. 增加 Anthropic 回归测试，覆盖 `TodoRead`、MCP resource 管理工具、snake_case Web/Search 类工具和指向被剥离工具的 `tool_choice`。
2. 扩展工具名归一化，支持 snake_case 与 PascalCase 的同义形态。
3. 当所有工具都被剥离，或 `tool_choice` 指向被剥离工具时，不再把 `toolChoice` 传给 runner。

## 2026-07-05 上游临时不可用处理

工具字段问题修复并部署后，带 beta 管理工具的本机 origin smoke 不再返回 191 字节 `TOOL_FIELDS_UNSUPPORTED`；返回变为 153 字节 `upstream_error`，文案为 `AI service temporarily unavailable, please try again later`。进一步只读验证：

- `accounts probe acct_default --read-only --json` 的 `verifySession` 成功。
- 额度接口 `/api/commerce/quota/v1/usage` 返回未耗尽。
- OpenAI Chat 和 Anthropic Messages 文本请求均返回同一上游临时不可用错误。
- 临时 `chatSessionId`、显式 `messageId`、`parallelGroupId` 和浏览器常见 headers 均未改变 send 阶段错误。

因此剩余问题不是后台登录、Nginx、请求 Key、模型列表前缀、客户端工具字段、Cookie 过期或额度耗尽，而是 Tabbit send 阶段上游返回临时不可用 SSE error frame。网关应把 `upstream_error` 暴露为 `503`，避免 Cloudflare 把源站 `502` 改写成误导性的 `origin_bad_gateway` JSON；同时中文 `AI 服务暂时不可用，请稍后重试` 也应归类为可重试 `upstream_error`。

## 2026-07-05 继续验证记录

本窗口从 `fde0b1dfcd8a4d80d8b4f40cdfe3482ddd2c4ccc` 继续，先复查工作区和 readiness 状态。当前默认 local stateDir 的 `readiness doctor --json` 仍是 `blocked`，因为本地默认状态缺少协议开关、send/session verify path、成功/过期 session fixture、send fixture、E2E 标记、403、streaming text 和 tool fixture。该结果是外部 sanitized state/evidence 缺口，不应误判为本次代码回归。

已补充一个 paid-model routing 边界回归：当 catalog metadata 明确给出非付费访问信号时，runner 优先相信 catalog，不再被 `Claude-Opus-*` 名称兜底覆盖；名称兜底仅在 catalog metadata 不可用或不完整时启用。

本地验证：

- `node --test test\pooled-request-runner.test.js test\model-access.test.js`：15 pass。
- `node --test test\anthropic-compat.test.js`：14 pass。
- `node --test test\protocol-tabbit-client.test.js`：64 pass。
- `node --test test\protocol-pool-gateway.test.js`：26 pass。
- `node --test test\http-server.test.js`：39 pass。
- `npm test`：462 pass。
- `git diff --check`：通过，仅有 Git LF/CRLF 工作区提示。
- 受保护路径 `tabbit-cookie.txt`、`output/`、`.agents/`、`.codex/`、`.omx/`：无改动。
- tracked diff added-line credential-shape scan：2983 added lines，0 suspicious hits。
- untracked file credential-shape scan：8 files / 359 lines，0 suspicious hits。

## 2026-07-05 cooldown health 复查

用户反馈浏览器内同一账号可以使用 Opus 后，继续区分账号权益、浏览器上下文和网关健康状态。公网 `/health` 在 2026-07-05T09:23Z 返回 `status:"unhealthy"`、`active:0`、`cooldown:2`、`no_active_accounts`，与用户稍早提供的 `active:2` 不一致。公开模型目录 `https://web.tabbit.ai/proxy/v1/model_config/models?a=0&scene=chat` 可访问，`Claude-Opus-4.8` 当前仍存在且 `model_access_type:"premium_only"`，没有发现隐藏 selected model id 字段。

代码复查发现一个独立健康统计缺陷：账号池选路会在 `cooldownUntil` 过期后重新允许 `status:"cooldown"` 账号参与请求，但 `summarizeAccounts()` 只按持久化 status 统计 active，导致 `/health` 在短冷却结束后仍可能持续误报 `active:0`。已新增回归测试并修复：`buildHealthSnapshot()` 传入当前 `observedAt`，`summarizeAccounts({ now })` 会把已过期 cooldown 账号视为当前可服务，同时保留 `byStatus.cooldown` 作为持久状态计数。

本修复只解决健康检查误报和排障信号问题；它不改变 Tabbit 上游对 `Claude-Opus-4.8` 的 entitlement 判定。后续 chat-session 差异已由 `2026-07-05-chat-session-auto-create.md` 归因并接入 `/newtab` 自动建会话；线上仍需用服务器本机脱敏命令确认当前生产账号是否已经恢复 active，以及 `MODEL_ENTITLEMENT_REQUIRED` 是否在部署后映射为 403。
