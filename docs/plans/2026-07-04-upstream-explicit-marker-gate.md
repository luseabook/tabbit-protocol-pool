# Upstream Explicit Marker Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep `fixtures audit --scope upstream` from counting generic stream `protocol_probe` fixtures as real upstream boundary evidence unless the sanitized fixture carries an explicit real-upstream marker.

**Architecture:** Preserve the existing stream metadata requirement. Tighten only `fixtureIsRealUpstreamEvidence()` so stream metadata plus `kind:"protocol_probe"` is not enough; the fixture must also include a safe explicit source/marker such as `source:"tabbit-live"`, `upstreamEvidence.real:true`, or `result.raw.upstream:true`.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"upstream" })`, and Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildProtocolFixtureAudit requires explicit upstream marker for stream boundary evidence`.

Use one fixture:

```js
{
  kind: "protocol_probe",
  operation: "sendMessage",
  status: "success",
  result: {
    raw: { kind: "stream", format: "sse", events: [{ event: "message", data: "ok" }] },
    streamDeltas: ["ok"],
  },
}
```

Expected:
- upstream scope total remains `1`;
- `counts.realUpstream === 0`;
- error/cancellation/backpressure counts remain `0`;
- all three upstream coverage items remain missing;
- serialized audit does not contain stream text.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "explicit upstream marker"
```

Expected: FAIL before implementation because the current predicate accepts any stream `protocol_probe`.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Require an explicit marker**

In `fixtureIsRealUpstreamEvidence()`, remove `fixture.kind === "protocol_probe"` from the positive marker list.

**Step 2: Preserve accepted real markers**

Keep accepting safe explicit evidence:
- source text containing `tabbit`, `protocol`, `upstream`, or `live`;
- `upstreamEvidence.real === true`;
- `result.raw.upstream === true`.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: State the stricter gate**

Document that upstream stream boundary readiness requires both stream/SSE/NDJSON metadata and an explicit real-upstream marker; generic `protocol_probe` stream samples only prove default streaming behavior.

### Task 4: Verification

**Focused checks:**

```powershell
node --test test\observability.test.js --test-name-pattern "explicit upstream marker"
node --test test\ops-cli.test.js --test-name-pattern "upstream requires stream|upstream boundary"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked files.

---

## Execution Status - 2026-07-04

Completed in this continuation turn.

### RED Evidence

- `node --test test\observability.test.js --test-name-pattern "explicit upstream marker"` failed before implementation because a streamed `kind:"protocol_probe"` sendMessage fixture was counted as `realUpstream`.

### GREEN Implementation

- `src/observability.js` now requires an explicit real-upstream marker in addition to stream/SSE/NDJSON metadata.
- Accepted markers remain safe source text such as `tabbit` / `protocol` / `upstream` / `live`, `upstreamEvidence.real:true`, or `result.raw.upstream:true`.

### Documentation

- README, data dictionary, real protocol acceptance docs, and M08 ops docs now state that generic `protocol_probe` stream samples are insufficient for upstream scope coverage.

### Verification Evidence

- Focused, full regression, diff, forbidden-path, and credential-shape scans are tracked in the final turn summary for this increment.
