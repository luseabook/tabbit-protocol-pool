# Benefits Side-Effect Fixture Audit Scope Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only benefits fixture audit scope that makes the remaining M05 side-effect calibration gaps visible without executing Pro claims, reset coupon consumption, or lottery draws.

**Architecture:** Extend `buildProtocolFixtureAudit()` with a scoped `benefits` mode. The default protocol audit and readiness doctor remain unchanged; the new scope only counts sanitized protocol probe fixtures for M05 operations and reports conservative missing evidence names for daily sign-in, Pro activity success, real reset coupon consumption, and lottery draw success. The CLI exposes the scope through `tabbit-pool fixtures audit --scope benefits` and prints aggregate coverage only.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit()`, `readProtocolFixtureDetails()`, `runProtocolPoolCli()`, protocol probe fixtures, and docs under `docs/`.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildProtocolFixtureAudit supports benefits side-effect fixture scope`.

Use fixtures that cover:

```js
[
  { operation: "dailySignIn", status: "success", result: { signInResult: "success", signedToday: true } },
  { operation: "participateResetCouponActivity", status: "success", result: { participationResult: "already_participated" } },
  { operation: "participateActivity", status: "failed", error: { category: "forbidden" } },
  { operation: "drawLottery", status: "failed", error: { category: "quota_exhausted" } },
]
```

Expected assertions:

- `scope === "benefits"`.
- `status === "blocked"` because Pro success, real reset coupon consumption, and lottery draw success are missing.
- `counts.dailySignIn === 1`, `counts.participateResetCouponActivity === 1`, `counts.participateActivity === 1`, `counts.drawLottery === 1`.
- `counts.successfulDailySignIn === 1`.
- `counts.successfulResetCouponConsumption === 0`; `already_participated` is not reset coupon consumption.
- `coverage.dailySignIn.status === "ready"`.
- `coverage.proActivitySuccess.status === "missing"`.
- `coverage.resetCouponConsumption.status === "missing"`.
- `coverage.lotteryDrawSuccess.status === "missing"`.
- Serialized audit output does not include raw user data, token strings, or fixture payload bodies.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "benefits side-effect fixture scope"
```

Expected: FAIL because `scope:"benefits"` is not implemented.

### Task 2: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `fixtures audit --scope benefits reports side-effect evidence coverage`.

Use an injected `protocolFixtureStore` with summaries and `readFixture(ref)` returning sanitized benefits fixtures:

- `dailySignIn` success.
- `participateResetCouponActivity` with `participationResult:"already_participated"`.
- `participateActivity` failed.
- `drawLottery` failed.

Run:

```js
runProtocolPoolCli(["fixtures", "audit", "--scope", "benefits", "--json"], ...)
```

Expected assertions:

- CLI reads fixture details after validating the scope.
- Output has `scope:"benefits"`.
- Output status is `blocked`.
- Missing contains `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, and `successful_lottery_draw_fixture`.
- Stdout does not contain raw email, cookie, token, session, request payload text, or prompt text.

**Step 2: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

Expected: FAIL until the CLI supports the benefits scope.

### Task 3: Implement Benefits Audit

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add conservative matcher helpers**

In `src/observability.js`, add helpers for the benefits scope:

- Daily sign-in success: `operation === "dailySignIn"`, `status === "success"`, and result has `signInResult/sign_in_result === "success"` or `signedToday/signed_today === true`.
- Pro activity success: `operation === "participateActivity"`, `status === "success"`, and a strong explicit success signal is present. Do not infer success from mere 2xx shape.
- Reset coupon consumption success: require an explicit consumption signal, not `participateResetCouponActivity` `already_participated`. Unknown or activity-only evidence stays missing.
- Lottery draw success: `operation === "drawLottery"`, `status === "success"`, and a strong explicit draw/prize/result success signal is present.

**Step 2: Return aggregate-only audit output**

Return:

- `scope:"benefits"`.
- `status:"ready"` only when all four coverage items are ready.
- `counts` for operation totals and conservative success totals.
- `coverage.dailySignIn`, `coverage.proActivitySuccess`, `coverage.resetCouponConsumption`, `coverage.lotteryDrawSuccess`.
- `missing` and `nextActions` with evidence capture guidance.

