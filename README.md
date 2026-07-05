# Tabbit Protocol Pool

`tabbit-protocol-pool` 是一个独立的 Tabbit 协议账号池与 OpenAI/Anthropic 兼容网关项目。当前仓库工作目录是 `E:\tabbit-protocol-pool`；本文档中的本地命令默认都从该目录执行。当前推荐的仓库外生产 stateDir 是 `E:\tabbit-live-state`。

当前可用目标是 **手动 cookie 运维可用版本**：用户手动在 Tabbit 注册/登录，通过 CLI 导入 cookie/session；运行中由 `verifySession` 识别有效会话和 401/login_required 失效状态，账号失效后标记为 `login_expired`，再由用户手动重新导入 cookie/session。当前版本不承诺自动注册、Yoda/短信自动化、自动刷新登录态、Pro 领取或抽奖自动化。

## 当前代码状态

当前代码已具备：

- 本地 OpenAI Chat/Responses 与 Anthropic Messages 兼容 HTTP 网关。
- Tabbit 协议客户端：签名头、模型目录、`sendMessage`、`verifySession`、附件上传、额度查询、只读活动查询，以及显式确认保护的副作用探针。
- 账号池：JSON 账号元数据、文件型 secret 引用、账号选择、失败分类、fallback、手动 session 导入和只读账号探测。
- 本地 CLI：`accounts`、`readiness`、`serve/start`、`smoke gateway`、`maintain`、`fixtures`、`probe`。
- 脱敏 fixture 与 readiness/audit：默认 stateDir 没有真实脱敏 fixture 时保持 blocked；外部脱敏 stateDir 可证明 manual-cookie 当前版本 ready。

仍是 backlog 的校准项：

- `automated_session_refresh_strategy`
- Yoda/短信自动注册/登录成功证据
- Pro 活动领取、抽奖成功证据
- 真实上游 SSE error-frame/cancel/backpressure evidence
- Tabbit 原生工具字段语义或最终产品化本地 tool loop 策略

## 项目结构

```text
bin/                 CLI 入口，tabbit-pool
src/                 运行时代码和公开模块
test/                node:test 测试
scripts/             测试运行脚本
docs/                项目文档、模块文档、计划和验收记录
```

关键源码：

- `src/protocol-tabbit-client.js`：Tabbit 协议请求、签名、发送、验证、附件和活动探针。
- `src/protocol-pool-gateway.js`：组合配置、账号池、协议客户端和 HTTP server。
- `src/ops-cli.js`：本地运维 CLI。
- `src/observability.js`：health、readiness doctor、fixture audit 和诊断输出。
- `src/protocol-probe.js`：脱敏 fixture 生成、读取和探针 runner。

## 安装与测试

要求 Node.js 18+。

```powershell
cd E:\tabbit-protocol-pool
npm install
npm test
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

项目当前没有构建步骤；`npm test` 会运行 `scripts/run-tests.mjs` 下的完整测试集合。

## 基础配置

常用环境变量：

```powershell
$env:TABBIT_POOL_HOST = "127.0.0.1"
$env:TABBIT_POOL_PORT = "50124"
$env:TABBIT_POOL_API_KEY = "<local-api-key>"
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
```

`TABBIT_POOL_STATE_DIR` 必须放在仓库外，用于账号元数据、secret 引用和脱敏 fixture。不要把真实 cookie、session、JWT、API key、raw payload、prompt 或真实用户数据写入仓库。

未显式设置 `TABBIT_POOL_STATE_DIR` 时，配置会尝试自动发现仓库外生产 stateDir，优先查找仓库相邻的 `..\tabbit-live-state`，例如 `E:\tabbit-live-state`。当前支持的安全 marker 是候选目录同时包含 `accounts.json`、`readiness.json`、`fixtures/protocol-probes` 和 `secrets`；发现成功后会自动启用已校准的公共 Tabbit 协议默认值。若 `<stateDir>\secrets\gateway-api-key.txt` 存在且不是默认 key，网关会把它作为 `TABBIT_POOL_API_KEY` 的仓库外来源；环境变量仍然优先。旧的 `E:\tabbit2api\output\tabbit-live-state` 不再作为默认自动发现路径；如确需使用 legacy 状态目录，必须显式设置 `TABBIT_POOL_STATE_DIR`。

`TABBIT_POOL_PROTOCOL_ENABLED=true` 会启用已校准的公共 Tabbit Web 默认值：`https://web.tabbit.ai`、`/chat/sign-key`、`/proxy/v1/model_config/models`、`/api/v1/chat/completion`、`/api/v0/user/base-info` 和当前浏览器 `REQ_CTX` 默认值。私密账号状态、cookie/session、脱敏 fixture 与 E2E 标记仍必须来自服务器上的 `stateDir`。

## 手动 Cookie 运维流程

用户先在 Tabbit 浏览器或网页中手动完成注册/登录，然后导入 cookie/session：

```powershell
node bin\tabbit-pool.js accounts import-session --id acct_default --email user@example.test --cookie-file <redacted-cookie-file> --json
```

