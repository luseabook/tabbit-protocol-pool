**Goal:** Let protocol probes that require `userId` recover it from the already-calibrated session verifier in memory, so browser-derived commerce probes can run when the local account metadata lacks a stored user id.

**Scope:** This slice only changes `ProtocolProbeRunner` runtime input preparation. It does not persist user ids, does not print user ids, does not weaken fixture sanitization, and does not mark Pro, reset-coupon, lottery, auth, session recovery, or upstream stream coverage ready.

**Why:** Live evidence showed `acct_default` has a valid session and `verifySession` can return a user id, while the account metadata has no persisted `userId`. As a result, `listBenefitCoupons` failed before it could read safe aggregate coupon state. Running `verifySession` in memory unblocks read-only commerce evidence gathering without touching local state or exposing raw values.

## Safety

- Do not write to `E:\tabbit2api\output\tabbit-live-state`.
- Do not print or document the recovered user id.
- Do not add the recovered user id to fixtures except through the existing sanitizer, which must continue to redact user identifiers.
- Only use this fallback when a protocol operation actually needs `userId` and neither input nor account metadata provides it.
- If verification fails, continue with existing behavior and let the underlying operation return its normal classified error.

## RED

Add focused `ProtocolProbeRunner` coverage:

- `listBenefitCoupons` with no input `userId` and no account `userId` should call `client.verifySession()`, use the returned user id only for the subsequent `listBenefitCoupons()` call, and avoid mutating the stored account object.
- If `input.userId` is present, the runner should not call `verifySession()`.

Expected RED failure: current runner passes `undefined` as `userId` and never calls `verifySession()` for `listBenefitCoupons`.

## GREEN

Implement a small helper inside `ProtocolProbeRunner`:

- detect operations that need a user id;
- check input first, then runtime account metadata;
- call `client.verifySession({ account, session })` only when needed and available;
- clone/augment the runtime account in memory;
- pass the hydrated user id into the target operation.

Keep this scoped to existing probe operations. Do not add new endpoints or body guesses.

## Verification

Run:

```powershell
node --test --test-name-pattern "hydrates missing userId" test\protocol-probe.test.js
node --test test\protocol-probe.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then run aggregate-only external checks with `TABBIT_POOL_PROTOCOL_FIXTURE_DIR=E:\tabbit-protocol-pool\tmp\live-fixtures` and no raw fixture output.

## Evidence Log

### Baseline

- External live-state with `tmp/live-fixtures` still had the main gateway readiness evidence, but calibration backlog stayed blocked on auth, Pro/reset/lottery, session recovery, and upstream boundary evidence.
- `acct_default` account metadata did not contain a persisted user id, while read-only `verifySession` could recover one in memory.
- Before implementation, `probe protocol --operation listBenefitCoupons` without an explicit `userId` failed at the commerce operation boundary.

### RED

- `node --test --test-name-pattern "hydrates missing userId|does not verify session" test\protocol-probe.test.js` failed as expected:
  - `listBenefitCoupons` was called directly;
  - `verifySession` was not called;
  - both runtime-account `userId` and operation `userId` were `undefined`.

### GREEN

- `ProtocolProbeRunner` now hydrates missing user ids only for read-only user-id probe operations:
  - `refreshQuota`;
  - `listRewardCardRecords`;
  - `listLotteryHitRecords`;
  - `listBenefitCoupons`;
  - `getAvailableLotteryChanceCount`.
- Explicit `input.userId` still wins and avoids the extra verifier call.
- The recovered user id is attached only to the runtime account clone for the current probe call and is not written back to the account store.
- Boundary RED/GREEN:
  - if the target operation method is missing, runner reports `protocol_missing` without calling `verifySession`;
  - if `verifySession` throws while hydrating `userId`, runner keeps the target operation's own classification instead of replacing it with the verifier error.

### Live Verification

- With external live state and no explicit `userId`, `probe protocol --account acct_default --operation listBenefitCoupons --json` returned a sanitized success fixture shape.
- The command output summary contained only:
  - `status=success`;
  - `advice=unknown`;
  - result key names `ok,raw,records,source,total`.
- No recovered user id, cookie, session, token, raw payload, or coupon value was printed.
