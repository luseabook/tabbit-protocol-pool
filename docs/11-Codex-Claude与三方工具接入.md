# 11-Codex Claude 与三方工具接入

本文回答三个产品问题：`tabbit-pool` CLI 是什么、是否需要前端管理后台、能否像官方 API 一样被 Codex / Claude Code / 三方 SDK 用于代码编写。

## 结论

| 问题 | 当前结论 |
|---|---|
| “CLI 完善”是什么意思？ | 已做的是本地运维 + gateway 启动 CLI `tabbit-pool`，用于看账号、健康检查、维护、协议探针、脱敏 fixture、记录 Codex/Claude 端到端验收标记、本地 gateway smoke 验收，以及 `serve/start` 启动 protocol-pool 本地兼容网关；它不是前端管理后台，也不是新的聊天客户端。根项目仍保留 `tabbit2api start/login/probe` CLI，负责现有浏览器桥接网关。 |
| 需不需要前端管理后台？ | MVP 不需要。账号池、风控排障和协议校准优先用 CLI + `/health` + fixture，原因是更容易脱敏、测试和本地化。等真实 endpoint 稳定、账号规模增大后，再把 M08 能力包装成 Web 管理后台。 |
| 支不支持工具调用？ | 兼容层已经支持官方工具字段透传、工具调用输出映射、工具结果回合输入保真，以及 buffered/async 工具调用流式事件。网关本地自动执行工具已有受控 opt-in loop：默认不启用、不内置工具，只有 `TABBIT_POOL_TOOL_LOOP_MODE=local_executes_tools` 且宿主注入 executor 时才执行，并受工具 allowlist、最大轮数、单工具超时和结果截断约束。 |
| 能不能像官方 API 一样给 Codex / Claude Code / 三方工具写代码？ | 对外 API 形状正在按官方 OpenAI / Anthropic 兼容口径实现：本地 `base_url + api_key + model` 可接入。真实 Tabbit 文本 send endpoint、签名、Codex/Claude 文本端到端和 403 fixture 已校准；真实上游原生工具字段已确认不支持。默认策略仍是 `client_executes_tools_first`，让 Codex/Claude 或 SDK 自己执行工具；需要网关代执行时必须显式开启本地 loop、注入 executor，并配置 guardrails。 |

## 两个 CLI 的边界

### 根项目 `tabbit2api`

根项目 CLI 已存在，用于现有 Tabbit2API 网关：

~~~powershell
npm start
# 或
node src/cli.js start
# 或安装后
tabbit2api start
~~~

它面向用户启动本地 OpenAI / Anthropic 兼容服务，默认本地参数沿用：

~~~text
OpenAI base_url: http://127.0.0.1:50124/v1
Anthropic base_url: http://127.0.0.1:50124
API key: sk-tabbit-local
model: tabbit/priority
~~~

示例配置在根项目：

- `../examples/codex/config.toml.example`
- `../examples/claude-code/env.powershell.example`
- `../examples/claude-code/env.sh.example`

### 子项目 `tabbit-pool`

`tabbit-protocol-pool` 新增的 CLI 是运维入口，也可以启动 protocol-pool gateway：

~~~powershell
node bin/tabbit-pool.js health --json
node bin/tabbit-pool.js accounts list --json
node bin/tabbit-pool.js accounts import-session --id acct_default --cookie-file .\tabbit-cookie.txt --json
node bin/tabbit-pool.js accounts probe acct_default --json
node bin/tabbit-pool.js readiness --json
node bin/tabbit-pool.js readiness mark --codex-verified --json
node bin/tabbit-pool.js readiness mark --claude-verified --json
node bin/tabbit-pool.js serve --host 127.0.0.1 --port 50124
node bin/tabbit-pool.js smoke gateway --json
node bin/tabbit-pool.js probe template --operation sendMessage --json
node bin/tabbit-pool.js probe protocol --account acct_default --operation sendMessage --input-file .\probe-input.json --write-fixture --json
node bin/tabbit-pool.js fixtures list --json
~~~

它的设计目标是：