只读检查当前账号状态：

```powershell
node bin\tabbit-pool.js accounts probe acct_default --read-only --json
```

如果 `verifySession` 返回 401/login_required，账号会被投影或标记为 `login_expired`。重新登录 Tabbit 后，再次执行 `accounts import-session` 更新本地 session。

## 本地运行网关

启动本地兼容网关：

```powershell
node bin\tabbit-pool.js serve --host 127.0.0.1 --port 50124
```

`start` 是 `serve` 的别名：

```powershell
node bin\tabbit-pool.js start --host 127.0.0.1 --port 50124 --json
```

可用路由：

- `GET /health`
- `GET /admin`
- `GET /admin/api/status`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

`/admin` 是内置 Web 运维后台。页面本身不包含密钥；浏览器调用 `/admin/api/status` 时需要输入同一个 gateway API key。后台第一版只显示聚合状态、stateDir、API key 来源、协议开关和账号池摘要，不展示或返回真实 API key、cookie、session、token、`cookieJarRef`、prompt 或 raw fixture payload。生产环境建议仍只监听 `127.0.0.1`，通过内网/VPN/HTTPS 反向代理访问 `/admin`。

本地冒烟检查：

```powershell
node bin\tabbit-pool.js smoke gateway --base-url http://127.0.0.1:50124 --api-key <local-api-key> --model <model> --json
```

## 部署方式

推荐部署为一个长期运行的 Node 进程，并把 stateDir、日志和密钥放在仓库外。

最小部署步骤：

```powershell
cd E:\tabbit-protocol-pool
npm install --omit=dev
$env:TABBIT_POOL_API_KEY = "<strong-api-key>"
node bin\tabbit-pool.js production preflight --json
node bin\tabbit-pool.js serve --host 127.0.0.1 --port 50124
```

如果生产 stateDir 不在自动发现位置，仍需设置 `$env:TABBIT_POOL_STATE_DIR`。如果不想用环境变量放 gateway key，可在确认 stateDir 指向仓库外生产状态后运行一次：

```powershell
node bin\tabbit-pool.js production init-key --json
```

该命令会在 `<stateDir>\secrets\gateway-api-key.txt` 生成非默认 key，输出只包含 `secretRef` 和状态，不会打印 key 内容。之后默认 `loadConfig()` 会从该文件读取 gateway key，`production preflight` 会把它识别为 `state_secret` 来源。
当 `production preflight --json` 只缺 `non_default_api_key` 时，JSON 会返回 `commands.initGatewayKey`，可直接作为初始化命令执行。

生产建议：

- 使用 PM2、NSSM、Windows Task Scheduler、systemd 或容器平台托管 Node 进程。
- 只在内网或本机监听；需要公网访问时放在 HTTPS 反向代理后面。
- 必须设置强 `TABBIT_POOL_API_KEY`，不要使用默认 `sk-tabbit-local` 暴露服务。
- Web 后台共用 gateway API key；反向代理应限制 `/admin` 只给可信网络或已登录用户访问。
- `stateDir`、cookie 文件、fixture store、日志和浏览器 profile 不要放进仓库。
- 部署后先运行 `production preflight`、`readiness doctor` 和 `smoke gateway`，确认聚合状态再接入客户端。

## 运维与审计命令

```powershell
node bin\tabbit-pool.js health --json
node bin\tabbit-pool.js production preflight --json
node bin\tabbit-pool.js production init-key --json
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

`manualCookieMode.status:"ready"` 且 `manualCookieMode.blockingMissing:[]` 表示当前手动 cookie 运维目标满足。`calibrationBacklog.status:"blocked"` 可以同时存在，表示后续自动刷新、注册/登录、副作用或真实上游 stream boundary 仍需校准。

生成安全探针模板：

```powershell
node bin\tabbit-pool.js probe template --operation sendMessage --json
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence error_frame --json
node bin\tabbit-pool.js probe validate --operation sendMessage --input-file <redacted-input.json> --json
```

真实 probe 前必须审查 redacted input；只保存 sanitizer 输出，不保存 raw prompt、payload、stream、cookie 或 token。

## 文档入口

- [项目说明书](docs/00-项目说明书.md)
- [需求文档](docs/01-需求文档.md)
- [架构文档](docs/02-架构文档.md)
- [索引](docs/03-索引.md)
- [开发追踪](docs/04-开发追踪.md)
- [API 文档](docs/07-API文档.md)
- [测试用例](docs/08-测试用例.md)
- [真实协议校准与端到端验收](docs/13-真实协议校准与端到端验收.md)
- [M08 观测运维](docs/modules/M08-观测运维/_M08-观测运维.md)

## 安全边界

不要提交或打印：

- 真实 cookie、session、JWT、API key、Bearer token
- raw payload、prompt、stream 原文
- 真实账号、用户数据或验证码

不要修改或提交：

- `tabbit-cookie.txt`
- `output/`
- 浏览器 profile
- 本地 state fixture
- `.agents/`
- `.codex/`
- `.omx/`
