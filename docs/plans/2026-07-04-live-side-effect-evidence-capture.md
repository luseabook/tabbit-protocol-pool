# Live Side Effect Evidence Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Use the approved live side-effect window to capture the next safe sanitized real-protocol evidence fixtures without leaking credentials, raw payloads, prompts, or user data.

**Architecture:** Keep all sensitive runtime state outside the repository and drive evidence capture through the existing `tabbit-pool probe template`, `probe validate`, `probe protocol --write-fixture`, and scoped fixture audits. Configure only already documented endpoint paths in the process environment, write transient probe inputs outside the repo, and record only aggregate status/counts plus command outcomes in this plan.

**Tech Stack:** Node.js ESM CLI, `ProtocolTabbitClient`, `ProtocolProbeRunner`, native `node:test`, external live-state fixture store under `TABBIT_POOL_STATE_DIR`.

---

### Task 1: Baseline and Endpoint Gate

**Files:**
- Create: `docs/plans/2026-07-04-live-side-effect-evidence-capture.md`
- Inspect: `src/config.js`
- Inspect: `src/protocol-tabbit-client.js`
- Inspect: `src/protocol-probe.js`
- Inspect: `src/ops-cli.js`

**Step 1: Confirm aggregate live-state baseline**

Run aggregate-only checks with:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
```

Expected: main readiness ready, calibration backlog blocked only by auth/benefits/session-recovery/upstream evidence.

**Step 2: Confirm path env names**

Use project code/docs to confirm the live endpoint env names before setting them:

- `TABBIT_POOL_PROTOCOL_SIGN_IN_PATH=/api/commerce/activity/v1/sign-in`
- `TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH=/api/commerce/activity/v1/participate`
- `TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH=/api/commerce/lottery/v1/draw`

Auth send/submit paths must not be guessed. Only run auth probes if a path is confirmed by safe project evidence or sanitized browser/protocol evidence.

### Task 2: RED / Preflight Validation

**Files:**
- No repository code change expected unless preflight reveals a missing safety gate.

**Step 1: Verify existing side-effect gate rejects unconfirmed input**

Run at least one focused preflight on a side-effect template with `confirmSideEffect:false`:

```powershell
node bin\tabbit-pool.js probe validate --operation dailySignIn --input-json <template-json> --require-confirmed-side-effect --json
```

Expected RED: command fails with the existing side-effect confirmation error. This proves the live probe path still has a local safety gate before touching the network.

**Step 2: Verify confirmed sanitized input passes offline validation**

Run the same operation with `confirmSideEffect:true`.

Expected GREEN preflight: command exits 0 and prints only schema/shape preview.

### Task 3: Live Benefits Evidence Capture

**Files:**
- External fixture store only via `probe protocol --write-fixture`.
- Do not edit or print raw external fixture files.

**Step 1: Daily sign-in**

Use `acct_default` unless aggregate account listing shows it is inactive. Run:

```powershell
node bin\tabbit-pool.js probe protocol --account acct_default --operation dailySignIn --input-json <confirmed-json> --write-fixture --json
node bin\tabbit-pool.js fixtures audit --scope benefits --json
```

Expected: either `successful_daily_sign_in_fixture` becomes ready, or the fixture records a sanitized failed/already-done response that keeps the scope blocked without leaking raw body.

**Step 2: Activity Pro claim**

Only use a documented safe body shape. If `participateActivity` body is still empty or missing a confirmed activity id, do not guess; record the blocker in this plan and keep the existing audit blocked.

**Step 3: Lottery draw**

Only run if a disposable chance and draw body are confirmed by read-only aggregate probes or documented safe input. If not, record the blocker and do not invent an activity id.

**Step 4: Reset coupon consumption**

No live protocol probe exists for `consumeResetCoupon`. Do not call an unrelated endpoint as a substitute. If a real consumption endpoint/body/result hash is not available from sanitized evidence, keep this item blocked.

### Task 4: Live Upstream Boundary Evidence Attempt

**Files:**
- External fixture store only via `probe protocol --write-fixture`.
- Do not print prompt/raw stream frames.

**Step 1: Run a harmless stream send**

Use a non-sensitive prompt such as `ping`, with `stream:true`, and write a sanitized fixture:

```powershell
node bin\tabbit-pool.js probe protocol --account acct_default --operation sendMessage --input-json <safe-stream-json> --write-fixture --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

