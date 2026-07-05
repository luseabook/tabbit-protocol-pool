# Chat Session Auto-Create

**Goal:** Make restored Tabbit `/api/v1/chat/completion` traffic usable when an account has a valid browser session but no pre-imported `chatSessionId`.

**Root cause before this slice:** Tabbit Web does not send a message from a blank state with only cookies. It first creates a chat session through a Next Server Action, then sends `/api/v1/chat/completion` with the returned `chat_session_id`. Before this fix, the gateway required that id to be imported manually, so it failed locally with `MISSING_CHAT_SESSION_ID` before making any upstream send request.

**Evidence:**

- `acct_default` in the live state passes read-only session verification.
- `accounts list --json` reports `chatSessionConfigured:false`.
- Before the fix, `sendMessage` with restored `/api/v1/chat/completion` failed before network with `MISSING_CHAT_SESSION_ID`.
- Public Tabbit chunks expose `createNewSession` as Next Server Action `00b19386a3892f62370bef2ffacfbd5b58580fcb2a`.
- A sanitized live replay using the stored account cookie succeeded with:
  - `POST /newtab`
  - `Accept: text/x-component`
  - `Content-Type: text/plain;charset=UTF-8`
  - `Next-Action: 00b19386a3892f62370bef2ffacfbd5b58580fcb2a`
  - `Next-Router-State-Tree` for `/newtab`
  - body `[]`
- The action returned a UUID-shaped session id, and a follow-up restored chat completion with that id succeeded.

**Architecture:**

- Add a narrow `ProtocolTabbitClient.createChatSession()` method for the observed Next Server Action transport.
- Keep the session id internal to runtime results; do not print or fixture raw ids.
- Let restored `sendMessage()` auto-create a session only when no explicit/account/default id exists and auto-create is configured.
- Expose explicit config keys so the action path or id can be changed if Tabbit redeploys:
  - `TABBIT_POOL_PROTOCOL_CHAT_SESSION_CREATE_PATH`
  - `TABBIT_POOL_PROTOCOL_CHAT_SESSION_CREATE_ACTION_ID`
  - `TABBIT_POOL_PROTOCOL_CHAT_SESSION_AUTO_CREATE`
- Readiness should treat restored chat completion as having usable chat-session context when auto-create is configured, while still reporting the distinction in evidence.

**TDD plan:**

1. Add a failing protocol-client test that `createChatSession()` POSTs the observed Server Action request and parses the referenced action result chunk.
2. Add a failing protocol-client test that restored `sendMessage()` auto-creates a session before building `/api/v1/chat/completion`.
3. Add config/readiness tests for the new env keys and `chatSessionAutoCreateConfigured` evidence.
4. Implement the minimal code to pass, then run focused suites and a live sanitized smoke.

**Verification target:**

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT = "powershell"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js probe protocol --account acct_default --operation sendMessage --input-json '{"model":"tabbit/priority","messages":[{"role":"user","content":"gateway local diagnostic ping"}]}' --json
```

**Implementation notes:**

- `ProtocolTabbitClient.createChatSession()` sends the calibrated Next Server Action request and parses the React Flight action result.
- Restored `sendMessage()` auto-creates a chat session only when the request/account/default config does not already provide one.
- Config defaults enable auto-create with public protocol defaults, while safe local defaults keep the action path/id null and auto-create disabled.
- CLI/gateway client factories pass the new chat-session action config into `ProtocolTabbitClient`.
- Readiness now reports `chatSessionContext.autoCreateConfigured` separately from imported/default chat-session ids.
- Probe sanitization redacts auto-created chat-session ids, raw SSE event payloads, prompt-derived tool queries, and stream text before printing or writing fixtures.

**Verified 2026-07-05:**

- Focused and entrypoint tests passed for protocol client, config, observability, protocol probe sanitization, ops CLI, and protocol-pool gateway.
- Live readiness with the existing sanitized state reported core status `ready`, `chatSessionContext.configured:true`, `activeAccountsWithChatSession:0`, and `autoCreateConfigured:true`.
- Live `sendMessage` probe against `acct_default` succeeded without a pre-imported chat session id; sanitized summary showed `selectedModel:Default`, `rawKind:stream`, `rawFormat:sse`, and redacted raw event data.
- The live probe output was checked for prompt leakage and UUID-shaped session/message id leakage before accepting the result.
- A live local `/v1/chat/completions` gateway request returned HTTP 200 with OpenAI `chat.completion` shape, one assistant choice, and no `chat_session` fields in the response.
