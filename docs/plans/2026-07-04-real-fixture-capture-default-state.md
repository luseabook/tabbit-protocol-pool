# Real Fixture Capture Default State Execution Record

**Goal:** Try to advance the remaining real sanitized fixture gaps for the manual-cookie operations release without printing or writing secrets, raw payloads, prompts, cookies, sessions, tokens, real user data, or raw fixture bodies.

**Scope:** Current default stateDir only. This record does not add code, does not create fake fixture samples, and does not write protocol fixture state.

**Safety rules:**
- Do not print or persist real cookie/session/JWT/API key/Bearer/raw payload/prompt/user data.
- Do not modify `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/`.
- External state checks may report only aggregate or sanitized classified status.
- Missing real fixtures must stay blocked until real sanitized evidence exists.

## Preconditions Checked

- `AGENTS.md` is not present in this repository; the user-provided AGENTS instructions and safety constraints apply.
- `HEAD` was verified as `d2bd5ff477fd6134874d78c35dedc79cb577700b`.
- Default state contains one redacted active account metadata entry, `acct_default`.
- With only send/session paths configured, `readiness doctor --json`, `fixtures audit --scope session --json`, and `fixtures audit --scope upstream --json` remain blocked because the default fixture store has zero readable sanitized fixtures.

## Live Probe Attempt

The live probe environment was configured with:

```powershell
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
```

The original `accounts probe acct_default --json` attempt was not usable in this sandbox because it attempted to save account state under the default AppData stateDir and failed with a filesystem permission error. Because local state fixture/account mutation is protected in this task, this was treated as a hard stop for state-writing operations.

Follow-up remediation added `accounts probe --read-only`. The same live preflight can now be run without writing account state:

```powershell
node bin\tabbit-pool.js accounts probe acct_default --read-only --json
```

Sanitized aggregate result from the read-only preflight:
- `readOnly:true`
- `changed:false`
- `wouldChange:true`
- projected account status: `suspect`
- advice category: `forbidden`
- message: `Failed to fetch Tabbit sign key`
- fixture written: no
- account state saved: no

A no-write protocol probe was then run:

```powershell
node bin\tabbit-pool.js probe protocol --account acct_default --operation verifySession --json
```

Sanitized aggregate result:
- status: `failed`
- operation: `verifySession`
- advice category: `forbidden`
- HTTP status: `403`
- message: `Failed to fetch Tabbit sign key`
- fixture written: no

This does not satisfy `successful_verifySession_fixture` or `expired_verifySession_fixture`. It could become useful as a `forbidden_403_fixture` only if explicitly persisted through the sanitizer to an approved safe fixture store, but this run intentionally did not write any fixture.

## Current Conclusion

The remaining real evidence gaps cannot be completed from the current default state:

- `successful_verifySession_fixture`: blocked by current 403/sign-key probe result.
- `successful_sendMessage_fixture`: blocked because session verification is not successful.
- `expired_verifySession_fixture`: blocked until a real expired 401/login_required session is observed and sanitized.
- `forbidden_403_fixture`: observed in a no-write sanitized probe, but not persisted because default state writes are disallowed.
- `streaming_text_fixture`, `tool_call_fixture`, and upstream error/cancel/backpressure fixtures: blocked until a valid live session can run `sendMessage` probes and write sanitizer output to an approved fixture store.

No fake evidence should be created to make readiness pass.

## Next Safe Execution Path

After the operator manually refreshes/imports a valid Tabbit cookie/session and confirms a safe writable sanitized fixture store, rerun:

```powershell
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
node bin\tabbit-pool.js probe protocol --account acct_default --operation verifySession --write-fixture --json
node bin\tabbit-pool.js probe protocol --account acct_default --operation sendMessage --input-file <redacted-input.json> --write-fixture --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
node bin\tabbit-pool.js readiness doctor --json
```

For stream boundary evidence, first generate and validate safe input skeletons:

```powershell
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence error_frame --json
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence cancel_after_first_delta --json
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence first_token_backpressure --json
node bin\tabbit-pool.js probe validate --operation sendMessage --input-file <redacted-input.json> --json
```

Only sanitizer output may be persisted. Raw streams, prompts, payloads, cookies, sessions, tokens, and real user data must remain absent from docs, logs, fixtures, and commits.

## Verification Evidence

- `readiness doctor --json` with protocol base/send/session paths configured: blocked; fixture counts remain zero; `manualCookieMode.status` remains `blocked`; `automatedSessionRefresh.requiredForCurrentRelease` remains `false`.
- `fixtures audit --scope session --json`: blocked; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `fixtures audit --scope upstream --json`: blocked; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
- No fixture was written during this execution record.