Expected: a normal success stream may refresh default readiness but will not satisfy error-frame/cancellation/backpressure unless the sanitized fixture has the explicit real upstream markers.

**Step 2: Record boundary blockers**

If the existing CLI cannot force upstream cancellation/backpressure/error-frame without raw fixture inspection or custom client orchestration, document that as the remaining implementation gap before writing code.

### Task 5: TDD Implementation If Needed

**Files:**
- Modify only the smallest necessary `src/*`, `test/*`, and docs files.

**Step 1: Write RED tests before code**

If live execution reveals a missing but safe reusable capability, add the focused failing test first. Examples:

- `fixtures audit` should recognize a newly observed sanitized success field.
- `probe validate` should reject a newly identified unsafe body shape.
- `ProtocolTabbitClient` should normalize a newly observed safe result field.

**Step 2: Implement GREEN**

Make the minimum code change that satisfies the observed evidence without broadening side effects or accepting generic transport success as business success.

**Step 3: Update docs**

Document only sanitized shapes, aggregate counts, and blocked reasons.

### Task 6: Verification

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Run safety scans:

- forbidden path scan for `tabbit-cookie.txt`, `output/`, browser profile/state/live-state paths, `.agents/`, `.codex/`, `.omx/`;
- credential-shape scan over added diff and untracked docs.

Run external aggregate checks only:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope benefits --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

No raw fixture body, cookie, session, JWT, bearer-style credential, API key, prompt, raw payload, or user data may be printed or written into this document.

## Evidence Log

### Baseline

- Default local `readiness doctor --json` stayed blocked because the default user state has no configured protocol paths or fixtures.
- External live-state aggregate doctor was ready for core gateway/chat readiness and still blocked for calibration backlog:
  - auth missing: `successful_sendVerificationCode_fixture`, `successful_submitRegistrationOrLogin_fixture`
  - benefits missing: `successful_daily_sign_in_fixture`, `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, `successful_lottery_draw_fixture`
  - session missing: `automated_session_refresh_strategy`
  - upstream missing: `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, `real_upstream_backpressure_fixture`

### RED / Preflight

- `probe validate --operation dailySignIn --require-confirmed-side-effect` with `confirmSideEffect:false` failed as expected before touching network.
- The same daily sign-in input with `confirmSideEffect:true` passed offline validation and printed only field-shape metadata.
- `sendMessage` safe placeholder input passed offline validation; current templates use `<redacted-message-content>` before operator review and replacement.

### GREEN: Writable Fixture Directory

- First live `dailySignIn --write-fixture` attempt against external live-state failed at fixture persistence with `EPERM`, because this session can read but not write `E:\tabbit2api\output\tabbit-live-state`.
- Added TDD coverage and implementation for `TABBIT_POOL_PROTOCOL_FIXTURE_DIR`:
  - RED:
    - `node --test --test-name-pattern "environment overrides" test\config.test.js`
    - `node --test --test-name-pattern "explicit fixtureDir" test\protocol-probe.test.js`
    - `node --test --test-name-pattern "separate writable" test\ops-cli.test.js`
  - GREEN:
    - `loadConfig()` now exposes `protocolFixtureDir`.
    - `FileProtocolFixtureStore` can read/write sanitized fixtures in an explicit `fixtureDir` while keeping stable `fixtures/protocol-probes/<name>.json` refs.
    - `createProtocolPoolCliDependencies()` wires `TABBIT_POOL_PROTOCOL_FIXTURE_DIR` into the default protocol fixture store.

### GREEN: Daily Sign-In Already Signed Boundary

- Live daily sign-in returned a sanitized successful probe with business status `already_signed`.
- Existing benefits audit did not count that as daily sign-in coverage, so the scope still reported `successful_daily_sign_in_fixture` missing.
- Added RED tests proving `already_signed` should count only for `dailySignIn`, while `already_participated` still does not satisfy Pro success:
  - `node --test --test-name-pattern "already_signed daily sign-in" test\observability.test.js`
  - `node --test --test-name-pattern "scope benefits reports" test\ops-cli.test.js`
