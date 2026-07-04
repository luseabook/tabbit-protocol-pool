# Local Tool Loop Guardrails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Productize the optional local tool loop boundary with explicit allowlist, round limit, per-tool timeout, output truncation, and Chat/Responses/Anthropic gateway regression coverage.

**Architecture:** Keep the default `client_executes_tools_first` strategy unchanged. Extend `LocalToolLoopRunner` with policy inputs that only apply when `mode:"local_executes_tools"` and a host-injected executor exists. Wire the policy from `loadConfig()` into `createProtocolPoolGateway()` so deployments can set guardrails through env without adding any built-in tools or touching real Tabbit protocol traffic.

**Tech Stack:** Node.js ESM, native `node:test`, existing `LocalToolLoopRunner`, `loadConfig()`, `createProtocolPoolGateway()`, OpenAI/Anthropic compat handlers, and docs under `docs/`.

---

### Task 1: RED Runner Policy Tests

**Files:**
- Modify: `test/local-tool-loop-runner.test.js`

**Step 1: Write allowlist failing test**

Add a test named `local_executes_tools rejects tool definitions outside the configured allowlist`.

Instantiate `LocalToolLoopRunner` with:

```js
new LocalToolLoopRunner({
  runner: { async run() { throw new Error("should not call base runner"); } },
  mode: "local_executes_tools",
  allowedToolNames: ["lookup_weather"],
  executeToolUse: async () => "unused",
});
```

Call `run()` with a tool definition named `delete_file`.

Expected:

- `result.ok === false`
- `result.error.category === "invalid_request"`
- `result.error.code === "LOCAL_TOOL_NOT_ALLOWED"`
- base runner and executor are not called.

**Step 2: Write timeout failing test**

Add a test named `local_executes_tools times out slow injected tools`.

Use a base runner that emits one `tool_use`, an executor that never resolves, and `toolTimeoutMs: 5`.

Expected:

- `result.ok === false`
- `result.error.category === "timeout"`
- `result.error.code === "LOCAL_TOOL_TIMEOUT"`
- elapsed time is bounded.

**Step 3: Run RED**

Run:

```powershell
node --test test\local-tool-loop-runner.test.js --test-name-pattern "allowlist|times out"
```

Expected: FAIL because `allowedToolNames` and `toolTimeoutMs` are not implemented.

### Task 2: RED Config and Gateway Tests

**Files:**
- Modify: `test/config.test.js`
- Modify: `test/protocol-pool-gateway.test.js`

**Step 1: Write config failing test**

Add `loadConfig parses local tool loop guardrail env`.

Input env:

```js
{
  TABBIT_POOL_TOOL_LOOP_MODE: "local_executes_tools",
  TABBIT_POOL_LOCAL_TOOL_ALLOWLIST: "lookup, summarize",
  TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS: "2",
  TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS: "50",
  TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS: "12",
}
```

Expected `config.compat.localToolLoop` contains:

- `allowedToolNames: ["lookup", "summarize"]`
- `maxRounds: 2`
- `toolTimeoutMs: 50`
- `maxToolResultChars: 12`

Also reject invalid non-positive integer values.

**Step 2: Write gateway failing test**

Add a gateway test named `gateway local tool loop applies env guardrails across Chat Responses and Anthropic`.

Create one gateway with env:

```js
TABBIT_POOL_TOOL_LOOP_MODE=local_executes_tools
TABBIT_POOL_LOCAL_TOOL_ALLOWLIST=lookup
TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS=2
TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS=100
TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS=8
```

Use `protocolClientFactory().sendMessage()` that first emits a `tool_use` for `lookup`, then returns final text after a tool result.

Send requests to:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

Expected:

- all three succeed with final text.
- protocol client never receives native `tools/toolChoice/parallelToolCalls`.
- executor receives only allowlisted `lookup`.
- appended tool result content is truncated to 8 chars plus the truncation marker.

**Step 3: Run RED**

Run:

```powershell
node --test test\config.test.js --test-name-pattern "local tool loop guardrail"
node --test test\protocol-pool-gateway.test.js --test-name-pattern "env guardrails"
```

Expected: FAIL until config and gateway wiring exist.

### Task 3: Implement Guardrails

**Files:**
- Modify: `src/local-tool-loop-runner.js`
- Modify: `src/config.js`
- Modify: `src/protocol-pool-gateway.js`

**Step 1: Add runner policy options**

Add constructor options:

- `allowedToolNames = []`
- `toolTimeoutMs = 0`

Normalize allowlist as a `Set` of non-empty names. If allowlist is non-empty, reject any submitted tool definition outside the allowlist before calling the base runner.

**Step 2: Add executor timeout**

Wrap `executeToolUse()` with a timeout only when `toolTimeoutMs > 0`. On timeout return `PooledRequestError` with:

- `category:"timeout"`
- `code:"LOCAL_TOOL_TIMEOUT"`
- `retryable:false`

Do not append partial tool result after timeout.

**Step 3: Wire config**

In `loadConfig()`, parse:

- `TABBIT_POOL_LOCAL_TOOL_ALLOWLIST` comma-separated names.
- `TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS`.
- `TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS`.
- `TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS`.

Store under `config.compat.localToolLoop`.

**Step 4: Wire gateway**

Pass `config.compat.localToolLoop` into `new LocalToolLoopRunner(...)` while preserving explicit `options.toolLoopRunner` override.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/11-Codex-Claude与三方工具接入.md`
- Modify: `docs/modules/M06-兼容网关/_M06-兼容网关.md`
- Modify: `docs/modules/M06-兼容网关/启动工厂.md`
- Modify: `docs/modules/M07-配置密钥/_M07-配置密钥.md`

**Step 1: Document strategy**

Clarify:

- Default remains `client_executes_tools_first`.
- `local_executes_tools` remains opt-in and requires injected executor.
- No built-in shell/web/js/fetch tools are provided.
- Allowlist, max rounds, timeout, and result truncation are env-configurable.

**Step 2: Update remaining work**

Record that local loop guardrails are productized locally; true upstream private tool semantics remain an evidence gap unless future captures prove a private protocol.

### Task 5: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused tests**

Run:

```powershell
node --test test\local-tool-loop-runner.test.js
node --test test\config.test.js
node --test test\protocol-pool-gateway.test.js
```

**Step 2: Required regression tests**

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 3: External state read-only check**

Run readiness doctor/readiness/default fixture audit against `E:\tabbit2api\output\tabbit-live-state`.

**Step 4: Secret boundary**

Run forbidden-path and sensitive-token scans. Confirm no forbidden local files were touched.
