# Auth Benefits Plain Audit Evidence Counts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `fixtures audit --scope auth` and `fixtures audit --scope benefits` plain-text output expose strict evidence counts and missing items, so operators can distinguish transport/generic success from calibrated registration, Pro claim, coupon consumption, and lottery success evidence.

**Architecture:** Reuse the existing `buildProtocolFixtureAudit()` JSON audit as the source of truth. Extend only the non-JSON renderers in `src/ops-cli.js` to print strict count lines and `missing` names already present on the audit object. Do not change fixture matching rules, do not add network calls, and do not read any additional fixture body beyond the existing scope filters.

**Tech Stack:** Node.js ESM, native `node:test`, `src/ops-cli.js`, `test/ops-cli.test.js`, existing auth/benefits fixture audit semantics.

---

### Task 1: RED test for auth plain output

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add `fixtures audit --scope auth prints transport and strict evidence counts in plain output`.

Use sanitized in-memory fixtures:
- `sendVerificationCode` success with only generic `ok:true`, counted as transport success but not delivery evidence;
- `submitRegistrationOrLogin` success without importable session material, counted as transport success but not session-material evidence;
- unrelated `sendMessage` fixture that must not be read.

Expected output includes:

```text
sendVerificationCode_transport_success    1
sendVerificationCode_delivery_success     0
submitRegistrationOrLogin_transport_success    1
submitRegistrationOrLogin_session_material_success    0
missing    successful_sendVerificationCode_fixture,successful_submitRegistrationOrLogin_fixture
```

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth prints transport"
```

Expected: FAIL until the renderer prints strict count lines and missing names.

### Task 2: RED test for benefits plain output

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add `fixtures audit --scope benefits prints strict side-effect counts in plain output`.

Use sanitized in-memory fixtures:
- `dailySignIn` true success;
- `participateActivity` generic success only;
- `participateResetCouponActivity` with consumed-looking fields that must not satisfy true coupon consumption;
- `drawLottery` generic success only;
- unrelated `sendMessage` fixture that must not be read.

Expected output includes operation counts, strict success counts, and:

```text
missing    successful_pro_activity_fixture,successful_reset_coupon_consumption_fixture,successful_lottery_draw_fixture
```

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "benefits prints strict"
```

Expected: FAIL until the renderer prints strict counts and missing names.

### Task 3: GREEN implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Update auth plain renderer**

Keep existing coverage lines and append:
- `sendVerificationCode_transport_success`
- `sendVerificationCode_delivery_success`
- `submitRegistrationOrLogin_transport_success`
- `submitRegistrationOrLogin_session_material_success`
- `missing`

Use `audit.counts` and `audit.missing`.

**Step 2: Update benefits plain renderer**

Keep existing coverage lines and append operation and strict success counts:
- `dailySignIn`, `participateActivity`, `participateResetCouponActivity`, `drawLottery`
- `successful_daily_sign_in`, `successful_pro_activity`, `successful_reset_coupon_consumption`, `successful_lottery_draw`
- `missing`

Use `audit.counts` and `audit.missing`.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`

Document that plain auth/benefits audit output now includes strict evidence counters and missing names, matching the JSON audit contract.

### Task 5: Verification

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
node bin\tabbit-pool.js fixtures audit --scope auth
node bin\tabbit-pool.js fixtures audit --scope benefits
git diff --check
```

Expected: all tests pass; plain audit output contains only aggregate counters and missing names, no raw fixture body or secrets.
