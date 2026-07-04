# Reset Coupon Consumption Evidence Template Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe offline `consumeResetCoupon` evidence template and validator so operators can prepare sanitized reset-coupon consumption evidence without guessing or executing a real coupon-consumption endpoint.

**Architecture:** Treat `consumeResetCoupon` as offline evidence, not as a protocol probe dispatch target. Reuse the existing `probe template` / `probe validate` path to preflight sanitized endpoint/body/result hash evidence, and update readiness doctor capture commands to expose template/validate only while keeping protocol probe execution disabled.

**Tech Stack:** Node.js built-in test runner, `src/ops-cli.js`, `src/observability.js`, local Markdown project docs.

---

### Task 1: Add RED tests for offline reset-coupon evidence input

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing tests**

Add tests covering these behaviors:

```js
test("probe template --operation consumeResetCoupon prints safe reset coupon consumption evidence input", async () => {
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "consumeResetCoupon", "--json"], {
    stdout: createMemoryStream(),
    stderr: createMemoryStream(),
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.kind, "reset_coupon_consumption_evidence");
  assert.equal(body.operation, "consumeResetCoupon");
  assert.equal(body.status, "success");
  assert.equal(body.evidence.safe, true);
  assert.equal(body.evidence.sanitized, true);
  assert.equal(body.evidence.rawPayload, false);
  assert.match(body.evidence.endpointHash, /^sha256:/);
  assert.match(body.evidence.bodyHash, /^sha256:/);
  assert.match(body.evidence.resultHash, /^sha256:/);
  assert.equal(body.result.resetCouponConsumed, true);
  assert.equal(body.result.consumeResult, "success");
});
```

Also add tests that:
- `probe validate --operation consumeResetCoupon` accepts explicit sanitized evidence and emits only key/type/hash presence summary.
- `probe validate --operation consumeResetCoupon` rejects missing hashes, `sanitized:false`, `rawPayload:true`, and non-consumption signals such as `already_participated`.
- `probe validate --operation consumeResetCoupon` without input is rejected.
- `probe protocol --operation consumeResetCoupon` is rejected as offline evidence before calling the runner.

**Step 2: Run tests to verify RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "consumeResetCoupon"
```

Expected: FAIL because `consumeResetCoupon` is not in `PROBE_INPUT_TEMPLATES`, has no evidence-specific validator, and is not protected as an offline-only operation.

### Task 2: Add RED tests for readiness doctor capture commands

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `test/observability.test.js`

**Step 1: Write the failing tests**

Update the existing capture-command assertions for `successful_reset_coupon_consumption_fixture`:

```js
assert.equal(byMissing.successful_reset_coupon_consumption_fixture.operation, "consumeResetCoupon");
assert.match(byMissing.successful_reset_coupon_consumption_fixture.templateCommand, /probe template --operation consumeResetCoupon --json/);
assert.match(byMissing.successful_reset_coupon_consumption_fixture.validateCommand, /probe validate --operation consumeResetCoupon --input-file <redacted-input\.json> --json/);
assert.equal(byMissing.successful_reset_coupon_consumption_fixture.confirmedValidateCommand, null);
assert.equal(byMissing.successful_reset_coupon_consumption_fixture.probeCommand, null);
assert.match(byMissing.successful_reset_coupon_consumption_fixture.reason, /offline/i);
```

For plain doctor output, expect template and validate columns to be present, but `confirm_validate` and `probe` to remain empty.

**Step 2: Run tests to verify RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "capture"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because the reset-coupon capture spec currently has `operation:null` and no commands.

### Task 3: Implement minimal offline evidence support

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Add the template**

Add `consumeResetCoupon` to `PROBE_INPUT_TEMPLATES`:

```js
consumeResetCoupon: {
  kind: "reset_coupon_consumption_evidence",
  operation: "consumeResetCoupon",
  status: "success",
  evidence: {
    endpointHash: "sha256:<redacted-endpoint>",
    bodyHash: "sha256:<redacted-body>",
    resultHash: "sha256:<redacted-result>",
    safe: true,
    sanitized: true,
    rawPayload: false,
  },
  result: {
    resetCouponConsumed: true,
    consumeResult: "success",
  },
},
```

**Step 2: Add validation**

Add a validator requiring:
- `kind:"reset_coupon_consumption_evidence"`
- `operation` in `consumeResetCoupon`, `useResetCoupon`, `consumeResetCouponSku`, `redeemResetCoupon`
- `status:"success"`
- `evidence.endpointHash`, `evidence.bodyHash`, and `evidence.resultHash` all shaped as `sha256:*`
- `evidence.safe === true`
- `evidence.sanitized === true`
- `evidence.rawPayload === false`
- `result` proves real consumption through `resetCouponConsumed:true`, `couponConsumed:true`, `consumed:true`, `used:true`, `deducted:true`, or `consumeResult` / `couponResult` / `usageResult` success
- `result` does not include `already_participated`, `already_claimed`, or other non-consumption values

**Step 3: Keep it offline-only**

Add `consumeResetCoupon` to `OFFLINE_EVIDENCE_PROBE_OPERATIONS`. Do not add it to `SIDE_EFFECT_PROBE_OPERATIONS`; there is no real probe dispatch or side-effect confirmation path until the endpoint is calibrated.

**Step 4: Extend validation preview**

Include a `resetCouponConsumption` summary with booleans/hash-presence fields only. Do not echo hash values, endpoint text, body text, result payload, account data, or raw fixture content.

### Task 4: Update readiness doctor capture spec

**Files:**
- Modify: `src/observability.js`

**Step 1: Change the missing fixture spec**

Set `successful_reset_coupon_consumption_fixture` to:

```js
{
  scope: "benefits",
  operation: "consumeResetCoupon",
  sideEffect: true,
  protocolProbe: false,
  reason: "Use the offline consumeResetCoupon evidence template and validator to prepare sanitized endpoint/body/result hash evidence; no calibrated protocol probe exists yet.",
}
```

**Step 2: Preserve audit semantics**

Do not relax `fixtureMatchesResetCouponConsumptionSuccess()`. `participateResetCouponActivity` and `already_participated` must continue to be excluded from successful consumption coverage.

### Task 5: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M05-权益额度维护/_M05-权益额度维护.md`
- Modify: `docs/modules/M05-权益额度维护/重置券使用.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document the offline-only flow**

Record:
- `probe template --operation consumeResetCoupon --json`
- `probe validate --operation consumeResetCoupon --input-file <redacted-input.json> --json`
- `probe protocol --operation consumeResetCoupon` is intentionally rejected
- doctor command visibility does not mean real endpoint/body/success semantics are calibrated
- actual benefits audit readiness still requires a sanitized fixture in state with real consumption evidence

### Task 6: Verify and record evidence

**Files:**
- Modify: `docs/plans/2026-07-04-reset-coupon-consumption-evidence-template.md`

**Step 1: Run focused checks**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "consumeResetCoupon"
node --test test\observability.test.js --test-name-pattern "capture"
```

