# Commerce Side-Effect Reverse Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover or rule out immediately usable Tabbit commerce side-effect bodies for Pro claim, reset-coupon consumption, and lottery draw from browser/public runtime evidence, then capture sanitized fixtures when safe.

**Architecture:** Treat the copied `output/tabbit-live-state` as read-only account/session input. Use public JS/static route evidence plus read-only protocol probes to identify endpoint/body candidates; only run POST probes with `confirmSideEffect:true` when the body is derived from browser evidence and contains no raw user data in logs or docs. Any new fixture output must go to a temp fixture directory, not `output/`.

**Tech Stack:** Node.js CLI, `ProtocolTabbitClient`, `ProtocolProbeRunner`, PowerShell orchestration, Chrome DevTools public-script inspection, Node test runner.

---

## Task 1: Public Commerce Bundle Reverse Scan

**Files:**
- Modify: `docs/plans/2026-07-04-commerce-side-effect-reverse-closure.md`

**Step 1: Scan public scripts**

Run a public-script aggregate scanner against `https://web.tabbit.ai/login` and the loaded CDN chunks. Search for commerce endpoint and field literals including:

- `usage-reset-coupon`
- `coupon`
- `sku`
- `consume`
- `redeem`
- `participate`
- `lottery`
- `draw`
- `activity_id`
- `request_no`
- `main_pool`
- `chance`
- `pro`

Only output aggregate endpoint literals, field names, and hit counts. Do not save raw JS in the repository and do not print raw source.

**Step 2: Record findings**

Append endpoint candidates and body-key candidates to this plan document. If no reset-coupon consumption or Pro/lottery body source exists in public chunks, record that as evidence and move to read-only account state probing.

## Task 2: Read-Only Runtime Shape Validation

**Files:**
- Modify: `docs/plans/2026-07-04-commerce-side-effect-reverse-closure.md`

**Step 1: Run read-only probes**

Use `acct_default` from copied state with:

- `getLotteryExplorationMe`
- `getNewbieExplorationMe`
- `getPlacementResources`
- `listBenefitCoupons`
- `getUsageResetCouponSku`
- `getAvailableLotteryChanceCount`
- `getActiveMainPools`
- `listLotteryChanceRecords`

Output only aggregate status, key presence, counts, and non-empty field counts. Do not print raw coupon values, activity ids, user ids, or fixture bodies.

**Step 2: Decide capture path**

If a non-empty activity id or draw body is found, validate the matching POST input with `probe validate --require-confirmed-side-effect`, then run the POST probe with `--write-fixture` into `%TEMP%`.

If no safe body can be derived, do not send guessed POSTs. Instead implement a small regression improvement only if the code is missing an audit/template guard discovered during the scan.

## Task 3: TDD For Any Code Gap

