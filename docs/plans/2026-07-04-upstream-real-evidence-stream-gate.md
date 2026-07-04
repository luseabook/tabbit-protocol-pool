# Upstream Real Evidence Stream Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `fixtures audit --scope upstream` only treats real upstream `sendMessage` fixtures as stream boundary evidence when the sanitized fixture also contains stream wire metadata.

**Architecture:** Keep protocol/default readiness unchanged. Tighten only the upstream scoped audit: explicit real-upstream markers remain required, but they are not sufficient unless the fixture is a stream/SSE/NDJSON sample. Non-stream protocol_probe sendMessage fixtures remain useful for default send success readiness, but must not inflate upstream stream boundary counts or satisfy cancellation/backpressure/error-frame coverage.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"upstream" })`, `fixtures audit --scope upstream`, and Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Add the failing test**

Add `buildProtocolFixtureAudit requires stream metadata for real upstream boundary evidence`.

Fixture set:

```js
[
  {
    kind: "protocol_probe",
    operation: "sendMessage",
    status: "success",
    upstreamEvidence: { source: "tabbit-live", real: true, cancellation: true, backpressure: true },
    result: { contentBlocks: [{ type: "text", text: "ok" }] },
  },
]
```

Expected:
- `scope === "upstream"`;
- `counts.total === 1`;
- `counts.realUpstream === 0`;
- cancellation/backpressure/error-frame counts are all `0`;
- all three coverage items remain missing;
- serialized output does not contain the text content.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "stream metadata for real upstream"
```

Expected: FAIL because `fixtureIsRealUpstreamEvidence()` currently accepts `kind:"protocol_probe"` and explicit upstream markers even without stream metadata.

### Task 2: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add a CLI audit case**

Add or extend an upstream scope test with one non-stream protocol_probe fixture carrying `upstreamEvidence.cancellation:true`. Assert plain or JSON output keeps `realUpstream === 0` and does not mark cancellation ready.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "upstream requires stream"
```

Expected: FAIL until the upstream audit requires stream metadata.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Gate real upstream evidence by stream metadata**

Update `fixtureIsRealUpstreamEvidence(fixture)` so it returns false unless:

- `operation === "sendMessage"`;
- local/compat/unit/fake source words are absent;
- `fixtureHasStreamMetadata(fixture)` is true;
- and one existing real upstream marker is present.

Do not change default protocol audit.

**Step 2: Keep error/cancel/backpressure matchers unchanged**

They already call `fixtureIsRealUpstreamEvidence()`, so the stricter base predicate should make all three safe.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document the stricter rule**

State that upstream scope requires both an explicit real upstream marker and stream/SSE/NDJSON metadata. Non-stream `protocol_probe` samples can satisfy default send readiness but not upstream stream boundary readiness.

### Task 5: Verification

**Step 1: Focused tests**

```powershell
node --test test\observability.test.js --test-name-pattern "stream metadata for real upstream"
node --test test\ops-cli.test.js --test-name-pattern "upstream requires stream"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Step 3: Aggregate and safety checks**

Run external aggregate-only upstream audit plus forbidden-path and credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and upstream scope remains blocked until sanitized stream boundary fixtures exist.

---

## Execution Status - 2026-07-04

Completed.

### RED Evidence

- `node --test test\observability.test.js --test-name-pattern "stream metadata for real upstream"` failed as expected before implementation: `counts.realUpstream` was `1` instead of expected `0`.
- `node --test test\ops-cli.test.js --test-name-pattern "upstream requires stream"` failed as expected before implementation: upstream JSON audit counted the non-stream marker fixture as real upstream evidence.

### GREEN Implementation

- `src/observability.js` now requires `fixtureHasStreamMetadata(fixture)` before accepting any real upstream marker in `fixtureIsRealUpstreamEvidence()`.
- Existing upstream error-frame, cancellation, and backpressure matchers reuse that predicate, so non-stream marker fixtures no longer satisfy any upstream boundary coverage.
- Non-stream `protocol_probe` `sendMessage` fixtures remain usable for default send readiness; the stricter rule applies only to upstream scoped audit.

### Verification Evidence

- `node --test test\observability.test.js --test-name-pattern "stream metadata for real upstream"`: 34/34 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "upstream requires stream"`: 82/82 pass.
- `node --test test\observability.test.js`: 34/34 pass.
- `node --test test\ops-cli.test.js`: 82/82 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 357/357 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings.
- Forbidden path scan: clean.
- Credential-shape diff scan: clean after excluding explicit test placeholders such as `sk-tabbit-local` and `secret-local-key`.

### External Aggregate State

External state was checked with `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and protocol env configured. Only aggregate status was printed.

- doctor: ready.
- readiness: ready.
- default fixture audit: ready.
- calibration backlog: blocked.
- auth missing: `successful_sendVerificationCode_fixture`, `successful_submitRegistrationOrLogin_fixture`.
- benefits missing: `successful_daily_sign_in_fixture`, `successful_pro_activity_fixture`, `successful_reset_coupon_consumption_fixture`, `successful_lottery_draw_fixture`.
- session missing: `automated_session_refresh_strategy`.
- upstream counts after the stricter stream gate: `realUpstream=3`, `upstreamErrorFrame=0`, `upstreamCancellation=0`, `upstreamBackpressure=0`.
- upstream missing: `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, `real_upstream_backpressure_fixture`.
