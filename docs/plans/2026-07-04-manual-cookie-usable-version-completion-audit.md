# Manual Cookie Usable Version Completion Audit

**Goal:** Prove the current Tabbit manual-cookie operations release target is satisfied by current code, docs, tests, and sanitized aggregate evidence, while keeping future protocol calibration gaps explicit and blocked.

**Scope:** This audit covers the current usable version only:

- User manually registers/logs in to Tabbit.
- User imports cookie/session into the pool.
- `verifySession` identifies valid sessions and 401/login_required expiry.
- Expired accounts become `login_expired`.
- User manually reimports cookie/session after expiry.

This audit explicitly does not claim automatic registration, Yoda/SMS automation, automatic session refresh, Pro claiming, lottery, native upstream tool support, or real upstream stream boundary evidence are complete.

## Safety Boundary

- No raw cookie, session, JWT, API key, Bearer value, raw payload, prompt, stream text, or real user data was printed in this audit.
- No protected path was modified: `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, `.omx/`.
- External state was checked only through aggregate CLI output. Fixture bodies, filenames, account details, and secret refs were not printed.

## Completion Requirements and Evidence

| Requirement | Evidence | Status |
|---|---|---|
| Manual-cookie release definition is documented. | README and real protocol acceptance docs define `manualCookieMode.status=ready` plus `manualCookieMode.blockingMissing=[]` as the current release target. | Satisfied |
| Automated registration, Yoda/SMS automation, and automatic session refresh are not part of the current release. | README, API docs, M08 ops docs, and real protocol acceptance docs state these are not current-release commitments. | Satisfied |
| `automated_session_refresh_strategy` remains visible but not release-blocking. | Doctor-level `manualCookieMode.backlogMissing` and session audit `manualCookieOperations.backlogMissing` retain the gap; `blockingMissing` excludes it. | Satisfied |
| Default stateDir does not fake readiness. | Default aggregate checks remain blocked without real sanitized fixtures. | Satisfied |
| External sanitized state can prove current manual-cookie readiness. | External aggregate checks report doctor ready, `manualCookieMode.status=ready`, and `manualCookieMode.blockingMissing=0`. | Satisfied |
| Real upstream stream boundary gaps remain explicit. | Upstream audit reports missing error-frame, cancellation, and backpressure fixtures until real sanitizer-produced evidence exists. | Satisfied |
| Probe/capture flows avoid raw prompt or payload persistence. | SendMessage capture commands require reviewed input, `probe validate`, and sanitizer-only fixture writes; stream evidence captures only aggregate markers. | Satisfied |
| Tests cover the current release/backlog split. | Observability and ops CLI tests assert `blockingMissing`, `backlogMissing`, plain `release_blocking_missing`, and `backlog_missing`. | Satisfied |
| Full regression suite passes. | Fresh `npm test` reports 425/425 pass. | Satisfied |
| Formatting and safety scans pass. | `git diff --check` exits 0 with only line-ending warnings; forbidden path and credential-shape scans report 0 hits. | Satisfied |

## Fresh Aggregate Verification

Default stateDir with only send/session path env:

- `readiness doctor --json`: `status=blocked`, `remainingWork=9`, `manualCookieMode.status=blocked`, `manualCookieMode.blockingMissing=8`, `manualCookieMode.backlogMissing=1`, `calibrationBacklog.status=blocked`.
- `fixtures audit --scope session --json`: `status=blocked`, missing `successful_verifySession_fixture,expired_verifySession_fixture,automated_session_refresh_strategy`.
- `fixtures audit --scope upstream --json`: `status=blocked`, missing `real_upstream_error_frame_fixture,real_upstream_cancellation_fixture,real_upstream_backpressure_fixture`.

External sanitized state `E:\tabbit2api\output\tabbit-live-state`:

- `readiness doctor --json`: `status=ready`, `remainingWork=0`, `manualCookieMode.status=ready`, `manualCookieMode.blockingMissing=0`, `manualCookieMode.backlogMissing=1`, `calibrationBacklog.status=blocked`.
- `fixtures audit --scope session --json`: `status=blocked`, missing `automated_session_refresh_strategy`.
- `fixtures audit --scope upstream --json`: `status=blocked`, missing `real_upstream_error_frame_fixture,real_upstream_cancellation_fixture,real_upstream_backpressure_fixture`.

Interpretation:

- The current manual-cookie operations release target is satisfied when using the external sanitized evidence state.
- The default stateDir remains safely blocked because it lacks real sanitized fixtures.
- The broader calibration backlog remains blocked by design and must not be converted to ready without real sanitizer output.

## Verification Commands

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check

$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json

$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

## Remaining Backlog

These are explicitly not blockers for the current manual-cookie release target:

- `automated_session_refresh_strategy`
- Yoda/SMS automated registration/login completion evidence
- Pro activity success evidence
- Lottery success evidence
- Real upstream native tool semantics or final productized local tool loop policy beyond the current default
- `real_upstream_error_frame_fixture`
- `real_upstream_cancellation_fixture`
- `real_upstream_backpressure_fixture`

## Final Decision

The manual-cookie operations usable version is complete for the current release definition, provided the operator uses the external sanitized state that contains the required real evidence. Default state readiness remains blocked by design and should stay blocked until equivalent real sanitized fixtures are imported or captured into that state.