**Files:**
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`
- Test: `test/protocol-probe.test.js`
- Modify only the smallest matching source file if a real code gap is found.

**Step 1: Write failing test**

Add a focused test for the missing behavior, for example a new safe template, stricter validation, or a new calibrated endpoint wrapper.

**Step 2: Verify RED**

Run the focused `node --test ... --test-name-pattern ...` command and confirm it fails for the expected missing behavior.

**Step 3: Implement minimal GREEN**

Make the smallest source change required by the failing test. Do not add speculative endpoint support without browser/static evidence.

**Step 4: Verify GREEN**

Run the focused test, then `node --test test\ops-cli.test.js`, `node --test test\protocol-tabbit-client.test.js`, and `npm test`.

## Task 4: Final Verification And Safety

**Files:**
- Modify: `docs/plans/2026-07-04-commerce-side-effect-reverse-closure.md`

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Also run:

- forbidden path scan for `tabbit-cookie.txt`, `output/`, browser profiles, local state fixture, `.agents/`, `.codex/`, `.omx/`;
- credential-shape scan for session/cookie/JWT/API-key/authorization-like patterns in changed files.

Record aggregate results in this plan. Never record raw payloads, raw fixture bodies, prompts, cookies, sessions, tokens, or real user data.

## Evidence Log

### Reset Coupon Consumption Closure

- Copied live state was treated as read-only at `output/tabbit-live-state`; no files under `output/` were written.
- New sanitized fixture output used `%TEMP%\tabbit-commerce-reverse-fixtures` through `TABBIT_POOL_PROTOCOL_FIXTURE_DIR`.
- Static/dynamic reverse result:
  - real candidate endpoint: `POST /api/commerce/benefit/v1/coupon/use`;
  - calibrated request fields: `user_id`, `coupon_code`, `coupon_type`, `request_no`;
  - observed sanitized response shape exposed `use_result` and `request_no` keys.
- RED tests added before implementation:
  - `node --test test\ops-cli.test.js --test-name-pattern "useResetCoupon|side-effect inputs|reset coupon use env"` failed on missing template, confirmation gate, and env forwarding.
  - `node --test test\protocol-pool-gateway.test.js --test-name-pattern "read-only benefits paths"` failed because the gateway did not expose `useResetCoupon`.
  - `node --test test\protocol-probe.test.js --test-name-pattern "redacts reset coupon codes"` failed because coupon-code fields were not redacted from sanitized fixtures.
  - `node --test test\protocol-tabbit-client.test.js --test-name-pattern "useResetCoupon posts calibrated"` failed because `use_result` was not normalized to the audit-visible `usageResult`.
- GREEN implementation:
  - `probe template --operation useResetCoupon` now emits a safe side-effect template with `confirmSideEffect:false`.
  - `probe validate --operation useResetCoupon --require-confirmed-side-effect` now rejects unconfirmed input before touching accounts, secrets, fixtures, or network.
  - CLI and gateway config now forward `TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH`.
  - `ProtocolTabbitClient.useResetCoupon()` posts the calibrated body with explicit side-effect confirmation and emits endpoint/body/result hash evidence.
  - protocol probe fixture sanitization now redacts `couponCode`, `coupon_code`, `couponNo`, `coupon_no`, `couponId`, and `coupon_id`.
  - commerce response normalization now maps `use_result`/`usage_result` to `usageResult` for existing strict benefits audit matching.
- Live aggregate capture:
  - coupon list candidate check: active account true, user id present, coupon list ok, record count 2, coupon-code candidate found true.
  - first live `useResetCoupon` probe: protocol status success, source `tabbit-reset-coupon-use`, hash evidence safe/sanitized/rawPayload=false, but old fixture lacked top-level `usageResult`.
  - second live `useResetCoupon` probe after GREEN normalization: protocol status success, source `tabbit-reset-coupon-use`, top-level `usageResult` present, hash evidence safe/sanitized/rawPayload=false.
  - benefits audit with the temp fixture directory reported `successfulResetCouponConsumption=1` and `resetCouponConsumptionStatus=ready`.
  - daily sign-in was also captured into the same temp fixture directory; benefits audit then reported `successfulDailySignIn=1`, `successfulResetCouponConsumption=1`, and remaining benefits missing only `successful_pro_activity_fixture` and `successful_lottery_draw_fixture`.

No raw coupon code, cookie, session, JWT, bearer token, API key, raw fixture body, request payload, prompt, browser profile, or real user data was printed or written into this document.

### Final Verification

- `node --test test\ops-cli.test.js`: 102/102 pass.
- `node --test test\protocol-tabbit-client.test.js`: 61/61 pass.
- `node --test test\protocol-probe.test.js`: 24/24 pass.
- `node --test test\observability.test.js`: 37/37 pass.
- `node --test test\protocol-pool-gateway.test.js`: 19/19 pass.
- `npm test`: 396/396 pass through the tracked-suite runner.
- `git diff --check`: exit 0; only existing LF/CRLF conversion warnings were printed.
- Forbidden path scan over changed/untracked paths: clean, 0 hits for `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, or `.omx`.
- Credential-shape diff scan: clean, 0 JWT/Bearer/API-key/cookie/session-token shape hits after excluding explicit fake test placeholders.

External aggregate checks remained raw-free:

- Copied state at `output/tabbit-live-state` without temp fixture override: `doctor=ready`, `readiness=ready`, `defaultAudit=ready`, `remainingWork=0`; auth/benefits/session/upstream backlog still blocked for extended calibration.
- Temp sanitized fixture directory `%TEMP%\tabbit-commerce-reverse-fixtures`: `successfulDailySignIn=1`, `successfulResetCouponConsumption=1`, benefits missing only `successful_pro_activity_fixture` and `successful_lottery_draw_fixture`.
