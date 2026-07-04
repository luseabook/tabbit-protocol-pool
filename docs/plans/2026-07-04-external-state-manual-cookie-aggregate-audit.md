# External State Manual Cookie Aggregate Audit

**Goal:** Verify whether the known external sanitized state can satisfy the current manual-cookie operations release target without printing fixture bodies or writing any state.

**Scope:** Read-only aggregate CLI checks against `E:\tabbit2api\output\tabbit-live-state`. This record does not list fixture files, does not show fixture content, does not run protocol probes, and does not write readiness marks, account state, or protocol fixtures.

**Safety rules:**

- Do not print or persist real cookie, session, JWT, API key, Bearer value, raw payload, prompt, stream text, or real user data.
- Do not modify `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/`.
- Only report aggregate status, counts, and missing evidence names.

## Plan

1. Set the external sanitized state directory and explicit protocol path env needed by readiness/audit.
2. Run aggregate `readiness doctor --json`.
3. Run aggregate `fixtures audit --scope session --json`.
4. Run aggregate `fixtures audit --scope upstream --json`.
5. Record only status, counts, and missing evidence names.

## Commands

```powershell
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

## Aggregate Evidence

- External state exists.
- `readiness doctor --json` aggregate:
  - `status=ready`
  - `remainingWork=0`
  - `manualCookieMode.status=ready`
  - `manualCookieMode.blockingMissing=0`
  - `manualCookieMode.backlogMissing=1`
  - `calibrationBacklog.status=blocked`
- `fixtures audit --scope session --json` aggregate:
  - `status=blocked`
  - `missing=automated_session_refresh_strategy`
  - `manualCookieOperations.blockingMissing=[]`
  - `manualCookieOperations.backlogMissing=automated_session_refresh_strategy`
- `fixtures audit --scope upstream --json` aggregate:
  - `status=blocked`
  - `missing=real_upstream_error_frame_fixture,real_upstream_cancellation_fixture,real_upstream_backpressure_fixture`
  - `counts.streamEvidenceNotCaptured=0`

## Conclusion

The external sanitized state proves the current manual-cookie operations release target: the user-imported-cookie workflow has the required current-release evidence and `manualCookieMode.blockingMissing` is empty. This does not complete the broader calibration backlog. Automated session refresh remains a backlog enhancement, and real upstream error-frame, cancellation, and backpressure evidence remain blocked until sanitizer-produced real upstream fixtures exist.

The default stateDir remains blocked because it does not contain the same real sanitized fixture evidence. No fake fixture should be created to make default readiness pass.