1. 查看本地账号池状态，不泄露 cookie/session/token。
2. 导入已登录账号 session，把 raw cookie/session 只写入本地 secret store。
3. 给 403、登录失效、额度耗尽、协议变更生成排障建议。
4. 对真实 Tabbit endpoint 做脱敏协议探针，沉淀 fixture 回归。
5. 记录 Codex / Claude Code 真实端到端验收标记，供 readiness 预检读取。
6. 启动本地 protocol-pool gateway，给 Codex / Claude Code / SDK 提供兼容 base URL。
7. 在接入 Codex / Claude Code 前，用 `smoke gateway` 验证本地兼容 API 路由形状。
8. 给后续前端管理后台提供稳定的底层能力。

它不是“又做了一个聊天 CLI”，也不是让用户手工在命令行聊天。`serve/start` 只启动本地 HTTP 兼容服务，输出 `openaiBaseUrl` / `anthropicBaseUrl`，不输出本地 API key、cookie 或 session。

## Codex 接入形态

Codex 走 OpenAI Responses 兼容接口时，核心配置是：

~~~toml
model_provider = "tabbit2api"
model = "tabbit/priority"
disable_response_storage = true

[model_providers.tabbit2api]
name = "Tabbit2API Local"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:50124/v1"
env_key = "TABBIT_API_KEY"
~~~

本地环境变量使用占位 key：

~~~powershell
$env:TABBIT_API_KEY = "sk-tabbit-local"
~~~

真实 `/api/v1/chat/completion` 已确认不支持原生工具字段。做 Codex 文本链路验收时，可在启动 protocol-pool gateway 前显式设置：

~~~powershell
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
~~~

该开关只剥离已知客户端内置协作工具以完成文本请求，不代表真实 Tabbit 上游已经支持工具调用。

本地工具代执行的最小 guardrail 配置示例：

~~~powershell
$env:TABBIT_POOL_TOOL_LOOP_MODE = "local_executes_tools"
$env:TABBIT_POOL_LOCAL_TOOL_ALLOWLIST = "lookup_repo,read_note"
$env:TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS = "4"
$env:TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS = "5000"
$env:TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS = "16000"
~~~

这些变量只约束宿主注入的本地 executor；项目不会自动提供 shell、web、js、fetch 等工具。

### Codex 工具调用链路

Codex 或兼容 SDK 发送：

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- Responses `function_call` / `function_call_output`

当前 protocol-pool 会：

1. 保留这些字段到 runner 输入。
2. 写入 `ProtocolTabbitClient.sendMessage()` signed body。
3. 把上游 `tool_calls` / `tool_use` 归一化为内部 `tool_use`。
4. 对 OpenAI Responses 输出 `function_call` item。
5. 对 Responses SSE 输出 `response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done`。
6. 客户端执行工具后再提交 `function_call_output` 时，compat 层保留结构并继续传给协议请求体。

上述工具保真是兼容层契约；真实 `/api/v1/chat/completion` 分支仍会拒绝未校准的原生工具字段。需要真实工具调用时，应先补充成功 fixture，再决定是本地 loop 还是上游原生工具协议。

## Claude Code 接入形态

Claude Code 走 Anthropic Messages 兼容接口时，核心环境变量是：

~~~powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:50124"
$env:ANTHROPIC_API_KEY = "sk-tabbit-local"
$env:ANTHROPIC_MODEL = "tabbit/priority"
claude
~~~

如果只做真实协议文本链路验收，并且客户端自动附带空工具数组或内置协作工具，可配合 `TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS=true` 启动 gateway。该开关默认关闭。

POSIX shell：

~~~bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:50124"
export ANTHROPIC_API_KEY="sk-tabbit-local"
export ANTHROPIC_MODEL="tabbit/priority"
claude
~~~

### Claude 工具调用链路

Claude Code 或 Anthropic SDK 发送：

- `tools`
- `tool_choice`
- `tool_use`
- `tool_result`

当前 protocol-pool 会：

1. 保留 `tools` / `tool_choice`。
2. 保留请求消息里的 `tool_use` / `tool_result` content block。
3. 把内部 `tool_use` 输出为 Anthropic `content:[{ type:"tool_use" }]`。
4. 在 Anthropic SSE 中输出 `content_block_start`、`content_block_delta` with `input_json_delta`、`content_block_stop`，并在工具调用时使用 `stop_reason:"tool_use"`。

