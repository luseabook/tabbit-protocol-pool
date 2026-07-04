# Upstream Stream Boundary Fixture Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only `fixtures audit --scope upstream` backlog for real upstream stream error-frame, cancellation, and backpressure evidence.

**Architecture:** Reuse sanitized `protocol_probe` fixtures and the existing `buildProtocolFixtureAudit()` / `readiness doctor` flow. The new scope inspects only `sendMessage` fixtures and only counts explicit real-upstream evidence markers; local HTTP route tests, synthetic local-only cancellation tests, and generic stream success fixtures do not satisfy the coverage. The scope remains offline and produces aggregate counts, missing names, and safe next actions without printing fixture bodies, prompts, cookies, sessions, tokens, or raw payloads.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit()`, `runProtocolPoolCli()`, `readiness doctor`, Markdown docs.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Add upstream audit behavior test**

Add a test named `buildProtocolFixtureAudit supports upstream stream boundary fixture scope` with fixtures for:

```js
const audit = buildProtocolFixtureAudit({
  scope: "upstream",
  fixtures: [
    {
      operation: "sendMessage",
      status: "failed",
      source: "protocol-client",
      result: {
        raw: { kind: "stream", format: "sse", upstream: true },
        error: { category: "quota_exhausted", code: "QUOTA_EXHAUSTED", message: "redacted" },
      },
    },
    {
      operation: "sendMessage",
      status: "success",
      upstreamEvidence: { source: "tabbit-live", cancellation: true },
      result: { raw: { kind: "stream", format: "sse", async: true } },
    },
    {
      operation: "sendMessage",
      status: "success",
      upstreamEvidence: { source: "tabbit-live", backpressure: true },
      result: { raw: { kind: "stream", format: "sse", async: true } },
    },
    {
      operation: "sendMessage",
      status: "success",
      source: "local-http-test",
      result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local"] },
    },
    { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
  ],
  now: () => NOW,
});
```

Assert:

```js
assert.equal(audit.scope, "upstream");
assert.equal(audit.status, "ready");
assert.equal(audit.counts.total, 4);
assert.equal(audit.counts.realUpstream, 3);
assert.equal(audit.coverage.upstreamErrorFrame.count, 1);
assert.equal(audit.coverage.upstreamCancellation.count, 1);
assert.equal(audit.coverage.upstreamBackpressure.count, 1);
assert.deepEqual(audit.missing, []);
assert.doesNotMatch(JSON.stringify(audit), /user_123|local/);
```

**Step 2: Add missing-state test**

Add a small test showing generic/local sendMessage streams do not count:

```js
const audit = buildProtocolFixtureAudit({
  scope: "upstream",
  fixtures: [
    { operation: "sendMessage", status: "success", source: "local-http-test", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local"] } },
  ],
  now: () => NOW,
});

assert.equal(audit.status, "blocked");
assert.deepEqual(audit.missing, [
  "real_upstream_error_frame_fixture",
  "real_upstream_cancellation_fixture",
  "real_upstream_backpressure_fixture",
]);
```

**Step 3: Verify RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "upstream stream boundary"
```

Expected: FAIL because `scope:"upstream"` is not implemented.

### Task 2: RED CLI and Doctor Tests

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add JSON CLI test**

Add `fixtures audit --scope upstream reports real upstream boundary evidence` with a fixture store containing the same real-upstream and local-only fixtures. Assert:

```js
await runProtocolPoolCli(["fixtures", "audit", "--scope", "upstream", "--json"], ...);
assert.deepEqual(calls, [
  "listFixtures",
  "readFixture:fixtures/protocol-probes/upstream-error.json",
  "readFixture:fixtures/protocol-probes/upstream-cancel.json",
  "readFixture:fixtures/protocol-probes/upstream-backpressure.json",
  "readFixture:fixtures/protocol-probes/local-stream.json",
]);
assert.equal(body.scope, "upstream");
assert.equal(body.status, "ready");
```

**Step 2: Add plain CLI test**

Add `fixtures audit --scope upstream prints boundary counts in plain output`, expecting:

```text
status	blocked
real_upstream_error_frame_fixture	ready	1
real_upstream_cancellation_fixture	missing	0
real_upstream_backpressure_fixture	missing	0
upstream_error_frame	1
upstream_cancellation	0
upstream_backpressure	0
missing	real_upstream_cancellation_fixture,real_upstream_backpressure_fixture
```

**Step 3: Extend doctor test**

In `readiness doctor --json includes auth and benefits backlog without running probes`, assert:

```js
assert.equal(body.calibrationBacklog.scopes.upstream.status, "blocked");
assert.ok(body.calibrationBacklog.missing.includes("real_upstream_error_frame_fixture"));
assert.match(body.commands.upstreamFixturesAudit, /fixtures audit --scope upstream --json/);
```

In plain doctor output, assert an `upstream_backlog` line exists.

**Step 4: Verify RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope upstream|readiness doctor"
```

Expected: FAIL because CLI rejects the new scope and doctor has no upstream scope.

### Task 3: GREEN Observability Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Add upstream evidence helpers**

Add helpers near the existing fixture matchers:

```js
function fixtureMatchesSendMessage(fixture = {}) {
  return fixture?.operation === "sendMessage";
}

function fixtureSourceText(fixture = {}) {
  return [
    fixture?.source,
    fixture?.evidenceSource,
    fixture?.upstreamEvidence?.source,
    fixture?.result?.source,
    fixture?.result?.raw?.source,
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

function fixtureIsRealUpstreamEvidence(fixture = {}) {
  const text = fixtureSourceText(fixture);
  if (/local|http-server|route|compat|unit|synthetic/.test(text)) return false;
  return Boolean(
    fixture?.kind === "protocol_probe"
    || /tabbit|protocol|upstream|live/.test(text)
    || fixture?.upstreamEvidence?.real === true
    || fixture?.result?.raw?.upstream === true
  );
}
```

**Step 2: Add boundary matchers**

Implement:

```js
function fixtureMatchesUpstreamErrorFrame(fixture = {}) { ... }
function fixtureMatchesUpstreamCancellation(fixture = {}) { ... }
function fixtureMatchesUpstreamBackpressure(fixture = {}) { ... }
```

Rules:
- all require `operation:"sendMessage"` and `fixtureIsRealUpstreamEvidence(fixture)`;
- error frame accepts `fixture.upstreamEvidence.errorFrame === true`, `result.raw.events[]` with `event/type:"error"`, or failed result/error with stream raw metadata;
- cancellation accepts `upstreamEvidence.cancellation === true` or `upstreamEvidence.cancelled === true`;
- backpressure accepts `upstreamEvidence.backpressure === true`, `upstreamEvidence.firstTokenFlush === true`, `upstreamEvidence.delayedSecondChunk === true`, or `result.raw.async === true` plus an explicit upstream evidence object with `backpressure:true`.

**Step 3: Add `buildUpstreamFixtureAudit()`**

Return:

```js
{
  scope: "upstream",
  status,
  observedAt,
  counts: {
    total,
    sendMessage,
    realUpstream,
    upstreamErrorFrame,
    upstreamCancellation,
    upstreamBackpressure,
    success,
    failed,
  },
  coverage: {
    upstreamErrorFrame: coverageItem(...),
    upstreamCancellation: coverageItem(...),
    upstreamBackpressure: coverageItem(...),
  },
  missing,
  nextActions,
}
```

**Step 4: Wire `buildProtocolFixtureAudit()` and doctor**

Add:

```js
if (scope === "upstream") return buildUpstreamFixtureAudit({ fixtures, now });
```

In `buildReadinessDoctorReport()`:
- build `upstreamAudit`;
- merge its `missing` and `nextActions`;
- add `upstream` to `calibrationBacklog.scopes`;
- include it in `calibrationBacklog.status`.

Add `upstreamFixturesAudit` to `readinessDoctorCommands()`.

**Step 5: Run focused observability test**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "upstream stream boundary|buildReadinessDoctorReport"
```

Expected: PASS.

### Task 4: GREEN CLI Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Accept upstream scope**

Update help and scope validation from:

```text
protocol|auth|benefits|session
```

to:

```text
protocol|auth|benefits|session|upstream
```

For `scope === "upstream"`, read only `sendMessage` fixtures:

```js
else if (scope === "upstream") fixtureReadFilter = { operation: "sendMessage" };
```

**Step 2: Add plain renderer**

Print aggregate upstream lines from the audit object:

```js
"status\t" + audit.status,
"real_upstream_error_frame_fixture\t" + audit.coverage.upstreamErrorFrame.status + "\t" + audit.coverage.upstreamErrorFrame.count,
"real_upstream_cancellation_fixture\t" + audit.coverage.upstreamCancellation.status + "\t" + audit.coverage.upstreamCancellation.count,
"real_upstream_backpressure_fixture\t" + audit.coverage.upstreamBackpressure.status + "\t" + audit.coverage.upstreamBackpressure.count,
"real_upstream\t" + audit.counts.realUpstream,
"upstream_error_frame\t" + audit.counts.upstreamErrorFrame,
"upstream_cancellation\t" + audit.counts.upstreamCancellation,
"upstream_backpressure\t" + audit.counts.upstreamBackpressure,
"missing\t" + audit.missing.join(","),
```

**Step 3: Add plain doctor line**

In doctor plain output add:

```js
`upstream_backlog\t${scopes.upstream?.status || ""}\tmissing=${missingCount(scopes.upstream)}`,
```

**Step 4: Run focused CLI tests**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope upstream|readiness doctor"
```

Expected: PASS.

### Task 5: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M01-Tabbit协议客户端/消息发送协议.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document the new audit scope**

State that `fixtures audit --scope upstream` is read-only and checks sanitized real upstream `sendMessage` evidence for:
- error frames;
- cancellation/real upstream disconnect propagation;
- backpressure/first-token flush with delayed continuation.

**Step 2: Preserve boundary wording**

Clarify that local HTTP route adapter tests and protocol-client fake stream tests do not satisfy the real-upstream scope unless a sanitized protocol probe fixture carries explicit upstream evidence markers.

**Step 3: Update remaining work wording**

Keep auth/M05/session blockers visible and add upstream scope to doctor backlog descriptions.

### Task 6: Verification

**Files:**
- No edits unless tests expose issues.

**Step 1: Required focused checks**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "upstream stream boundary|buildReadinessDoctorReport"
node --test test\ops-cli.test.js --test-name-pattern "scope upstream|readiness doctor"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

**Step 2: Full regression**

Run:

```powershell
npm test
git diff --check
```

**Step 3: Safety scans**

Run path and credential-shape scans over tracked text sources. Expected:
- no changes under `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, `.omx/`;
- no real cookie/session/JWT/API key/Bearer token/raw payload/prompt/user data introduced.
