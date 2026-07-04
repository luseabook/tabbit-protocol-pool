# npm test tracked suite boundary

**Goal:** Keep `npm test` as a reliable repository verification command even when unrelated local, untracked scratch tests exist under `test/`.

**RED evidence:** `npm test` failed after Node's default test discovery picked up untracked contract tests for a different package shape (`tabbit2api`, `src/cli.js`, `src/gateway.js`, `ws`, and `src/profile.js`). The tracked repository tests used by this project still passed in focused runs.

**Implementation plan:**

1. Add a small Node runner that invokes `node --test` with the repository's tracked test files.
2. Point `package.json` `test` script at that runner.
3. Re-run `npm test`, `git diff --check`, and safety scans.

**Safety boundary:** Do not delete, edit, or reinterpret the untracked external tests. Do not add dependencies or rename the package to satisfy an unrelated contract.

## Verification Log

- RED: `npm test` failed because default Node test discovery picked up untracked `tabbit2api` contract tests and tried to import modules/packages that are outside this repository contract.
- GREEN: after adding `scripts/run-tests.mjs` and pointing `package.json` at the tracked suite runner, `npm test` reported 396/396 passing.