Do not include fixture bodies, request payloads, emails, prompts, tokens, or raw response data in the audit output.

**Step 3: Add CLI scope parsing and table output**

In `handleFixturesAudit()`:

- Accept supported scopes `protocol`, `auth`, `benefits`.
- Reject unsupported scopes before reading fixtures.
- Add non-JSON table lines for the benefits coverage names.
- Leave default `fixtures audit` behavior unchanged.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M05-权益额度维护/_M05-权益额度维护.md`
- Modify: `docs/modules/M05-权益额度维护/活动Pro领取.md`
- Modify: `docs/modules/M05-权益额度维护/重置券使用.md`

**Step 1: Document command**

Document:

```powershell
node bin\tabbit-pool.js fixtures audit --scope benefits --json
```

Clarify it is read-only, optional, and separate from default chat/gateway readiness.

**Step 2: Record remaining evidence gaps**

Document that `already_participated` remains activity evidence, not reset coupon consumption. Pro activity success, reset coupon consumption, and lottery draw success stay blocked until safe sanitized success fixtures are captured.

### Task 5: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused RED/GREEN tests**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "benefits side-effect fixture scope"
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

**Step 2: Regression tests**

Run:

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
npm test
```

**Step 3: External state read-only check**

Run readiness doctor/readiness/default fixture audit against `E:\tabbit2api\output\tabbit-live-state`; additionally run:

```powershell
node bin\tabbit-pool.js fixtures audit --scope auth --json
node bin\tabbit-pool.js fixtures audit --scope benefits --json
```

Only inspect aggregate output; do not print raw fixture files.

**Step 4: Secret boundary**

Run forbidden-path and sensitive-token scans. Confirm no forbidden local files were touched.

