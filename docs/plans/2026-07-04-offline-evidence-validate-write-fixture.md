# Offline Evidence Validate Write Fixture Plan

**Goal:** Let operators safely persist already-sanitized offline evidence (`recoverSession` and `consumeResetCoupon`) through `probe validate --write-fixture`, so calibrated recovery or reset-coupon evidence can enter `fixtures audit` without manual state-dir file editing.

**Architecture:** Extend the existing `probe validate` path only. It must remain local/offline, reuse existing evidence validators, write only sanitized fixture documents through `FileProtocolFixtureStore.writeFixture()`, and never read accounts, secrets, raw fixture bodies, or dispatch protocol probes.

**Scope:**

- Add `--write-fixture` to `tabbit-pool probe validate` for offline evidence operations only.
- Support `recoverSession` and `consumeResetCoupon`.
- Reject `--write-fixture` for normal probe inputs such as `sendMessage`, `dailySignIn`, auth operations, and all side-effect protocol operations.
- JSON output should include `fixtureRef` and sanitized fixture summary/body without exposing endpoint hash values, body/result payloads, cookies, sessions, prompts, tokens, or user data.
- Plain output should include status, operation, fixture ref, and no raw evidence.
- Update docs and tests.

**Non-goals:**

- Do not make `recoverSession` or `consumeResetCoupon` protocol-dispatchable.
- Do not infer real endpoint/body/result semantics.
- Do not write raw browser captures, cookies, session material, JWTs, bearer tokens, API keys, prompts, or real user data.
- Do not touch `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/`.

## Task 1: RED tests for offline evidence fixture writing

**Files:**

- Modify `test/ops-cli.test.js`

Add tests:

1. `probe validate --operation recoverSession --input-file <file> --write-fixture --json`:
   - validates evidence,
   - calls only `protocolFixtureStore.writeFixture()`,
   - does not read accounts/secrets/fixtures or run protocol probes,
   - returns `fixtureRef`,
   - output does not leak raw nested cookie/token fields.

2. `probe validate --operation consumeResetCoupon --input-file <file> --write-fixture --json`:
   - validates evidence,
   - writes the sanitized `reset_coupon_consumption_evidence`,
   - returns only fixture ref plus sanitized summary,
   - output does not include endpoint/body/result hash values or raw payload values.

3. `probe validate --operation sendMessage --input-json ... --write-fixture --json`:
   - rejects with exit code 2 before touching fixture store.

4. Plain output for `recoverSession --write-fixture`:
   - prints `status`, `operation`, and `fixture_ref`,
   - does not print raw evidence values.

Expected RED: current `probe validate` ignores `--write-fixture`, has no fixture-store dependency, and cannot return a fixture ref.

## Task 2: GREEN implementation

**Files:**

- Modify `src/ops-cli.js`

Implementation notes:

- Update help text for `probe validate`.
- Add `deps` parameter to `handleProbeValidate`.
- After existing schema validation, if `--write-fixture` is set:
  - require operation in `OFFLINE_EVIDENCE_PROBE_OPERATIONS`;
  - require explicit input;
  - sanitize evidence through `sanitizeProtocolProbeFixture(input)`;
  - call `deps.protocolFixtureStore.writeFixture(sanitizedFixture)`;
  - include `fixtureRef` in output.
- Keep normal `probe validate` read-only when `--write-fixture` is absent.
- Do not call `readFixture`, `listFixtures`, account store, secret store, or protocol runner.

## Task 3: Documentation

**Files:**

- Modify `README.md`
- Modify `docs/08-测试用例.md`
- Modify `docs/13-真实协议校准与端到端验收.md`
- Modify `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify `docs/plans/2026-07-04-offline-evidence-validate-write-fixture.md`

Document:

- `probe validate --operation recoverSession --input-file <redacted-input.json> --write-fixture --json`
- `probe validate --operation consumeResetCoupon --input-file <redacted-input.json> --write-fixture --json`
- `--write-fixture` is rejected for non-offline evidence operations.
- Writing a fixture only records sanitized evidence; it does not prove uncalibrated endpoint safety by itself.

## Task 4: Verification

Run:

```powershell
node --test --test-name-pattern "probe validate.*write-fixture" test\ops-cli.test.js
node --test test\ops-cli.test.js
node --test test\observability.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Run safety scans:

- forbidden path scan for `tabbit-cookie.txt`, `output/`, browser profile/state, `.agents/`, `.codex/`, `.omx/`;
- credential-shape scan over added diff and untracked docs.

Run external aggregate check with the configured external state directory and record only statuses/counts.

## Evidence Log

### RED

- `node --test --test-name-pattern "probe validate --write-fixture" test\ops-cli.test.js`
  - Expected failure before implementation: `probe validate` ignored `--write-fixture`, did not call `protocolFixtureStore.writeFixture()`, and could not return a fixture ref.

### GREEN

- `node --test --test-name-pattern "probe validate --write-fixture" test\ops-cli.test.js`
  - 4/4 pass after implementation.
- `node --test test\ops-cli.test.js`
  - 98/98 pass after implementation.

### Implementation Evidence

- `src/ops-cli.js` now accepts `probe validate --write-fixture` only for offline evidence operations: `recoverSession` and `consumeResetCoupon`.
- Non-offline operations are rejected with exit code 2 before fixture-store writes.
- Fixture persistence goes through `protocolFixtureStore.writeFixture()` after existing validation and fixture sanitization.
- JSON/plain output includes a fixture ref and does not echo raw evidence, hash values, cookies, sessions, prompts, bearer tokens, API keys, or user data.
- `probe protocol --operation recoverSession` and `probe protocol --operation consumeResetCoupon` remain non-dispatchable.

### Documentation Evidence

- `README.md` documents the offline evidence write capability and the remaining blocked calibration items.
- `docs/13-真实协议校准与端到端验收.md` documents the two safe `probe validate --write-fixture` flows.
- `docs/modules/M08-观测运维/_M08-观测运维.md` documents the CLI boundary and supported offline operations.
- `docs/08-测试用例.md` adds T49A for offline evidence fixture writing.
- `docs/07-API文档.md` and `docs/09-实现接口参考.md` document the updated CLI/API contract.

### Verification

- `node --test --test-name-pattern "probe validate --write-fixture" test\ops-cli.test.js`
  - 4/4 pass.
- `node --test test\ops-cli.test.js`
  - 98/98 pass.
- `node --test test\observability.test.js`
  - 36/36 pass.
- `node --test test\protocol-probe.test.js`
  - 14/14 pass.
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
  - Initially caught one long fake test cookie placeholder in `test/ops-cli.test.js`.
  - The placeholder and assertion were changed to a short non-credential fixture value.
  - Rerun clean over added diff and untracked docs.

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

No raw fixture body, cookie, session, JWT, bearer token, API key, prompt, payload, or user data was printed or written into this document.
