# Gateway Smoke CLI

日期：2026-07-03

## 背景

Codex / Claude Code 真实端到端验收前，需要先确认本地 protocol-pool gateway 的兼容路由可用。手工 curl 容易漏掉 Responses 或 Anthropic Messages，失败时也不容易形成稳定结果结构。

## 范围

- 新增 `tabbit-pool smoke gateway`。
- 支持 `--base-url <url>`、`--api-key <key>`、`--model <model>`、`--json`。
- 按固定顺序检查 `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。
- 失败时停止后续步骤，输出 `failedStep`，exitCode=1。
- 输出不包含 API key、cookie、session 或 token。

## 非范围

- 不自动启动 gateway；先由 `tabbit-pool serve/start` 启动。
- 不保存 smoke 结果到 readiness state；Codex / Claude Code 人工验收仍使用 `readiness mark`。
- 不绕过本地 API key 认证。
- 不模拟 Codex / Claude Code 的工具执行 loop；只验证本地 HTTP 兼容路由形状。

## TDD 清单

1. 注入 fake `fetch`，成功响应 5 个路由。
2. 断言请求顺序固定：health、models、Chat、Responses、Anthropic Messages。
3. 断言 OpenAI 路由使用 `Authorization: Bearer ...`，Anthropic 路由使用 `x-api-key`。
4. 断言成功 JSON 为 `status:"ok"`，且不泄露 API key。
5. 模拟 models 401，断言输出 `status:"failed"`、`failedStep:"models"`、exitCode=1，且不泄露 API key。

## 验收

- `node --test test/ops-cli.test.js` 通过。
- `npm test` 通过。
- README、M08、API/测试/接口参考、Codex/Claude 接入与真实验收文档同步。
