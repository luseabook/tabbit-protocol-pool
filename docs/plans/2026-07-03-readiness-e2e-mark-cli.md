# Readiness E2E Mark CLI

日期：2026-07-03

## 背景

真实 Codex / Claude Code 端到端验收需要人工在本机真实账号环境执行。只写文档容易丢失状态，`tabbit-pool readiness --json` 也无法判断这两项是否已经完成。

## 范围

- 新增 `tabbit-pool readiness mark --codex-verified`。
- 新增 `tabbit-pool readiness mark --claude-verified`。
- 将标记持久化到 `TABBIT_POOL_STATE_DIR/readiness.json`。
- `tabbit-pool readiness --json` 读取本地标记并传给 `buildCalibrationReadinessSnapshot()`。

## 非范围

- 不自动调用 Codex / Claude Code。
- 不保存 prompt、代码 diff、模型输出、cookie、session 或 API key。
- 不把人工标记等同于真实 Tabbit send endpoint 已校准；它只覆盖 Codex/Claude 客户端验收状态。

## TDD 清单

1. `readiness --json` 读取注入的 readiness state，Codex/Claude 都已标记时 `codexClaudeE2E.status=ready`。
2. `readiness mark --codex-verified --claude-verified --json` 读取旧 state、写入两项 `verified:true` 和 ISO `verifiedAt`。
3. 缺少 verification flag 时 exitCode=2，不写 state。
4. `verifiedAt` 是可读 ISO 时间戳，不走验证码数字脱敏。

## 验收

- `node --test test/ops-cli.test.js` 通过。
- `npm test` 通过。
- README、M08、API/测试/接口参考、Codex/Claude 接入与真实验收文档同步。
