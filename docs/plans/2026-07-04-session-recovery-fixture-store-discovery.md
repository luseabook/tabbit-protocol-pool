# Session Recovery Fixture Store Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure sanitized `session_recovery_strategy` fixtures are discoverable by the default `FileProtocolFixtureStore`, so `fixtures audit --scope session` can use real persisted recovery evidence.

**Architecture:** Keep all fixtures under the existing `stateDir/fixtures/protocol-probes/` root and keep `readFixture()` sanitization unchanged. Broaden `listFixtures()` only for known audit-safe fixture kinds: existing `protocol_probe` plus explicit `session_recovery_strategy`. Preserve filtering for unknown fixture kinds, hidden directories, traversal protection, and raw secret redaction.

**Tech Stack:** Node.js ESM, native `node:test`, `FileProtocolFixtureStore`, `tabbit-pool fixtures audit --scope session`, and Markdown docs.

---

### Task 1: RED Store Test

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Add failing list test**

Add `FileProtocolFixtureStore lists sanitized session recovery strategy fixtures`.

Arrange files under a temp `stateDir/fixtures/protocol-probes/`:

```js
await writeFile(path.join(root, "session-recovery.json"), JSON.stringify({
  kind: "session_recovery_strategy",
  operation: "recoverSession",
  status: "success",
  observedAt: "2026-07-04T03:00:00.000Z",
  evidence: {
    strategy: "automated_reauth",
    automatedRefresh: "calibrated_reauth_probe",
    safe: true,
    sanitized: true,
    rawPayload: false,
  },
  result: { raw: { cookie: "tabbit_session=secret" } },
}), "utf8");
```

Expected summary:
- includes one entry with `kind` omitted but `operation:"recoverSession"`;
- `status:"success"`;
- `ref:"fixtures/protocol-probes/session-recovery.json"`;
- no cookie/session text in serialized summary.

**Step 2: Run RED**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "session recovery strategy fixtures"
```

Expected: FAIL because `listFixtures()` currently skips every non-`protocol_probe` kind.

### Task 2: RED Real Store CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add CLI test using real FileProtocolFixtureStore**

Create a temp state dir with successful `verifySession`, expired `verifySession`, a sanitized `session_recovery_strategy` fixture, and unrelated fixture. Run `runProtocolPoolCli(["fixtures","audit","--scope","session","--json"], { protocolFixtureStore: new FileProtocolFixtureStore({ stateDir }) })`.

Expected:
- status is `ready`;
- `counts.recoveryStrategyEvidence === 1`;
- output does not leak cookie/session/payload text.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "real fixture store session recovery"
```

Expected: FAIL until the default store lists the recovery evidence fixture.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/protocol-probe.js`

**Step 1: Broaden allowed list kinds**

Introduce an internal allowlist:

```js
const LISTABLE_FIXTURE_KINDS = new Set(["protocol_probe", "session_recovery_strategy"]);
```

Change `listFixtures()` to skip only fixtures whose `kind` is not in the allowlist.

**Step 2: Keep summaries aggregate-only**

Do not add raw evidence fields to `fixtureSummary()`. Summary remains `ref`, `observedAt`, `operation`, `status`, `accountId`, and `adviceCategory`.

### Task 4: Documentation

**Files:**
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document discovery behavior**

State that `FileProtocolFixtureStore.listFixtures()` lists sanitized `protocol_probe` and `session_recovery_strategy` fixtures from the same protocol-probes root, and all summaries stay aggregate-only.

### Task 5: Verification

**Step 1: Focused tests**

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "session recovery strategy fixtures"
node --test test\ops-cli.test.js --test-name-pattern "real fixture store session recovery"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Step 3: Aggregate and safety checks**

Run external aggregate-only readiness/audit checks plus forbidden-path and credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and session scope remains blocked until a real sanitized recovery fixture exists.

---

## Execution Status - 2026-07-04

Completed.

### RED Evidence

- `node --test test\protocol-probe.test.js --test-name-pattern "session recovery strategy fixtures"` failed as expected before implementation: `FileProtocolFixtureStore.listFixtures()` returned `[]` for `kind:"session_recovery_strategy"`.
- `node --test test\ops-cli.test.js --test-name-pattern "real fixture store session recovery"` failed as expected before implementation: real-store session audit stayed `blocked` because the recovery fixture was not discoverable.

### GREEN Implementation

- `src/protocol-probe.js` now uses a narrow `LISTABLE_FIXTURE_KINDS` allowlist containing `protocol_probe` and `session_recovery_strategy`.
- Unknown fixture kinds, non-JSON files, other fixture directories, traversal refs, and raw fixture fields remain excluded from summaries.
- `fixtureSummary()` remains aggregate-only and does not expose evidence, result, cookie, session, token, or raw payload fields.

### Verification Evidence

- `node --test test\protocol-probe.test.js --test-name-pattern "session recovery strategy fixtures"`: 13/13 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "real fixture store session recovery"`: 84/84 pass.
- `node --test test\observability.test.js`: 35/35 pass.
- `node --test test\ops-cli.test.js`: 84/84 pass.
- `node --test test\protocol-probe.test.js`: 13/13 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 361/361 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings.
- Forbidden path scan: clean.
- Credential-shape diff scan: clean after excluding explicit test placeholders.

### External Aggregate State

External state was checked with `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and protocol env configured. Only aggregate status was printed.

- doctor: ready.
- readiness: ready.
- default fixture audit: ready.
- calibration backlog: blocked.
- core remaining work count: 0.
- session remains blocked: `recoveryStrategy.status=blocked`, `counts.recoveryStrategyEvidence=0`, missing `automated_session_refresh_strategy`.
- calibration backlog missing count: 10.
