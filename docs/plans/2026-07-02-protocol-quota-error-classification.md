# Protocol Quota Error Classification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Classify Tabbit quota/usage/credit exhaustion signals as `quota_exhausted` so the account pool can mark the current account and fallback to another account.

**Architecture:** Keep endpoint discovery unchanged. Improve only `classifyProtocolError()` by inspecting stable body/code/message signals before generic 429/5xx status mapping. Network/rate-limit/upstream errors without quota signals keep their existing categories.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolTabbitClient` tests.

---

### Task 1: RED test for quota signals

**Files:**
- Modify: `test/protocol-tabbit-client.test.js`

**Step 1: Write failing test**

Add a test asserting that a 429 response body with `code:"QUOTA_EXHAUSTED"` and quota exhaustion text maps to:

```js
{
  category: "quota_exhausted",
  status: 429,
  code: "QUOTA_EXHAUSTED",
  message: "Current account quota exhausted",
  retryable: true,
  cooldownMs: 0,
}
```

**Step 2: Run RED**

```powershell
node --test test/protocol-tabbit-client.test.js
```

Expected: FAIL because the current implementation maps the response to `rate_limited`.

---

### Task 2: Implement quota signal priority

**Files:**
- Modify: `src/protocol-tabbit-client.js`

**Step 1: Add signal matcher**

Add a helper that checks code/message/reason/type/data for `QUOTA_EXHAUSTED`, `INSUFFICIENT_QUOTA`, `USAGE_LIMIT_EXCEEDED`, `CREDIT_EXHAUSTED`, or quota/credit/usage text combined with exhausted/insufficient/depleted/limit/used up.

**Step 2: Apply before generic status mapping**

After 401 login handling and before 403/429/5xx mapping, return `quota_exhausted` with `retryable:true` and `cooldownMs:0`.

**Step 3: Run GREEN**

```powershell
node --test test/protocol-tabbit-client.test.js
```

---

### Task 3: Documentation and verification

**Files:**
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`

Document that quota signals are account-local and take priority over generic 429/5xx status categories.

---

## Implementation and verification evidence

Implemented:

- Added RED test `classifyProtocolError maps quota exhaustion signals to account-local fallback`.
- Added quota signal matcher in `src/protocol-tabbit-client.js`.
- Kept ordinary 5xx upstream errors classified as `upstream_error` by changing the existing test fixture away from quota wording.
- Updated protocol docs and test-case docs.

Verified:

```powershell
cd E:\tabbit2api\tabbit-protocol-pool
node --test test/protocol-tabbit-client.test.js
# RED before implementation: fail: 1, actual category rate_limited
# GREEN after implementation: pass: 16, fail: 0

node --test test/protocol-tabbit-client.test.js test/account-pool.test.js test/pooled-request-runner.test.js
# pass: 33, fail: 0

npm test
# tabbit-protocol-pool: pass: 156, fail: 0

cd E:\tabbit2api
npm test
# root gateway: pass: 226, fail: 0
```

Documentation quality scans:

- Markdown local link scan over `tabbit-protocol-pool/**/*.md`: 68 Markdown files, 0 broken local links. The scanner strips fenced and inline code before checking links to avoid treating TypeScript tuple/generic syntax as Markdown links.
- Sensitive placeholder scan over Markdown: 68 Markdown files, 0 live-format secret hits. Public examples keep using `sk-tabbit-local`.
- Trailing whitespace scan over `tabbit-protocol-pool`: 106 text files, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: passed with no output. The subtree is still untracked in the root worktree, so the custom trailing-whitespace scan above is the effective check for current file contents.
