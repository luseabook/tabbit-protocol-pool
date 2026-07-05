# Node Edge Fetch Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Tabbit gateway able to use an outbound HTTP transport that Tabbit's edge accepts when Node's native fetch is rejected before protocol signing can proceed.

**Architecture:** Keep protocol fields, account state, and signing logic unchanged. Add a small fetch-compatible transport backed by PowerShell/.NET on Windows, then wire it through config and the existing protocol client factories so operators can select it explicitly without leaking cookies or request bodies through logs or process arguments.

**Tech Stack:** Node.js ES modules, node:test, child_process spawn, PowerShell 7 Invoke-WebRequest, Web Fetch Response.

---

## Root-Cause Evidence

- `accounts probe acct_default --read-only --json` fails before session verify with `SESSION_INVALID` / `Failed to fetch Tabbit sign key`.
- Node `fetch()` to `https://web.tabbit.ai/`, `/?ct=chat%2Fnew`, `/chat/sign-key`, and `/api/v0/user/base-info` returns `403 text/html` with title `Service Unavailable`.
- Node `http2.connect()` to `/chat/sign-key` also returns the same `403`.
- `curl.exe` returns the same `403`.
- PowerShell 7 `Invoke-WebRequest` on the same host returns `200 text/plain` for `/chat/sign-key`, and `200 application/json` for `/proxy/v1/model_config/models?a=0&scene=chat`; unauthenticated `/api/v0/user/base-info` returns the expected JSON `401`.
- Changing Node request headers and clearing `NODE_EXTRA_CA_CERTS` did not change the `403`.

Conclusion: the current gateway is not failing because of account tier or request body shape at this stage. It is failing because Tabbit's edge rejects the Node/curl outbound client stack before the gateway can fetch the sign key.

## Task 1: Fetch Transport Unit Coverage

**Files:**
- Create: `src/powershell-fetch.js`
- Create: `test/powershell-fetch.test.js`

**Step 1: Write the failing test**

Add tests for:

- `powershellFetch(url, options, { command })` passes URL, method, headers, and body to the child process through stdin.
- The child process command line does not include header values or body text.
- It returns a standard `Response` with `status`, `ok`, `headers.get()`, `text()`, and `json()`.
- Non-zero child exit produces a redacted error that does not include Cookie, Authorization, raw body, or prompt text.

**Step 2: Run test to verify it fails**

Run:

```powershell
node --test test\powershell-fetch.test.js
```

Expected: FAIL because `src/powershell-fetch.js` does not exist.

**Step 3: Write minimal implementation**

Implement:

- `createPowerShellFetch({ command = "pwsh", timeoutMs = 30000 } = {})`.
- `powershellFetch(url, options)` as a convenience export.
- Serialize request details as JSON to child stdin, never as command arguments.
- Use `Invoke-WebRequest -SkipHttpErrorCheck -MaximumRedirection 0` in the child script.
- Encode the response body as base64 in child output and construct a Web `Response` in Node.

**Step 4: Run test to verify it passes**

Run:

```powershell
node --test test\powershell-fetch.test.js
```

Expected: PASS.

## Task 2: Config and Gateway Wiring

