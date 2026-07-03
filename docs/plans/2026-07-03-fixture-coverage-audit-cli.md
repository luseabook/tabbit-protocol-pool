# Fixture Coverage Audit CLI

日期：2026-07-03

## 背景

真实 Tabbit send endpoint、签名和请求体校准前，需要知道本地是否已经保存了足够的脱敏 protocol probe fixture。只看 `fixtures list` 很容易漏掉流式、工具调用或 403 风控样本，readiness 又只关心核心上线阻塞项，不能细分所有协议证据。

## 范围

- 新增 `buildProtocolFixtureAudit({ fixtures, now })`。
- 新增 `tabbit-pool fixtures audit [--json]`。
- 离线统计四类证据：成功 `sendMessage`、流式文本、工具调用或明确不支持原生工具字段的证据、403/forbidden fixture。
- 输出 `status`、`counts`、`coverage`、`missing` 和 `nextActions`。
- 输出不包含 raw request、raw response、邮箱、cookie、session、token 或验证码。

## 非范围

- 不触发真实 Tabbit 网络。
- 不自动执行 `probe protocol`。
- 不把 fixture 审计结果写入 `readiness.json`。
- 不替代 Codex / Claude Code 真实端到端验收标记。

## TDD 清单

1. 构造覆盖齐全的 fixture 数组，断言 `buildProtocolFixtureAudit()` 返回 `status:"ready"`。
2. 构造明确不支持原生工具字段的 tools 探针 fixture，断言它可作为工具覆盖证据。
3. 构造缺少工具证据的 fixture 数组，断言 `missing` 只包含 `tool_call_fixture`。
4. 构造含 raw email、token、验证码的错误 fixture，断言审计输出不泄露原文。
5. 注入 fake `protocolFixtureStore.listFixtures()` 与 `readFixture(ref)`，断言 `tabbit-pool fixtures audit --json` 会读取脱敏详情识别流式/工具证据，但输出仍只有聚合结果。

## 验收

- `node --test test/observability.test.js test/ops-cli.test.js test/smoke.test.js` 通过。
- `npm test` 通过。
- README、M08、API/测试/接口参考、真实协议校准文档同步。
