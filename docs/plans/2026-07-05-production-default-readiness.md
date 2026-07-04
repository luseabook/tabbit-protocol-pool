# Production Default Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a fresh server deployment require fewer unsafe manual protocol knobs while preserving real-evidence readiness gates and secret safety.

**Architecture:** Treat known public Tabbit protocol paths as safe product defaults, but continue requiring private state for sessions, sanitized fixtures, and E2E marks. Add production-facing checks that fail closed when the gateway would expose an unsafe default key or unproven readiness, instead of marking production ready with fake fixtures.

**Tech Stack:** Node.js ES modules, native `node:test`, existing `loadConfig()`, `readiness doctor`, `smoke gateway`, and Markdown docs.

---

### Task 1: Default Stable Tabbit Protocol Paths

**Files:**
- Modify: `test/config.test.js`
- Modify: `src/config.js`
- Modify: `docs/07-API文档.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`

**Step 1: Write the failing test**

Add a config test proving that `TABBIT_POOL_PROTOCOL_ENABLED=true` without explicit endpoint env uses calibrated public defaults for:
- `baseUrl`
- `signKeyPath`
- `modelCatalogPath`
- `sendPath`
- `sessionVerifyPath`
- `reqCtx`

**Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test\config.test.js --test-name-pattern "protocol enabled uses calibrated Tabbit defaults"
```

Expected: FAIL because `loadConfig()` currently leaves `sendPath` and `sessionVerifyPath` null unless env overrides are present.

**Step 3: Implement minimal config defaults**

Add non-secret default constants in `src/config.js` matching the already calibrated docs and `ProtocolTabbitClient` defaults. Only apply them when `TABBIT_POOL_PROTOCOL_ENABLED=true`; keep no-env local defaults offline.

**Step 4: Verify GREEN**

Run:

```powershell
node --test test\config.test.js
```

Expected: PASS.

### Task 2: Production Safety Preflight

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`
- Modify: `docs/07-API文档.md`
- Modify: `README.md`

**Step 1: Write the failing CLI tests**

Add tests for a production preflight command that:
- reports blocked when the API key is still `sk-tabbit-local`
- reports blocked when `manualCookieMode` is not ready
- reports ready only when readiness doctor is ready, manual cookie blocking gaps are empty, and the API key is not the default
- never prints the API key, cookie, session, token, or raw fixture payload

**Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "production preflight"
```

Expected: FAIL because the command does not exist.

**Step 3: Implement minimal CLI command**

Add `tabbit-pool production preflight [--json]` as a read-only wrapper around existing doctor evidence plus API-key safety checks.

**Step 4: Verify GREEN**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "production preflight|readiness doctor"
```

Expected: PASS.

### Task 3: Runtime Verification

**Files:**
- No code changes unless tests reveal regressions.

**Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

**Step 2: Run default diagnostics**

Run:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js production preflight --json
```

Expected: Both remain blocked in the current default state if real sanitized fixtures or E2E marks are missing. This is the correct production-safe result until private server state supplies them.

**Step 3: Document the boundary**

Update docs to say the repository can ship with calibrated public protocol defaults, but a production server is not considered ready until `production preflight` reports ready.
