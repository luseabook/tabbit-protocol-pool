# Send Message Stream Evidence Template Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let operators generate safe `sendMessage` probe input templates with an explicit upstream `streamEvidence` mode, without hand-editing JSON.

**Architecture:** Keep the default `probe template --operation sendMessage` output unchanged. Add opt-in CLI flags that only affect `sendMessage`: `--stream-evidence <mode>` and optional `--max-deltas <1..5>`. Reuse the existing allowed modes and bounds so generated templates pass the same `probe validate` schema and contain no prompt, endpoint, payload, cookie, session, token, or real user data.

**Tech Stack:** Node.js ESM, native `node:test`, existing `runProtocolPoolCli()`, `probe template`, `probe validate`, and Markdown docs.

---

### Task 1: RED Template Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `probe template --operation sendMessage can include streamEvidence mode`.

The test should run:

```powershell
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence error_frame --json
```

Expected JSON:

```json
{
  "model": "tabbit/priority",
  "messages": [{ "role": "user", "content": "<redacted-message-content>" }],
  "stream": true,
  "streamEvidence": { "mode": "error_frame", "maxDeltas": 2 }
}
```

Then pass the generated JSON through `probe validate --operation sendMessage --input-json <json> --json` and assert it validates and only prints field/mode metadata.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "streamEvidence mode"
```

Expected before implementation: FAIL because `probe template` ignores `--stream-evidence`.

### Task 2: RED Validation Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write invalid-option cases**

Add a test named `probe template rejects invalid streamEvidence template options`.

Cases:
- `--stream-evidence full_raw_stream` -> exit `2`, stderr mentions `streamEvidence.mode`.
- `--stream-evidence error_frame --max-deltas 0` -> exit `2`, stderr mentions `maxDeltas`.
- `--operation verifySession --stream-evidence error_frame` -> exit `2`, stderr mentions `sendMessage`.
- `--operation sendMessage --max-deltas 2` without `--stream-evidence` -> exit `2`, stderr mentions `--stream-evidence`.

Assert stderr does not contain prompt/cookie/session/token-like values.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "streamEvidence template options"
```

Expected before implementation: FAIL because the template command currently ignores these flags.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Parse safe template flags**

Add parsing for:
- `--stream-evidence <mode>`
- `--max-deltas <integer>`

Only `sendMessage` may use `--stream-evidence`. `--max-deltas` requires `--stream-evidence`. Mode must be one of `STREAM_EVIDENCE_MODES`; max deltas must be an integer from `1` to `MAX_STREAM_EVIDENCE_DELTAS`.

**Step 2: Add template data**

When valid, clone the existing `sendMessage` template, force `stream:true`, and add:

```js
streamEvidence: { mode, maxDeltas }
```

Default `maxDeltas` is `2`.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/plans/2026-07-04-send-message-stream-evidence-template.md`

**Step 1: Document usage**

Document that upstream capture commands can be turned into a ready input skeleton with:

```powershell
node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence error_frame --json
```

and that operators must still review the redacted input, run `probe validate`, and only persist sanitizer output.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "streamEvidence mode|streamEvidence template options"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files. Expected: no sensitive path edits and no raw credential-shaped values in added lines.

---

## Execution status 2026-07-04

- Task 1 RED: `node --test test\ops-cli.test.js --test-name-pattern "streamEvidence mode"` initially failed because `probe template` ignored `--stream-evidence`.
- Task 2 RED: `node --test test\ops-cli.test.js --test-name-pattern "streamEvidence template options"` initially failed because invalid template options were accepted.
- Task 3 GREEN: `src/ops-cli.js` now parses `--stream-evidence` / `--max-deltas`, restricts them to `sendMessage`, reuses the existing stream evidence modes and 1..5 delta bound, and emits a safe `stream:true` template skeleton.
- Focused verification after implementation: `node --test test\ops-cli.test.js --test-name-pattern "streamEvidence mode"` passed; `node --test test\ops-cli.test.js --test-name-pattern "streamEvidence template options"` passed.
- Task 4 documentation: README, implementation reference, real protocol acceptance doc, and this plan now describe the safe template workflow and the required validate-before-probe gate.
- Required verification: `node --test test\ops-cli.test.js` passed 108/108, `node --test test\protocol-tabbit-client.test.js` passed 61/61, `npm test` passed 408/408, and `git diff --check` exited 0 with only line-ending conversion warnings.
- Safety verification: forbidden-path scan checked 23 changed or untracked paths with 0 hits; credential-shape scan checked 2202 added or untracked lines with 0 hits.