- Implemented a daily-sign-in-only success value set. Pro, lottery, and reset coupon matchers remain strict.

### GREEN: Probe Fixture Prompt And User-Data Redaction

- Before continuing upstream capture, added RED tests proving `sendMessage` fixture input/result text and `verifySession` user identifiers must not be persisted:
  - `node --test --test-name-pattern "redacts sendMessage prompt" test\protocol-probe.test.js`
  - `node --test --test-name-pattern "redacts real user identifiers" test\protocol-probe.test.js`
- Implemented fixture sanitizer coverage for prompt/content/text/html_content, stream deltas, raw event/frame data, attachment data, and user identifiers such as `userId`, `user_id`, `user_info.id`, nickname/avatar/phone-like fields.
- Rewrote the gitignored `tmp/live-fixtures` JSON files through the new sanitizer without printing fixture bodies:
  - rewritten fixture count: 5
  - skipped fixture count: 0

### Live Capture Results

All live fixture writes used:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_FIXTURE_DIR = "E:\tabbit-protocol-pool\tmp\live-fixtures"
```

The fixture directory is git-ignored and contains sanitized probe fixtures only.

- `dailySignIn` on `acct_default`:
  - protocol command exited 0 and wrote a sanitized fixture under `tmp/live-fixtures`.
  - benefits scope audit with the same fixture directory reported:
    - `successfulDailySignIn=1`
    - `coverage.dailySignIn.status=ready`
    - remaining benefits missing: `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, `successful_lottery_draw_fixture`
- `verifySession` lifecycle:
  - valid `acct_default` probe wrote a sanitized success fixture.
  - invalid-cookie account probe wrote a sanitized `login_required`/expired fixture.
  - session scope audit reported:
    - `successfulSessionVerify=ready`
    - `expiredSessionSignal=ready`
    - `recoveryStrategy=blocked`
- Read-only commerce probes:
  - `acct_default` lottery/newbie exploration aggregate status showed no safe activity id or available activity body to use for Pro claim or lottery draw.
  - `acct_invalid_cookie` was not usable as a side-effect calibration account: one read-only activity probe returned `login_required`, and the other only showed guest/newbie state.
  - In-memory-only user-id hydrated probes showed weekly reset coupon records exist, but no consumption endpoint/body/result hash is available; usage reset coupon SKU stayed in an invalid/not-purchasable class.
  - Placement resources exposed no activity id fields, so they did not unlock Pro or lottery body construction.
- `sendMessage` upstream attempt:
  - safe synthetic stream probe failed with sanitized `protocol_changed` classification before producing real upstream stream boundary evidence.
  - upstream scope audit remained blocked with all three missing: error-frame, cancellation, backpressure.
- Browser/static auth reconnaissance:
  - isolated browser context opened `https://web.tabbit.ai/login` without reusing local profile.
  - the page resolved to the Tabbit product page, not a normal login form.
  - XHR/fetch requests did not expose auth send/submit endpoints.
  - public bundle endpoint scan found no safe concrete auth API path; no raw JS, request body, cookie, session, or profile data was saved.
  - Follow-up HTTPS static scan of the public CDN scripts found 4 API path literals and 0 auth-like endpoint paths.

### Current Aggregate Status

- External live-state plus `tmp/live-fixtures` aggregate check:
  - `doctorStatus=blocked`
  - `calibrationBacklog.missing=9`
  - `dailySignIn=ready`
  - `successfulSessionVerify=ready`
  - `expiredSessionSignal=ready`
  - `automated_session_refresh_strategy=blocked`
  - Pro, reset-coupon consumption, lottery draw, and upstream boundary evidence remain missing.

### Current Blockers

