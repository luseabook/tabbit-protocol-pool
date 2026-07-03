# Protocol-pool serve CLI foundation

日期：2026-07-03

## 背景

Codex / Claude Code 端到端验收需要一个明确的 protocol-pool gateway 启动入口。此前已有 `createProtocolPoolGateway()` 启动工厂，但用户只能通过测试脚本或根项目 `tabbit2api start` 间接验证，容易把浏览器桥接网关与纯协议网关混在一起。

## 范围

- 新增 `tabbit-pool serve` 与等价别名 `tabbit-pool start`。
- 支持 `--host <host>`、`--port <port>`、`--json`。
- 默认使用 `TABBIT_POOL_HOST` / `TABBIT_POOL_PORT` / `TABBIT_POOL_STATE_DIR` 等配置。
- 输出 OpenAI / Anthropic base URL，不输出 `TABBIT_POOL_API_KEY`、cookie、session 或 token。
- 收到 shutdown hook 后调用 `gateway.close()`。

## 非范围

- 不新增交互式聊天 CLI。
- 不默认绑定公网地址。
- 不绕过本地 API key 认证。
- 不猜真实 Tabbit send endpoint；真实网络仍依赖显式 `TABBIT_POOL_PROTOCOL_*` 配置和 fixture 校准。

## TDD 清单

1. 注入 fake `gatewayFactory` 和 `waitForShutdown`，调用 `serve --host 127.0.0.2 --port 50125 --json`。
2. 断言 `gateway.start({ host, port })` 收到 CLI 覆盖值。
3. 断言 stdout JSON 包含 `status/listening`、`openaiBaseUrl`、`anthropicBaseUrl`，且不包含示例 key。
4. 断言 shutdown hook 返回后调用 `gateway.close()`。
5. 非法 `--port` 返回 exitCode 2，并且不创建 gateway。

## 实现说明

- `runProtocolPoolCli()` 保持可测试 dispatcher 形态，不在测试中打开真实端口。
- 默认 `waitForShutdown` 监听 `SIGINT` / `SIGTERM`；测试可注入立即 resolve 的 hook。
- `0.0.0.0` / `::` 绑定时，展示用 base URL 归一为 `127.0.0.1`，避免把示例变成公网部署建议。

## 验收

- `node --test test/ops-cli.test.js` 通过。
- `npm test` 通过。
- 相关 README、M08、M06 启动工厂、API/测试/接口参考和端到端验收文档已同步。
