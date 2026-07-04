# Accounts Probe Read-Only Implementation Plan

**Goal:** Let operators safely run a live account/session probe for manual-cookie operations without mutating the default local stateDir.

**Architecture:** Keep `accounts probe <id>` behavior unchanged by default: it verifies the account and persists status changes through `AccountProvisioner.verifyAccount()`. Add an explicit `--read-only` option that still reads account metadata and local session material, and may call the configured verifier, but returns only a sanitized projected account status. It must not call `saveAccounts()` or write readiness/fixture state.

**Why:** During real fixture capture on the default stateDir, `accounts probe acct_default --json` attempted to persist account state under AppData and failed with a permission error. For the manual-cookie release, operators need a preflight command that can classify the current login state before deciding whether to run fixture capture, while preserving the rule that local state fixtures and protected state are not touched unless explicitly approved.

## Task 1: RED Tests

- Add `AccountProvisioner.verifyAccount(..., { readOnly:true })` coverage:
  - missing stored session returns projected `login_expired`;
  - `changed:false`, `wouldChange:true`;
  - account store contents remain unchanged;
  - `saveAccounts()` is not called.
- Add CLI coverage for `accounts probe <id> --read-only --json`:
  - passes `{ readOnly:true }` to the injected verifier;
  - prints `readOnly:true`, `changed:false`, `wouldChange:true`;
  - keeps output redacted.

## Task 2: Implementation

- Extend `AccountProvisioner.verifyAccount(accountId, options)` with `readOnly`.
- In read-only mode, construct the same projected account object and action classification, but skip `upsertAccount()`.
- Extend `accounts probe` help and handler to parse `--read-only`, pass it to the verifier, and include `readOnly` / `wouldChange` in JSON output and a plain summary line.
- Wire default CLI verifier through the new option.

## Task 3: Documentation

- Update README / M08 ops / API reference where `accounts probe` is documented.
- State that `--read-only` may still read local secret material and call the configured verifier, but does not persist account status or fixtures and does not print secrets.

## Task 4: Verification

Run:

```powershell
node --test test\account-provisioner.test.js --test-name-pattern "read-only"
node --test test\ops-cli.test.js --test-name-pattern "accounts probe"
node --test test\account-provisioner.test.js
node --test test\ops-cli.test.js
npm test
git diff --check
```

Then rerun session/upstream audits plus forbidden-path and credential-shape diff scans.

## Execution Status

- RED verified:
  - `node --test test\account-provisioner.test.js --test-name-pattern "read-only"` failed because `verifyAccount()` still persisted `login_expired` and returned `changed:true`.
  - `node --test test\ops-cli.test.js --test-name-pattern "accounts probe --read-only"` failed because the CLI did not pass `{ readOnly:true }` to the verifier.
- GREEN implemented:
  - `AccountProvisioner.verifyAccount(accountId, { readOnly:true })` now returns a projected account, `readOnly:true`, `changed:false`, and `wouldChange`, while skipping `saveAccounts()`.
  - `accounts probe <id> --read-only` passes the option to the verifier and prints `readOnly` / `wouldChange` in JSON and plain output.
  - README, API reference, implementation reference, and M08 ops docs now state that read-only probe does not persist account state or fixture evidence.
- Focused GREEN:
  - `node --test test\account-provisioner.test.js --test-name-pattern "read-only"` -> pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "accounts probe --read-only"` -> pass.
- Live no-write check:
  - `accounts probe acct_default --read-only --json` with protocol base/send/session env configured returned sanitized `readOnly:true`, `changed:false`, `wouldChange:true`, `status:"suspect"`, and forbidden/sign-key advice. It did not fail with the previous default-state `EPERM` write error and did not write a fixture.
- Required verification:
  - `node --test test\account-provisioner.test.js` -> 13/13 pass.
  - `node --test test\ops-cli.test.js` -> 109/109 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 416/416 pass.
  - `git diff --check` -> exit 0, with LF-to-CRLF working-copy warnings only.
  - `fixtures audit --scope session --json` -> blocked with zero session fixtures, as expected for the default stateDir.
  - `fixtures audit --scope upstream --json` -> blocked with zero upstream fixtures, as expected for the default stateDir.
  - `readiness doctor --json` -> blocked; protocol env is configured, but successful verify/send/stream/tool/403 and expired-session fixtures remain missing.
  - Forbidden path scan -> 35 changed/untracked paths, 0 hits.
  - Strict credential-shape scan -> 3981 added/untracked lines, 0 hits.