**Step 2: Run required checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Step 3: Run safety scans**

Run forbidden path and credential-shape diff scans against the current diff. The scan must remain clean for `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, `.omx/`, and credential-shaped strings.

**Step 4: Record results**

Append RED/GREEN, full verification, external state aggregate status, and safety scan results to this plan document.

---

## Execution Record

### RED

- Added failing CLI tests for `probe template --operation consumeResetCoupon`, `probe validate --operation consumeResetCoupon`, unsafe/non-consumption evidence rejection, explicit input requirement, and `probe protocol --operation consumeResetCoupon` offline dispatch rejection.
- Added failing readiness doctor capture-command assertions requiring `successful_reset_coupon_consumption_fixture` to expose `operation:"consumeResetCoupon"`, template/validate commands, and `confirmedValidateCommand:null` / `probeCommand:null`.
- Added failing fixture-store/audit coverage assertions so reset coupon consumption evidence is listable only as sanitized summary and benefits audit does not count `already_participated` or missing hash/safety evidence as real coupon consumption.

Expected RED reasons before implementation:

```text
consumeResetCoupon was absent from probe templates.
consumeResetCoupon had no evidence-specific validator.
consumeResetCoupon was not protected as an offline-only protocol operation.
successful_reset_coupon_consumption_fixture had no offline template/validate capture command.
reset_coupon_consumption_evidence fixtures were not listable by FileProtocolFixtureStore.
```

### GREEN

- Implemented `consumeResetCoupon` as an offline-only evidence operation in `src/ops-cli.js`.
- Added strict evidence validation for `kind`, consumption operation, `status:"success"`, `sha256:` endpoint/body/result hashes, `safe:true`, `sanitized:true`, `rawPayload:false`, and real consumption signals.
- Kept `consumeResetCoupon` out of protocol dispatch; `probe protocol --operation consumeResetCoupon` rejects before runner access.
- Updated `successful_reset_coupon_consumption_fixture` doctor capture spec to template/validate only.
- Kept benefits audit strict: reset-coupon activity participation and `already_participated` remain non-consumption evidence.
- Allowed `reset_coupon_consumption_evidence` through fixture listing as sanitized summary only.
- Updated README, API/test/reference/calibration docs, M05 reset-coupon docs, and M08 observability docs.

### Fresh Verification

```powershell
node --test --test-name-pattern "consumeResetCoupon" test\ops-cli.test.js
# 5/5 pass

node --test --test-name-pattern "capture" test\observability.test.js
# 1/1 pass

node --test test\observability.test.js
# 36/36 pass

node --test test\ops-cli.test.js
# 94/94 pass

node --test test\protocol-probe.test.js
# 14/14 pass

node --test test\protocol-tabbit-client.test.js
# 57/57 pass

npm test
# 373/373 pass

git diff --check
# exit 0; only existing LF/CRLF warnings were printed
```

### External State Aggregate

With:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
```

Only aggregate state was printed; no raw fixture content was displayed.

```text
doctorStatus=ready
readinessStatus=ready
defaultFixtureAuditStatus=ready
authStatus=blocked, missing=2
benefitsStatus=blocked, missing=4
sessionStatus=blocked, missing=1
upstreamStatus=blocked, missing=3
calibrationBacklogStatus=blocked, missing=10
remainingWorkCount=0
successful_reset_coupon_consumption_fixture capture:
  operation=consumeResetCoupon
  templatePresent=true
  validatePresent=true
  confirmedValidateIsNull=true
  probeIsNull=true
  prerequisitesStatus=ready
```

### Safety Scans

```text
Forbidden path scan:
  scannedPaths=72
  forbiddenMatches=[]

Credential-shape diff/untracked scan:
  scannedAddedOrUntrackedLines=12821
  untrackedFilesScanned=33
  credentialShapeMatches=[]
```

Sensitive files and local state were not touched: `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, and `.omx/`.
