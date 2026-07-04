# Upstream Marker Source Tightening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent generic `protocol` source text from counting as real Tabbit upstream stream-boundary evidence.

**Architecture:** Keep the existing stream metadata requirement and the safe explicit marker paths. Narrow source-text based markers to names that actually imply live upstream origin (`tabbit`, `upstream`, or `live`), while preserving `upstreamEvidence.real:true` and `result.raw.upstream:true` as explicit proof markers.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"upstream" })`, and Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildProtocolFixtureAudit rejects generic protocol source as real upstream marker`.

The fixture should include:
- `operation:"sendMessage"`;
- stream metadata in `result.raw`;
- `source:"protocol-client"`;
- aggregate cancellation evidence but no `upstreamEvidence.real:true` and no `result.raw.upstream:true`.

Expected:
- upstream scope still sees one sendMessage fixture;
- `counts.realUpstream === 0`;
- `counts.upstreamCancellation === 0`;
- all three upstream coverage items remain missing;
- serialized audit does not contain raw stream text.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "generic protocol source"
```

Expected before implementation: FAIL because `source:"protocol-client"` currently matches the broad `protocol` source-text marker.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Narrow source-text marker matching**

In `fixtureIsRealUpstreamEvidence()`, stop accepting generic `protocol` text as a real upstream marker. Continue accepting:
- `source` or evidence source text containing `tabbit`, `upstream`, or `live`;
- `upstreamEvidence.real === true`;
- `result.raw.upstream === true`.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document the stricter marker**

State that generic protocol/client source labels are not enough for upstream scope; accepted source-text markers must indicate Tabbit/live/upstream origin, or the fixture must carry `upstreamEvidence.real:true` / `result.raw.upstream:true`.

### Task 4: Verification

**Focused checks:**

```powershell
node --test test\observability.test.js --test-name-pattern "generic protocol source|explicit upstream marker|upstream scope"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files.

---

## Execution Status - 2026-07-04

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "generic protocol source"` failed because `source:"protocol-client"` was counted as real upstream evidence.
- GREEN implementation:
  - `src/observability.js` now accepts source-text markers only when they indicate `tabbit`, `upstream`, or `live`.
  - `upstreamEvidence.real:true` and `result.raw.upstream:true` remain accepted explicit markers.
- Documentation:
  - README, data dictionary, real protocol acceptance docs, and M08 ops docs now state that generic protocol/client source labels are insufficient.
