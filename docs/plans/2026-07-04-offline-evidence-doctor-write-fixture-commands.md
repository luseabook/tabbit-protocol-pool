# Offline Evidence Doctor Write Fixture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make readiness doctor expose direct, safe `probe validate --write-fixture` commands for offline evidence blockers so operators can persist sanitized `recoverSession` and `consumeResetCoupon` evidence without manual fixture-store edits.

**Architecture:** Keep the existing capture-command model as the source of truth. Add a dedicated `writeFixtureCommand` field only for offline evidence operations that already support validated fixture persistence, and render it in plain doctor output without changing protocol probe dispatch behavior.

**Tech Stack:** Node.js built-in test runner, local CLI in `src/ops-cli.js`, readiness/capture command builder in `src/observability.js`, markdown project docs.

---

### Task 1: RED tests for offline write-fixture capture commands

**Files:**

- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing JSON doctor tests**

Add assertions in the existing capture-command coverage:

```js
assert.match(
  byMissing.successful_reset_coupon_consumption_fixture.writeFixtureCommand,
  /probe validate --operation consumeResetCoupon --input-file <redacted-input\.json> --write-fixture --json/
);
assert.match(
  byMissing.automated_session_refresh_strategy.writeFixtureCommand,
  /probe validate --operation recoverSession --input-file <redacted-input\.json> --write-fixture --json/
);
assert.equal(byMissing.successful_sendVerificationCode_fixture.writeFixtureCommand, null);
```

Expected RED:

```powershell
node --test --test-name-pattern "capture commands" test\observability.test.js
```

Fails because capture command objects do not expose `writeFixtureCommand`.

**Step 2: Write failing plain doctor test**

Extend existing plain-output assertions so offline entries include a `write_fixture=` column:

```js
assert.match(text, /^capture_command\tsuccessful_reset_coupon_consumption_fixture\t.*\twrite_fixture=node bin\\tabbit-pool\.js probe validate --operation consumeResetCoupon --input-file <redacted-input\.json> --write-fixture --json/m);
assert.match(text, /^capture_command\tautomated_session_refresh_strategy\t.*\twrite_fixture=node bin\\tabbit-pool\.js probe validate --operation recoverSession --input-file <redacted-input\.json> --write-fixture --json/m);
```

Expected RED:

```powershell
node --test --test-name-pattern "readiness doctor" test\ops-cli.test.js
```

Fails because plain capture-command output has no write-fixture column.

### Task 2: GREEN implementation

**Files:**

- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add a builder helper**

In `src/observability.js`, add a `writeFixtureCommandForMissing()` helper that returns:

```js
"node bin\\tabbit-pool.js probe validate --operation " + operation
  + " --input-file <redacted-input.json> --write-fixture --json"
```

Only return this command when the missing evidence is one of:

- `successful_reset_coupon_consumption_fixture`
- `automated_session_refresh_strategy`

Return `null` for protocol-dispatched operations, including auth and benefits side-effect probes.

**Step 2: Include the field in capture command objects**

Extend `captureCommandForMissing()` output with:

```js
writeFixtureCommand
```

Keep `probeCommand:null` for offline evidence operations.

**Step 3: Render the field in plain doctor output**

In `src/ops-cli.js`, add `write_fixture=` to `capture_command` rows. Empty string for `null` keeps non-offline rows compact and avoids inventing unsafe commands.

### Task 3: Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/plans/2026-07-04-offline-evidence-doctor-write-fixture-commands.md`

Document:

- readiness doctor now exposes `writeFixtureCommand` for offline evidence only;
- the command writes sanitized validated evidence and does not run a protocol probe;
- auth, Pro, daily sign-in, lottery, upstream, and verifySession still require calibrated protocol paths and fixtures.

### Task 4: Verification

Run:

```powershell
node --test --test-name-pattern "capture commands" test\observability.test.js
node --test --test-name-pattern "readiness doctor" test\ops-cli.test.js
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Run safety scans:

- forbidden path scan for `tabbit-cookie.txt`, `output/`, browser profile/state/live-state paths, `.agents/`, `.codex/`, `.omx/`;
- credential-shape scan over added diff and untracked docs.

Run external aggregate checks with `E:\tabbit2api\output\tabbit-live-state`, printing only status/count fields.

## Evidence Log

### RED

- `node --test --test-name-pattern "capture commands" test\observability.test.js`
  - Failed as expected because `writeFixtureCommand` was `undefined` for capture command objects.
- `node --test --test-name-pattern "readiness doctor" test\ops-cli.test.js`
  - Failed as expected because JSON doctor lacked `writeFixtureCommand` and plain `capture_command` lines lacked `write_fixture=`.

### GREEN

- `src/observability.js`
  - Added offline-only `writeFixtureCommand` generation for:
    - `successful_reset_coupon_consumption_fixture`
    - `automated_session_refresh_strategy`
  - Non-offline capture specs keep `writeFixtureCommand:null`.
  - Existing `probeCommand:null` behavior for offline evidence operations is unchanged.
- `src/ops-cli.js`
  - Plain `capture_command` rows now include `write_fixture=` from the capture command object.
- `test/observability.test.js`
  - Verifies JSON doctor exposes offline write-fixture commands and does not expose one for auth send-code.
- `test/ops-cli.test.js`
  - Verifies JSON doctor exposes the offline commands and plain doctor renders `write_fixture=`.

### Documentation

- `README.md`
  - Documents `writeFixtureCommand` / `write_fixture=` and the offline-only boundary.
- `docs/13-真实协议校准与端到端验收.md`
  - Documents that doctor-provided write commands are `probe validate --write-fixture` shortcuts for already-reviewed offline evidence only.
- `docs/modules/M08-观测运维/_M08-观测运维.md`
  - Documents that the field does not replace real protocol calibration for auth, M05 side effects, session verify, or upstream sendMessage.

### Verification

- `node --test --test-name-pattern "capture commands" test\observability.test.js`
  - 1/1 pass.
- `node --test --test-name-pattern "readiness doctor" test\ops-cli.test.js`
  - 3/3 pass.
- `node --test test\observability.test.js`
  - 36/36 pass.
- `node --test test\ops-cli.test.js`
  - 98/98 pass.
- `node --test test\protocol-tabbit-client.test.js`
  - 57/57 pass.
- `npm test`
  - 377/377 pass.
- `git diff --check`
  - Exit 0; only existing LF/CRLF warnings were printed.

### Safety Scans

- Forbidden path scan:
  - Clean.
  - Checked changed/untracked paths for `tabbit-cookie.txt`, `output/`, browser profile/state/live-state paths, `.agents/`, `.codex/`, and `.omx/`.
- Credential-shape scan:
  - Clean.
  - Scanned 13618 added/untracked text items.

### External Aggregate Check

External state was checked only through aggregate JSON status/count fields with:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
```

Aggregate result:

- readiness doctor: `ready`
- readiness: `ready`
- default fixture audit: `ready`
- auth fixture audit: `blocked`
- benefits fixture audit: `blocked`
- session fixture audit: `blocked`
- upstream fixture audit: `blocked`

Remaining blocked calibration evidence:

- auth: `successful_sendVerificationCode_fixture`, `successful_submitRegistrationOrLogin_fixture`
- benefits: `successful_daily_sign_in_fixture`, `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, `successful_lottery_draw_fixture`
- session: `automated_session_refresh_strategy`
- upstream: `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, `real_upstream_backpressure_fixture`

No raw fixture body, cookie, session, JWT, bearer token, API key, prompt, raw payload, or user data was printed or written into this document.