**Files:**
- Modify: `src/config.js`
- Modify: `src/protocol-pool-gateway.js`
- Modify: `src/ops-cli.js`
- Modify: `test/config.test.js`
- Modify: `test/protocol-pool-gateway.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Write failing tests**

Add tests for:

- `TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT=powershell` is accepted and stored at `config.protocol.fetchTransport`.
- Invalid transport values fail config loading.
- Gateway default protocol client uses PowerShell fetch when protocol config selects it.
- CLI account probe factory also uses the selected transport.
- Explicit injected `fetch` still wins over env transport in tests.

**Step 2: Run focused tests to verify failure**

Run:

```powershell
node --test test\config.test.js test\protocol-pool-gateway.test.js test\ops-cli.test.js
```

Expected: FAIL because config/factory wiring is missing.

**Step 3: Implement minimal wiring**

Add:

- Valid transports: `node`, `powershell`.
- Default remains `node` unless env explicitly selects `powershell`.
- `configuredProtocolClientOptions()` carries `fetchTransport`.
- Factories choose `createPowerShellFetch()` only when no explicit `fetch` was injected.

**Step 4: Run focused tests to verify pass**

Run:

```powershell
node --test test\config.test.js test\protocol-pool-gateway.test.js test\ops-cli.test.js
```

Expected: PASS.

## Task 3: Live Minimal Probe

**Files:**
- No protected files touched.

**Step 1: Run sign-key transport probe**

Run:

```powershell
$env:TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT = "powershell"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
node bin\tabbit-pool.js accounts probe acct_default --read-only --json
```

Expected: The failure point must move past `Failed to fetch Tabbit sign key`. If the account session is stale, the expected failure is a session/login response from `/api/v0/user/base-info`, not the edge HTML 403.

**Step 2: Clear temporary env vars**

Run:

```powershell
Remove-Item Env:TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT -ErrorAction SilentlyContinue
Remove-Item Env:TABBIT_POOL_PROTOCOL_ENABLED -ErrorAction SilentlyContinue
```

## Task 4: Final Verification

Run:

```powershell
node --test test\powershell-fetch.test.js
node --test test\config.test.js test\protocol-pool-gateway.test.js test\ops-cli.test.js
npm test
git diff --check
```

Also run protected-path and credential-shape scans over changed files. Report exact results and whether `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/` were touched.

## 2026-07-05 Live Verification Notes

- `createPowerShellFetch()` against `https://web.tabbit.ai/chat/sign-key` returned `200 text/plain` with a 32-character body; the key value was not printed.
- `TABBIT_POOL_PROTOCOL_ENABLED=true` plus `TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT=powershell` made `accounts probe acct_default --read-only --json` return `verifySession` success. This proves the prior `Failed to fetch Tabbit sign key` blocker was the Node/curl outbound HTTP stack being rejected by Tabbit edge.
- `probe protocol --operation listModels` with the same transport returned the live model catalog and included `Claude-Opus-4.8`.
- A temporary local gateway smoke returned `/v1/models` status `200`, model count `24`, bare `Claude-Opus-4.8` present, and `tabbit/Claude-Opus-4.8` absent.
- Before chat-session auto-create was implemented, a send smoke without `TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID` returned local `MISSING_CHAT_SESSION_ID`.
- A send smoke with a generated UUID-shaped temporary chat session id moved past local validation but returned upstream `503 upstream_error` / `AI service temporarily unavailable, please try again later` for `Default`; the subsequent `Claude-Opus-4.8` attempt saw `NO_AVAILABLE_ACCOUNT` because the first upstream error put the only local account into short cooldown.
- The cooldown was restored to `active` by a successful `accounts probe acct_default --json`; the local account still records the smoke-created `failureStreak: 2` and an expired `cooldownUntil`, which are live-state audit traces from this investigation.
- Static chunk search across the current Next runtime found `/api/v1/chat/session/fork` and `/session/:id`; it did not find a client-side `/api/v1/chat/completion` literal in the downloaded chunks. This leaves the remaining send-stage root cause evidence-gated on comparing a logged-in browser successful request against the gateway request, especially `chat_session_id`, `x-req-ctx`, `selected_model`, cookies/session material, and any bridge-only headers.
- Follow-up implementation added `accounts import-session --chat-session-id <id>` so an operator can persist a reviewed browser chat session id in account metadata instead of relying only on process-wide `TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID`. The id is used by the existing `ProtocolTabbitClient` account-field lookup and remains hidden from CLI JSON/plain output.
- Follow-up root-cause check on `E:\tabbit2api\output\tabbit-live-state` showed `acct_default` still passed read-only `verifySession`, but `accounts list --json` reported `chatSessionConfigured:false`. At that point, a send probe without a chat session failed locally before network with `MISSING_CHAT_SESSION_ID`, and readiness treated real `/api/v1/chat/completion` as blocked on `chat_session_context` unless an active account had `chatSessionId` or `TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID` configured.
- Superseding follow-up: `docs/plans/2026-07-05-chat-session-auto-create.md` restores this path by calling the calibrated `/newtab` Next Server Action when no explicit/account/default chat session id is present. Current readiness accepts `chatSessionContext.autoCreateConfigured:true` as usable chat-session context while still reporting whether an imported/default id exists.
