# Probe Protocol Output Sanitizer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `probe protocol --json` never prints raw runner output before sanitizer protection.

**Architecture:** Keep fixture write semantics unchanged. Add a final CLI output sanitizer in `handleProbeProtocol()` so both injected runners and real protocol probes pass through the same redaction boundary before stdout.

**Tech Stack:** Node.js ESM, native `node:test`, existing `sanitizeProtocolProbeFixture()`.

---

### Task 1: RED Output Boundary Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add `probe protocol --json sanitizes runner output before printing` with an injected runner that returns prompt text, stream deltas, raw frame data, Bearer, cookie, and session material.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sanitizes runner output"
```

Expected: FAIL because `handleProbeProtocol()` prints the runner result directly.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Sanitize before output**

Call `sanitizeProtocolProbeFixture(result)` before JSON/plain output in `handleProbeProtocol()`.

**Step 2: Preserve status and fixture ref**

Use the sanitized result for `status`, `advice.category`, and `fixtureRef` in plain output.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`

**Step 1: Document the boundary**

Record that `probe protocol --json` is sanitized before stdout and cannot be used to print raw prompts, stream data, cookies, sessions, tokens, Bearer values, or real user identifiers.

### Task 4: Verification

**Focused checks:**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sanitizes runner output"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape diff scans. Expected: no sensitive file edits and no raw credential shapes in added lines.

---

## Execution Status - 2026-07-04

Completed for this increment.

### RED Evidence

- `node --test test\ops-cli.test.js --test-name-pattern "sanitizes runner output"` failed as expected before implementation because stdout contained the injected raw prompt, stream text, raw SSE data, Bearer token, cookie, and session material.

### GREEN Implementation

- `src/ops-cli.js` now sanitizes the result from `deps.protocolProbeRunner.probeAccount()` before printing `probe protocol` output.
- Plain output reads `status`, `advice.category`, and `fixtureRef` from the sanitized result.

### Verification Evidence

- `node --test test\ops-cli.test.js --test-name-pattern "sanitizes runner output"`: 103/103 pass.

Full regression, external aggregate checks, forbidden-path scan, and credential-shape diff scan are tracked in the final turn summary for this increment.