- Auth send/submit: real endpoint/body still unknown; regular web page does not expose a safe login API flow.
- Pro claim: current active/pro account has no safe activity id/body; free account lacks usable login state.
- Reset coupon consumption: account aggregate has reset coupon records, but no calibrated consumption endpoint/body/result hash and SKU remains not purchasable/invalid for a safe use action.
- Lottery draw: no disposable chance/activity body was safely derivable from read-only probes.
- Upstream boundary: safe `sendMessage` stream attempt lacks required runtime context for real upstream SSE boundary capture; no error-frame/cancellation/backpressure fixture was produced.
- Session recovery: success and expired lifecycle evidence are present, but no automated refresh or safe re-auth recovery strategy evidence exists.

No raw fixture body, cookie, session, JWT, bearer-style credential, API key, prompt, raw payload, browser profile, or real user data was written into this document.

## Continuation: Copied Live State Read-Only Capture

The user copied the live state to `output/tabbit-live-state` inside the repository. Because `output/` is a forbidden path for this project, this continuation treats that directory as read-only state input only:

- read account metadata and local secret refs from `output/tabbit-live-state`;
- do not write accounts, secrets, fixtures, readiness state, or any generated files under `output/`;
- write any new sanitized protocol fixtures to a `%TEMP%` fixture directory via `TABBIT_POOL_PROTOCOL_FIXTURE_DIR`;
- keep command output aggregate-only and never print raw fixture bodies, cookies, sessions, prompts, request payloads, or real user data.

Planned RED/GREEN for this continuation:

1. RED safety check: `probe validate --operation dailySignIn --require-confirmed-side-effect` must reject `confirmSideEffect:false` before any network call.
2. GREEN validation: the same daily sign-in input with `confirmSideEffect:true` must pass offline schema validation.
3. GREEN live capture: run `dailySignIn` against the valid copied `acct_default` session with `--write-fixture`, but write the sanitized fixture only to `%TEMP%`.
4. Verification: run benefits audit with the temp fixture directory and confirm `successful_daily_sign_in_fixture` is ready while Pro, reset-coupon consumption, and lottery draw remain blocked.

### Continuation Evidence

- Copied state existence was confirmed at `output/tabbit-live-state`; no files under `output/` were written by this continuation.
- Aggregate copied-state account check found two accounts:
  - `acct_default`: active/pro and usable for read-only `verifySession`.
  - `acct_invalid_cookie`: still returns `login_required`, useful only as expired-session evidence.
- RED safety validation:
  - `probe validate --operation dailySignIn --require-confirmed-side-effect` with `confirmSideEffect:false` exited 2 before any network call.
- GREEN schema validation:
  - the same operation with `confirmSideEffect:true` exited 0.
- GREEN live capture:
  - `probe protocol --account acct_default --operation dailySignIn --write-fixture` exited 0.
  - fixture output was written under `%TEMP%\tabbit-live-fixtures-copied-state`, not under `output/`.
  - sanitized aggregate result: `status=success`, `source=tabbit-daily-sign-in`, `signInResult=already_signed`, raw response keys limited to `sign_in_date` and `results`.
- Benefits audit using the temp fixture directory reported:
  - `successfulDailySignIn=1`.
  - `coverage.dailySignIn.status=ready`.
  - remaining benefits blockers: `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, and `successful_lottery_draw_fixture`.
- Read-only commerce reprobe against copied `acct_default` state:
  - lottery exploration, newbie exploration, placement resources, reward records, lottery hit records, and benefit coupons all returned sanitized aggregate success.
  - benefit coupon list reported `total=2` and record count 2, but this only proves coupon inventory visibility, not reset-coupon consumption.
  - usage reset coupon SKU stayed in an `invalid_request`/404 class.
  - lottery chance, active pool, and chance-record templates require an `activityId`; no non-empty activity id was available from read-only exploration.
  - recursive field-presence scan found `lottery_activity_id`, `invitation_activity_id`, `available_chance_count`, and nested `activity_id` keys present but empty.
  - therefore Pro claim and lottery draw remain blocked on a real non-empty activity id/body, and reset-coupon consumption remains blocked on the true consumption endpoint/body/result hash.

No raw cookie, session, JWT, bearer-style credential, API key, prompt, raw fixture payload, request body, browser profile, or real user data was printed or written into this document.
