# Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first runnable foundation for Tabbit Protocol Pool: Node ESM project skeleton, safe configuration/redaction, and a testable YYDS Mail client.

**Architecture:** Start with modules that do not require live Tabbit reverse engineering. M07 configuration and redaction provide the safety boundary for every later module. M03 YYDS Mail is implemented behind dependency-injected fetch/sleep functions so unit tests can verify request construction, retries, and code extraction without network access.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `assert/strict`, global fetch-compatible dependency injection.

---

### Task 1: Project skeleton

**Files:**
- Create: `tabbit-protocol-pool/package.json`
- Create: `tabbit-protocol-pool/src/index.js`
- Create: `tabbit-protocol-pool/test/smoke.test.js`

**Step 1: Write the failing test**

Create `test/smoke.test.js` that imports the package entry and asserts it exposes `loadConfig`, `redactSensitiveValue`, and `YYDSMailProvider`.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && npm test`
Expected: FAIL because `src/index.js` or exports are missing.

**Step 3: Write minimal implementation**

Add `package.json` and `src/index.js` with placeholder exports only after the failing test is observed.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

### Task 2: Config and redaction

**Files:**
- Create: `tabbit-protocol-pool/src/config.js`
- Create: `tabbit-protocol-pool/src/redact.js`
- Create: `tabbit-protocol-pool/test/config.test.js`
- Create: `tabbit-protocol-pool/test/redact.test.js`

**Step 1: Write failing tests**

Cover defaults, environment overrides, integer validation, missing YYDS key behavior, and redaction for API keys/cookies/emails/verification codes.

**Step 2: Run tests to verify they fail**

Run: `cd tabbit-protocol-pool && npm test`
Expected: FAIL because modules are missing.

**Step 3: Write minimal implementation**

Implement `loadConfig(env, options)`, `normalizePort(value, fallback)`, `redactSensitiveValue(value)`, and `redactObject(value)`.

**Step 4: Run tests to verify they pass**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

### Task 3: YYDS Mail client request construction

**Files:**
- Create: `tabbit-protocol-pool/src/yyds-mail-provider.js`
- Create: `tabbit-protocol-pool/test/yyds-mail-provider.test.js`

**Step 1: Write failing tests**

Cover `createInbox()` request method/path/body/auth header, standard error envelope handling, and `429 Retry-After` normalization.

**Step 2: Run tests to verify they fail**

Run: `cd tabbit-protocol-pool && npm test`
Expected: FAIL because `YYDSMailProvider` is missing.

**Step 3: Write minimal implementation**

Implement fetch injection, JSON parsing, `MailProviderError`, and `createInbox()`.

**Step 4: Run tests to verify they pass**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

### Task 4: YYDS Mail polling and verification code extraction

**Files:**
- Modify: `tabbit-protocol-pool/src/yyds-mail-provider.js`
- Modify: `tabbit-protocol-pool/test/yyds-mail-provider.test.js`

**Step 1: Write failing tests**

Cover empty-list polling, detail fetch, source fallback, timeout, subject/text/html/raw code extraction, and ambiguous-code failure.

**Step 2: Run tests to verify they fail**

Run: `cd tabbit-protocol-pool && npm test`
Expected: FAIL because polling and extraction are missing.

**Step 3: Write minimal implementation**

Implement `listMessages()`, `getMessage()`, `getSource()`, `extractVerificationCode()`, and `waitForVerificationCode()`.

**Step 4: Run tests to verify they pass**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

### Task 5: Root regression

**Files:**
- No production change expected.

**Step 1: Run new project tests**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

**Step 2: Run existing root tests**

Run: `npm test`
Expected: PASS.

**Step 3: Review git status**

Run: `git status --short`
Expected: only intentional implementation/docs files plus pre-existing package-lock change if still present.
