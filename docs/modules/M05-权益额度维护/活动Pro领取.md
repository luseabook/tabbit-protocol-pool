# 活动 Pro 领取

## 目标

在活动期为新账号或未领取账号自动领取 Pro/高级模型权益。

## 待还原点

- 领取接口是否幂等。
- 已领取、活动过期、账号不符合条件时的错误码。
- 领取后模型目录或用户权益字段的刷新方式。

## 已校准只读状态

当前已还原的是真实只读状态探针，不是领取动作：

~~~text
GET /api/commerce/activity/v1/lottery/me
GET /api/commerce/activity/v1/newbie-exploration/me?view_mode=<mode>&include_completions=true&include_rewards=true
~~~

`newbie-exploration` 的 `view_mode` 合法值为 `event_gate`、`float_collapsed`、`float_expanded`、`activity_page`。两条 GET 都只依赖已登录 Cookie、`accept: application/json`、`unique-uuid` 和可选 `x-req-ctx`，不使用 `x-signature` / `x-nonce`。它们可通过 `probe protocol --operation getLotteryExplorationMe` 和 `probe protocol --operation getNewbieExplorationMe` 生成脱敏 evidence；默认维护链不会因为这些 path 存在就自动领取 Pro。

## 已校准 activity participate POST

生产 commerce activity client 中的通用参加活动接口已还原为：

~~~text
POST /api/commerce/activity/v1/participate
~~~

该调用点使用已登录 Cookie、`trace-id` 和 `Content-Type: application/json`，body 由调用方透传，未观察到 `x-signature` / `x-nonce`。`ProtocolTabbitClient.participateActivity({ body, confirmSideEffect:true })` 仅作为显式 probe 暴露；当前还没有安全 evidence 能把某个 body 与“活动 Pro 成功领取”严格绑定，也没有已领取/过期/不符合条件的稳定错误码。因此默认 `claimProIfAvailable()` 不会调用该 POST。

`tabbit-pool fixtures audit --scope benefits --json` 会只读统计 `participateActivity` 成功 evidence。只有 fixture 同时满足 `operation:"participateActivity"`、`status:"success"` 且包含明确 participation/activity/claim/pro success 信号时，`successful_pro_activity_fixture` 才会 ready；单纯 2xx、`ok:true`、泛 `status/result:"success"` 或失败 fixture 不会让默认维护链开启 Pro 领取。

`tabbit-pool readiness doctor --json` 的 `calibrationBacklog.captureCommands` 会为 `successful_pro_activity_fixture` 输出 `prerequisites` / `prerequisitesStatus`；plain `capture_command` 行会显示 `prereq=TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH:configured|missing`。该字段只说明显式 activity participate path 是否已配置，不输出真实 path，也不代表 Pro 领取 body、安全副作用边界或成功响应语义已经闭环。真实 capture 仍必须先用 `probe template` 生成脱敏 input、人工确认 `confirmSideEffect:true`，再用 `probe validate --require-confirmed-side-effect` 离线预检，最后只保留 sanitized fixture 供 `fixtures audit --scope benefits` 判定。

## 流程

1. 查询当前 accessTier。
2. 若已是 pro/premium，跳过。
3. 查询活动可领取状态。
4. 调用领取接口。
5. 刷新 accessTier 和模型目录。

## 测试

- [x] 已是 pro/premium 或 `proClaimed:true` 时跳过。
- [x] 领取成功后更新 `accessTier` 与 `proClaimed`。
- [x] 真实活动/新人探索只读状态接口已校准为 probe operation。
- [x] 通用 activity participate POST path/header 已校准为显式 probe。
- [x] 活动 Pro 成功 evidence 可通过 `fixtures audit --scope benefits` 只读审计。
- [ ] 活动过期返回 skipped 待真实协议错误码接入后补齐。
- [ ] 活动 Pro 领取的具体 body、成功响应和失败分类仍待安全 evidence 后接入。
