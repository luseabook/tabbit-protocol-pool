# Pro Activity Success Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent generic transport success from satisfying activity Pro claim coverage before safe real success evidence exists.

**Architecture:** Keep the benefits fixture audit read-only and scoped to M05 side-effect operations. Tighten only the Pro activity success matcher so `participateActivity` attempts stay visible, but `successful_pro_activity_fixture` requires activity-specific business evidence. The CLI continues to print aggregate coverage only and never reads or emits unrelated fixture bodies.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit()`, `fixtures audit --scope benefits`, and M05/readiness documentation.

---

### Task 1: Document Current Boundary

**Files:**
- Create: `docs/plans/2026-07-04-pro-activity-success-boundary.md`

**Step 1: Record the gap**

Document that the current Pro matcher still accepts generic `result:"success"` or `status:"success"` fields even though docs require a stronger participation/activity/claim success signal.

**Step 2: Define the safe rule**

`successful_pro_activity_fixture` may be ready only when:

- `operation === "participateActivity"`;
- `status === "success"`;
- result does not contain `already_participated` / `already_claimed` non-consumption signals;
- result contains a success value in `participationResult`, `participation_result`, `activityResult`, `activity_result`, `claimResult`, `claim_result`, `proResult`, or `pro_result`.

Generic `ok:true`, `result:"success"`, and `status:"success"` are not enough.

### Task 2: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildProtocolFixtureAudit requires Pro-specific evidence for activity success`.

Use a `participateActivity` fixture with `status:"success"` and only:

```js
result: {
  ok: true,
  status: "success",
  result: "success",
}
```

Expected assertions:

- `counts.participateActivity === 1`;
- `counts.successfulProActivity === 0`;
- `coverage.proActivitySuccess.status === "missing"`;
- `missing` still contains `successful_pro_activity_fixture`;
- serialized audit output does not contain synthetic user, prompt, token, or request payload text.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "Pro-specific evidence"
```

Expected: FAIL because the current matcher accepts generic `result/status:"success"`.

### Task 3: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Extend benefits scope test**

Add a sanitized fixture ref such as `fixtures/protocol-probes/pro-activity-generic-success.json` to `fixtures audit --scope benefits reports side-effect evidence coverage`.

The fixture should use `operation:"participateActivity"`, `status:"success"`, and only generic success fields in `result`.

Expected assertions:

- CLI reads the fixture because it is a benefits side-effect operation;
- `counts.participateActivity` includes it;
- `coverage.proActivitySuccess.count === 0`;
- `missing` still contains `successful_pro_activity_fixture`;
- stdout does not contain synthetic user, prompt, token, request id, or unrelated fixture bodies.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

Expected: FAIL until generic success fields are removed from Pro success matching.

### Task 4: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Tighten matcher**

In `fixtureMatchesProActivitySuccess()`:

- keep the operation/status and non-consumption checks;
- remove generic `result` and `status` from the success key list;
- allow only `participationResult`, `participation_result`, `activityResult`, `activity_result`, `claimResult`, `claim_result`, `proResult`, and `pro_result`.

**Step 2: Preserve counters**

Do not remove `participateActivity` from `BENEFITS_AUDIT_OPERATIONS`; failed or generic-success attempts must remain visible in operation totals.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M05-权益额度维护/活动Pro领取.md`

**Step 1: Update audit wording**

Document that benefits scope requires Pro-specific participation/activity/claim/pro success fields. Generic `ok/status/result:"success"` is not enough for activity Pro success, just as generic success is not enough for lottery success.

### Task 6: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused checks**

```powershell
node --test test\observability.test.js --test-name-pattern "Pro-specific evidence"
node --test test\ops-cli.test.js --test-name-pattern "scope benefits"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 3: External aggregate checks**

With `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and explicit protocol env, run:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope benefits --json
```

Only inspect aggregate JSON. Do not print raw fixture files.

**Step 4: Secret boundary**

Run `git diff --check`, forbidden-path scan, and raw secret pattern scan. Confirm no forbidden local files were touched.
