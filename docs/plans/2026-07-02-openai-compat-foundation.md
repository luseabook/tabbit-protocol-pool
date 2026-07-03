# OpenAI Compatibility Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first OpenAI-compatible pure handler layer that normalizes Chat Completions and Responses requests into `PooledRequestRunner.run()` calls and maps runner results back to stable OpenAI-style JSON.

**Architecture:** Keep HTTP server wiring out of this phase. Implement pure, dependency-injected handlers that accept parsed JSON bodies and return `{ status, body }`. This makes routing behavior testable without sockets, live Tabbit, or browser UI, and future HTTP routes can call these handlers directly.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `assert/strict`, no external dependencies.

---

### Task 1: Chat Completions compatibility

**Files:**
- Create: `tabbit-protocol-pool/src/openai-compat.js`
- Modify: `tabbit-protocol-pool/src/index.js`
- Create: `tabbit-protocol-pool/test/openai-compat.test.js`

**Step 1: Write the failing test**

Test that `handleChatCompletions()` accepts `{ model, messages }`, calls an injected runner with normalized messages, and returns an OpenAI Chat Completions response containing `id`, `object`, `created`, `model`, `choices`, and route metadata.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: FAIL because `openai-compat.js` does not exist.

**Step 3: Write minimal implementation**

Implement `OpenAICompat`, `normalizeChatCompletionsRequest()`, `buildChatCompletionResponse()`, and a deterministic ID/clock injection point.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: PASS.

### Task 2: Responses compatibility

**Files:**
- Modify: `tabbit-protocol-pool/src/openai-compat.js`
- Modify: `tabbit-protocol-pool/test/openai-compat.test.js`

**Step 1: Write the failing test**

Test that `handleResponses()` accepts string input and array input items, converts them to user messages, calls the runner, and returns an OpenAI Responses-style body with `output`, `output_text`, and route metadata.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: FAIL because Responses handling is missing.

**Step 3: Write minimal implementation**

Implement `normalizeResponsesRequest()` and `buildResponsesResponse()` for text-only requests.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: PASS.

### Task 3: Error mapping

**Files:**
- Modify: `tabbit-protocol-pool/src/openai-compat.js`
- Modify: `tabbit-protocol-pool/test/openai-compat.test.js`

**Step 1: Write the failing test**

Test empty prompts, runner `no_available_account`, `invalid_request`, and upstream failures map to stable OpenAI-style `{ error: { message, type, code } }` with expected HTTP status.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: FAIL if error mapping is incomplete.

**Step 3: Write minimal implementation**

Implement `openAiErrorForCategory()` and `write`-free handler return shapes.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/openai-compat.test.js`
Expected: PASS.

### Task 4: Regression

Run `cd tabbit-protocol-pool && npm test`, then root `npm test`.
