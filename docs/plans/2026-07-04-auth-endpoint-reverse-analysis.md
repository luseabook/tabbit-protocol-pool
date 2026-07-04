# Auth Endpoint Reverse Analysis Plan

**Goal:** Recover the real Tabbit registration/login verification-code endpoint and body shape from public runtime evidence without guessing paths or leaking cookies, sessions, JWTs, API keys, raw payloads, prompts, or real user data.

**Scope:** Reverse analysis only until a concrete endpoint/body/success signal is proven. Do not wire AccountProvisioner or write auth fixtures until the endpoint and body shape are backed by repeatable sanitized evidence.

**Safety rules:**

- Use an isolated browser context if browser automation is needed; do not reuse local browser profile or `tabbit-cookie.txt`.
- Do not print raw HTML, JS bundle contents, request/response bodies, cookies, storage, session, JWT, bearer token, API key, or user data.
- Store only aggregate counts, endpoint path candidates, method candidates, field-key shapes, and sanitized status classifications.
- If a live side effect is required, first prove the request shape through template/validation and record the confirmation step before sending.

## Tasks

1. Baseline current state:
   - Confirm working tree is dirty and only this plan plus scoped reverse-analysis artifacts are touched.
   - Re-run external aggregate readiness only.

2. Static public asset analysis:
   - Fetch `/login` and script asset URLs without saving raw sources.
   - Extract API path string literals and auth-like string-context candidates.
   - Report only endpoint strings, method hints, and field-key names.

3. Dynamic isolated browser analysis:
   - Open `/login` in an isolated context if tooling is available.
   - Hook fetch/XHR request metadata, not bodies.
   - Trigger visible login/register controls if present.
   - Record only URL path, method, status, resource type, and request/response field-key shape.

4. Candidate validation:
   - If auth send/submit endpoint candidates are found, create redacted probe input outside sensitive paths.
   - Run `probe validate` before any live send.
   - Only after body safety review, run a confirmed side-effect probe and write sanitized fixture to `tmp/live-fixtures`.

5. TDD implementation if evidence is found:
   - Write failing tests for the exact endpoint/body/success shape.
   - Implement minimal wiring in `ProtocolTabbitClient` / `AccountProvisioner`.
   - Update docs and run required verification.

## Evidence Log

### Static Public Asset Analysis

- `/login` public HTML loaded with HTTP 200 and 28 script assets from `cdn.tabbit.ai`.
- Exact auth-like endpoint candidates found in the login page chunk:
  - `POST /proxy/v0/oauth/send-verification-code`
  - `POST /proxy/v0/oauth/login`
  - `POST /proxy/v0/oauth/third-party-login`
  - `GET /proxy/v0/user/base-info`
- Invitation helper endpoints found separately:
  - `POST /activity/v2/invitation/validate-code`
  - `POST /activity/v2/invitation/records/login`
  - `POST /activity/v2/invitation/records/register`
- Nearby field-key evidence:
  - send-code/login flow uses `mobile`, `type`, `uuid`, and login submit uses `smsCode`.
  - third-party login uses `id_token` plus invitation fields.
  - static captcha/Yoda evidence includes `window.YodaSeed`, `openYodaCaptcha`, and `https://s0.meituan.net/mxx/yoda/yoda.seed.js`.

### Login Page Chunk Reversal

- Browser execution still rewrites `/login` to the product page, but direct HTTP retrieval of `/login` returns a real login HTML document with 28 scripts and a preload for `https://s0.meituan.net/mxx/yoda/yoda.seed.js`.
- The dedicated login page chunk is `app/login/page-efa9456a2a9f4843.js`.
- Static code evidence from that chunk proves the browser body shape:
  - `sendVerificationCode`: `POST /proxy/v0/oauth/send-verification-code` with JSON keys `uuid`, `platform`, `version`, `app`, and `mobile`.
  - `submitRegistrationOrLogin`: `POST /proxy/v0/oauth/login` with JSON keys `uuid`, `platform`, `version`, `app`, `mobile`, `smsCode`, and optional `channel`.
  - Browser constants are `platform:"1"`, `version:""`, and `app:"1000"`.
  - `uuid` is not the Yoda result; it is generated once per login component as a 64-character random alphanumeric client value and reused by send-code/login.
  - `sendVerificationCode` uses only `Content-Type: application/json`; `submitRegistrationOrLogin` uses the same content type plus optional `x-tabbit-primary-account-id` if the browser primary-account API is available.
