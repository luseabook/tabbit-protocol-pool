# BenefitsMaintainer Failure State Mapping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make M05 maintenance actions update account state when injected protocol operations fail with explicit categories, without guessing real Tabbit endpoints.

**Architecture:** Keep unknown protocol failures non-mutating. Only explicit, stable categories update account metadata: login_required -> login_expired, quota_exhausted -> quota_exhausted, protocol_changed/forbidden -> suspect, and rate_limited/network_error/upstream_error -> cooldown. Action errors and lastError remain redacted.

**Tech Stack:** Node.js ESM, native `node:test`, existing `BenefitsMaintainer`, account metadata fields used by `AccountPool`.

---

### Task 1: RED tests for state-changing maintenance failures

**Files:**
- Modify: `test/benefits-maintainer.test.js`

Add tests that:

- `dailyCheckin()` with `category:"login_required"` sets account status to `login_expired`, records redacted `lastError`, marks action changed, and updates `lastMaintainedAt`.
- `useResetCoupon()` with retryable `category:"rate_limited"` sets account status to `cooldown`, keeps `resetCouponCount`, records `cooldownUntil`, and redacts action error text.

RED evidence:

```powershell
node --test test/benefits-maintainer.test.js
# fail: 2
# expected changed true, actual false for login_required and rate_limited maintenance failures
```

---

### Task 2: Minimal implementation

**Files:**
- Modify: `src/benefits-maintainer.js`

Implement:

- `maintenanceStatusForError(error)` for explicit categories only.
- `applyMaintenanceFailure(account, error, observedAt)` to set status, `lastMaintainedAt`, optional `cooldownUntil`, and redacted `lastError`.
- Catch blocks that return changed failed actions only when state changed.

GREEN evidence:

```powershell
node --test test/benefits-maintainer.test.js
# pass: 13, fail: 0
```

---

### Boundaries

- Does not add real quota/check-in/Pro/reset endpoint paths.
- Unknown maintenance exceptions remain non-mutating failed actions.
- This only consumes explicit categories provided by injected protocol methods.
- Cooldown defaults are local safeguards until real endpoint error semantics are calibrated.

---

### Final verification evidence

```powershell
node --test test/benefits-maintainer.test.js test/ops-cli.test.js
# pass: 44, fail: 0

npm test
# tabbit-protocol-pool pass: 184, fail: 0

cd E:\tabbit2api
npm test
# root pass: 254, fail: 0
```

Post-doc checks:

- Markdown local-link scan: OK, 78 Markdown files checked, 0 broken links.
- Secret scan: OK, 116 text files checked, 0 live-format hits after placeholder allowlist.
- Trailing whitespace scan: OK, 116 text files checked, 0 hits.
- `git diff --check -- tabbit-protocol-pool`: OK.