## 三方 SDK 接入形态

任何支持自定义 OpenAI / Anthropic base URL 的工具，原则上都按下面接入：

| 客户端类型 | base URL | Header | 模型 |
|---|---|---|---|
| OpenAI Chat/Responses SDK | `http://127.0.0.1:50124/v1` | `Authorization: Bearer sk-tabbit-local` | `tabbit/priority` |
| Anthropic Messages SDK | `http://127.0.0.1:50124` | `x-api-key: sk-tabbit-local` 或兼容 Authorization | `tabbit/priority` |

示例 OpenAI Chat 请求：

~~~json
{
  "model": "tabbit/priority",
  "stream": true,
  "messages": [
    { "role": "user", "content": "读一下 package.json 并告诉我脚本" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    }
  ]
}
~~~

## 能力状态矩阵

| 能力 | OpenAI Chat | OpenAI Responses | Anthropic Messages | 状态 |
|---|---|---|---|---|
| 文本非流式 | 支持 | 支持 | 支持 | 已实现 foundation |
| 文本流式 SSE | 支持 | 支持 | 支持 | 已实现 buffered + async flush |
| 工具定义透传 | `tools/tool_choice/parallel_tool_calls` | `tools/tool_choice/parallel_tool_calls` | `tools/tool_choice` | 已实现 |
| 工具调用输出 JSON | `message.tool_calls` | `output[].function_call` | `content[].tool_use` | 已实现 |
| 工具调用流式输出 | `delta.tool_calls[]` | function_call item events | `tool_use` + `input_json_delta` | 已实现有限 fallback + async delta |
| 工具结果回合输入 | `role:"tool"` + `tool_call_id` | `function_call_output` | `tool_result` | 已实现保真 |
| 网关本地执行工具 loop | opt-in wrapper | opt-in wrapper | opt-in wrapper | 已实现受控 `local_executes_tools`；默认 `client_executes_tools_first`，不内置工具 |
| 真实 Tabbit 文本 endpoint | 支持 | 支持 | 支持 | 已校准 `/api/v1/chat/completion`，经兼容层转接 |
| 真实 Tabbit 工具语义 | 不支持原生工具字段 | 不支持原生工具字段 | 不支持原生工具字段 | 已有 unsupported evidence；如需自动执行需做本地 loop |

## 下一步验收

要把“像官方 API 一样写代码”从文本链路推进到完整工具自动化，需要按顺序完成：

1. 用 `tabbit-pool smoke gateway --json` 先确认本地 gateway 的 `/health`、`/v1/models`、Chat、Responses、Anthropic Messages 路由可用。
2. 用 `tabbit-pool probe protocol --operation sendMessage --write-fixture` 采集或刷新脱敏真实 send fixture，确认 `Default` 模型仍可用。
3. Codex / Claude Code 文本端到端已通过时，用 `readiness mark --codex-verified --claude-verified` 保持本地 readiness 标记。
4. 保留“上游不支持原生工具字段”的 fixture，以及 403/forbidden fixture。
5. 若目标客户端已经负责执行工具，继续保持 `TABBIT_POOL_TOOL_LOOP_MODE=client_executes_tools_first` 和官方协议结构。
6. 若目标客户端只转发工具定义但不执行工具，使用受控本地 loop：设置 `TABBIT_POOL_TOOL_LOOP_MODE=local_executes_tools`，并由宿主注入 `executeLocalToolUse` 或 `localToolExecutor.execute`；工具白名单、超时、审计和具体工具实现由宿主负责，网关默认不内置 shell/web/js/fetch。

## 相关文档

- [API 文档](07-API文档.md)
- [流式 SSE 链路](10-流式SSE链路.md)
- [M06 兼容网关](modules/M06-兼容网关/_M06-兼容网关.md)
- [M08 观测运维](modules/M08-观测运维/_M08-观测运维.md)
- [账号风控与 403 排障](12-账号风控与403排障.md)
- [真实协议校准与端到端验收](13-真实协议校准与端到端验收.md)
