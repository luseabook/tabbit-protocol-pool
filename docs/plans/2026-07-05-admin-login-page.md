# Admin Login Page

## Scope

Replace the reverse-proxy Basic Auth prompt with an in-app `/admin` login form while preserving the existing gateway API key path for scripts. The same admin surface now includes the minimal account pool and request key management controls operators expect after login.

## Behavior

- `GET /admin` serves a Chinese login shell with username and password fields.
- The unauthenticated state renders as a dedicated admin login screen, not as the normal console topbar with panels hidden by accident. It shows the system identity, controlled-access status, username/password labels, and a concise HTTPS/session context.
- The browser keeps the Basic credential payload only in the current page memory after a successful login; no configured credential is embedded in the HTML, and refresh/logout returns to the locked view.
- Operational panels remain hidden until authentication succeeds. Logout, missing credentials, and authentication failure clear any previously rendered status HTML.
- After authentication succeeds, the username/password form is hidden and only the logout action remains visible.
- After authentication succeeds, `/admin` behaves as an admin console rather than a single web status page: the left menu switches real views (`总览`, `账号池`, `请求 Key`, `运行摘要`) and only one view is visible at a time.
- `GET /admin/api/status` accepts either configured admin username/password via `Authorization: Basic ...` or the existing gateway API key via `Authorization: Bearer ...` / `x-api-key`.
- `GET /admin/api/accounts` returns the account pool as redacted display records only.
- `POST /admin/api/accounts/import-session` writes the submitted session to the state secret store and persists only `cookieJarRef` plus account metadata. `accountId` is optional in the admin UI/API; when it is omitted the gateway generates a safe `acct_<random>` id. Session material remains required.
- `POST /admin/api/accounts/status` updates account status in `accounts.json` and the running account pool.
- `GET /admin/api/key` returns the current gateway request key only after admin username/password authentication, so the Key management view can render a masked key field with eye-toggle reveal and copy controls.
- `POST /admin/api/key/rotate` writes a new gateway request key to `secrets/gateway-api-key.txt`, updates the running gateway key, and returns the new key only to the authenticated admin console for immediate display/copy.
- `/v1/*` compatibility routes continue to require the gateway API key and do not accept admin username/password.
- `TABBIT_POOL_ADMIN_USERNAME` and `TABBIT_POOL_ADMIN_PASSWORD` configure the page login credentials.

## Safety

The status and account APIs remain aggregate/redacted-only and must not return cookies, sessions, tokens, `cookieJarRef`, full account emails, prompts, or raw fixture payloads. Key plaintext is allowed only on the dedicated Key management API/view after admin username/password authentication; the UI must mask it by default, reveal it only after an explicit eye-toggle action, and support copy without printing it elsewhere. Production access should stay behind HTTPS. Production smoke checks should not call the key rotation endpoint unless the operator explicitly intends to rotate the live request key.

## Verification

Targeted red/green checks:

- `node --test test\http-server.test.js --test-name-pattern "admin"`
- `node --test test\config.test.js --test-name-pattern "loadConfig"`
- `node --test test\protocol-pool-gateway.test.js --test-name-pattern "admin"`

Full regression and deployment verification should additionally run `npm test`, `git diff --check`, forbidden-path scan, credential-shape scan, and remote `/admin` / `/admin/api/status` smoke checks after nginx is updated to proxy `/admin` without proxy-level Basic Auth.