- Yoda flow evidence:
  - The first send-code attempt can return an error body containing `data.verifyUrl` and `data.requestCode`.
  - When both fields exist, the browser calls `window.YodaSeed({ requestCode, succCallbackFun, failCallbackFun, root:"verify-container" })`.
  - No code evidence shows the Yoda widget replacing `uuid`; therefore success calibration still requires a real widget completion and a second send-code outcome before any success fixture can be counted.

### Dynamic Browser Analysis

- Isolated headless Chrome opened `/login` with empty storage and no reused profile.
- Runtime route ended at `/` and showed no visible login input fields, so browser interaction could not safely trigger the login form in this environment.
- No cookies, storage, browser profile, request body, or response body was saved.

### Direct Endpoint Shape Validation

- Direct browser-style JSON POST to `/proxy/v0/oauth/send-verification-code` reached server-side validation:
  - body keys `mobile,type` returned 422 with missing `uuid`.
  - body keys `mobile,type,uuid` returned 422 body-level `value_error`, indicating `uuid` is a captcha/Yoda challenge value, not an arbitrary UUID.
- Direct browser-style JSON POST to `/proxy/v0/oauth/login` reached server-side validation:
  - body keys `mobile,code,type` returned missing `uuid` and `smsCode`.
  - body keys `mobile,smsCode,type,uuid` returned body-level `value_error`, again consistent with an invalid captcha/Yoda challenge value.

### RED / GREEN Implementation

- RED: `node --test --test-name-pattern "proxy oauth auth endpoints" test\protocol-tabbit-client.test.js` failed because the proxy auth path still fetched `/chat/sign-key`.
- GREEN: `/proxy/v0/oauth/*` auth paths now POST browser JSON without sign-key headers while preserving existing signed auth behavior for non-proxy paths.
- RED: `node --test --test-name-pattern "proxy oauth auth validation errors" test\protocol-tabbit-client.test.js` failed because `resultFromError()` did not expose top-level `category/httpStatus`, causing probe runner to misclassify 422 validation as `protocol_changed`.
- GREEN: `resultFromError()` now includes top-level `category`, `code`, `message`, `retryable`, `cooldownMs`, and `httpStatus` while retaining the structured `error`.
- RED/GREEN safety: auth captcha challenge fields (`uuid`, `smsCode`, `captchaToken`) are now fully redacted in protocol probe fixtures.

### Current RED / GREEN Target

- RED: add protocol client tests proving proxy OAuth auth can be called with phone-number input and no email placeholder, builds the calibrated browser JSON body, and reuses a 64-character auth client uuid across send/login calls.
- RED: update `probe template --operation sendVerificationCode` and `submitRegistrationOrLogin` expectations to use the calibrated mobile/body key shape with `confirmSideEffect:false`.
- RED: extend fixture sanitizer coverage for Yoda challenge fields such as `requestCode` and `verifyUrl` before running any live probe that might return them.
- GREEN: implement only body construction, input validation, sanitizer hardening, and template/documentation updates. Do not mark auth success ready until a real send-code delivery signal and submit session-material fixture exist.

### Sanitized Live Probe Evidence

- `probe protocol --operation sendVerificationCode` with body keys `mobile,type,uuid` now writes a sanitized failed fixture with:
  - `adviceCategory=invalid_request`
  - `resultHttpStatus=422`
- `probe protocol --operation submitRegistrationOrLogin` with body keys `mobile,smsCode,type,uuid` now writes a sanitized failed fixture with:
  - `adviceCategory=invalid_request`
  - `resultHttpStatus=422`
- These fixtures prove endpoint/method/body-key validation reaches the real upstream, but they do not satisfy auth success coverage because Yoda/captcha completion and real delivery/session material are still missing.

### Current Blocker

Auth endpoint and body-key shape are no longer unknown. The remaining auth blocker is successful Yoda/captcha-backed verification-code delivery and a real `smsCode` submit response containing importable session material.

### 2026-07-04 Isolated Browser Recheck

- Opened `https://web.tabbit.ai/login` in a fresh isolated browser context with no reused local profile and no imported cookies.
- Runtime URL rewrote to `https://web.tabbit.ai/?ct=login`.
- Accessibility snapshot exposed only the public product landing content and a single external-site button; no mobile, email, verification-code, registration, or login input fields were present.
- XHR/fetch metadata contained telemetry only; no `/proxy/v0/oauth/*`, `/api/auth/*`, email, or verification-code endpoint was triggered by page load.
- Current Web evidence still supports only the static login chunk finding: the recoverable first-party auth flow is mobile SMS plus Yoda challenge (`/proxy/v0/oauth/send-verification-code` and `/proxy/v0/oauth/login`). No browser/static evidence for email registration/login was found.

No raw request body, response body, cookie, session, JWT, bearer token, API key, telemetry identifier, browser profile data, prompt, or real user data was recorded.