### Task 6: Benefits Scope Isolation Hardening

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`
- Modify docs that describe benefits fixture audit output.

**Step 1: Write the failing observability test**

Add a test named `buildProtocolFixtureAudit ignores unrelated fixtures in benefits scope`.

Use fixtures with:

```js
[
  { operation: "dailySignIn", status: "success", result: { signInResult: "success" } },
  { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
  { operation: "sendMessage", status: "failed", error: { category: "forbidden", message: "token=secret" } },
]
```

Expected assertions:

- `scope === "benefits"`.
- `counts.total === 1`, `counts.success === 1`, and `counts.failed === 0`.
- `dailySignIn` coverage remains ready.
- Non-benefits fixture data does not appear in serialized audit output.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "unrelated fixtures in benefits scope"
```

Expected: FAIL because the current benefits audit counts every fixture in `total/success/failed`.

**Step 3: Write the failing CLI test**

Extend `fixtures audit --scope benefits reports side-effect evidence coverage` with an unrelated `sendMessage` fixture.

Expected assertions:

- `readFixture` is called only for benefits operations.
- `counts.total === 4`, `counts.success === 2`, and `counts.failed === 2` for the four benefits fixtures.
- The unrelated fixture body is not present in stdout.

**Step 4: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

Expected: FAIL because CLI currently reads all fixture refs for benefits scope.

**Step 5: Implement the minimal fix**

- In `src/observability.js`, filter benefits audits to M05 side-effect operations before computing all counts.
- In `src/ops-cli.js`, pass `operations: ["dailySignIn", "participateResetCouponActivity", "participateActivity", "drawLottery", "useResetCoupon", "consumeResetCoupon", "consumeResetCouponSku", "redeemResetCoupon"]` when `--scope benefits` is used.
- Keep default protocol audit unchanged.

**Step 6: Run GREEN and regression checks**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "unrelated fixtures in benefits scope"
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

Expected: all commands exit 0, and external `fixtures audit --scope benefits --json` reports only benefits-scope fixture counts.

### Task 7: Reset Coupon Consumption Boundary Hardening

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`
- Modify: `src/observability.js`
- Modify docs that describe reset coupon consumption audit semantics.

**Step 1: Write the failing observability test**

Add a test named `buildProtocolFixtureAudit never treats reset activity participation as coupon consumption`.

Use a `participateResetCouponActivity` fixture with `status:"success"` and deliberately strong-looking fields:

```js
{
  operation: "participateResetCouponActivity",
  status: "success",
  result: {
    resetCouponConsumed: true,
    consumeResult: "success",
    couponConsumed: true
  }
}
```

Expected assertions:

- `counts.participateResetCouponActivity === 1`.
- `counts.successfulResetCouponConsumption === 0`.
- `coverage.resetCouponConsumption.status === "missing"`.
- `missing` still contains `successful_reset_coupon_consumption_fixture`.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "reset activity participation"
```

Expected: FAIL because the current reset coupon matcher can count `participateResetCouponActivity` when it contains consumed/used fields.

**Step 3: Write the failing CLI test**

Extend `fixtures audit --scope benefits reports side-effect evidence coverage` with a sanitized `participateResetCouponActivity` success fixture containing the same strong-looking consumption fields.

Expected assertions:

- CLI still reads the fixture because it is M05 side-effect evidence.
- `coverage.resetCouponConsumption.count === 0`.
- The audit stays blocked with `successful_reset_coupon_consumption_fixture` missing.
- Stdout does not contain raw request/user/token/body fields.

**Step 4: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

Expected: FAIL until `participateResetCouponActivity` is removed from the reset coupon consumption success matcher.

**Step 5: Implement the minimal fix**

- Keep `participateResetCouponActivity` in `BENEFITS_AUDIT_OPERATIONS` so its evidence remains counted and visible.
- Remove `participateResetCouponActivity` from `fixtureMatchesResetCouponConsumptionSuccess()` success-eligible operation names.
- Leave the real consumption-eligible names as `useResetCoupon`, `consumeResetCoupon`, `consumeResetCouponSku`, and `redeemResetCoupon` until the true endpoint/body/result hash is captured.

**Step 6: Run GREEN and regression checks**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "reset activity participation"
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

Expected: all commands exit 0, and reset coupon consumption remains blocked until a true consumption operation fixture is captured.

### Task 8: Lottery Draw Success Boundary Hardening

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`
- Modify: `src/observability.js`
- Modify docs that describe lottery draw success audit semantics.

**Step 1: Write the failing observability test**

Add a test named `buildProtocolFixtureAudit requires draw-specific evidence for lottery success`.

Use a `drawLottery` fixture with `status:"success"` and only generic success fields:

```js
{
  operation: "drawLottery",
  status: "success",
  result: {
    status: "success",
    result: "success",
    ok: true
  }
}
```

Expected assertions:

- `counts.drawLottery === 1`.
- `counts.successfulLotteryDraw === 0`.
- `coverage.lotteryDrawSuccess.status === "missing"`.
- `missing` still contains `successful_lottery_draw_fixture`.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "draw-specific evidence"
```

Expected: FAIL because the current matcher accepts generic `status/result:"success"` as lottery draw success.

**Step 3: Write the failing CLI test**

Extend `fixtures audit --scope benefits reports side-effect evidence coverage` with a sanitized `drawLottery` fixture containing only generic success fields.

Expected assertions:

- CLI reads the draw fixture because it is M05 side-effect evidence.
- `counts.drawLottery` includes it.
- `coverage.lotteryDrawSuccess.count === 0`.
- The audit stays blocked with `successful_lottery_draw_fixture` missing.
- Stdout does not contain raw request/user/token/body fields.

**Step 4: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

Expected: FAIL until generic success fields are removed from lottery success matching.

**Step 5: Implement the minimal fix**

- Keep `drawLottery` in `BENEFITS_AUDIT_OPERATIONS` so attempts remain visible.
- In `fixtureMatchesLotteryDrawSuccess()`, require one of:
  - explicit `drawResult` / `draw_result` / `lotteryResult` / `lottery_result` success;
  - non-empty `prize`, `award`, `reward`, `hitRecord`, `hit_record`, `hitRecordId`, or `hit_record_id`.
- Do not count generic `result:"success"`, `status:"success"`, or `ok:true` as draw success.

**Step 6: Run GREEN and regression checks**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "draw-specific evidence"
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

Expected: all commands exit 0, and lottery success remains blocked until a safe draw-specific success fixture is captured.
