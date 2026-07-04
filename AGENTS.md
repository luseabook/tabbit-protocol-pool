# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js ES module package for a protocol-first Tabbit account pool gateway. Runtime source lives in `src/`, with focused modules such as `protocol-tabbit-client.js`, `protocol-probe.js`, `ops-cli.js`, account stores, gateway handlers, and redaction utilities. The CLI entrypoint is `bin/tabbit-pool.js`. Tests are in `test/` and mirror the source modules by concern. Project documentation is under `docs/`, with implementation plans and verification notes in `docs/plans/`. Helper scripts live in `scripts/`.

## Build, Test, and Development Commands

- `npm test`: runs the full tracked Node test suite through `scripts/run-tests.mjs`.
- `node --test test\ops-cli.test.js`: runs CLI and readiness/audit coverage.
- `node --test test\protocol-tabbit-client.test.js`: runs Tabbit protocol client coverage.
- `node bin\tabbit-pool.js readiness doctor --json`: prints aggregate readiness diagnostics.
- `node bin\tabbit-pool.js fixtures audit --scope session --json`: audits sanitized session fixture coverage.

Use PowerShell on Windows unless a command explicitly requires another shell.

## Coding Style & Naming Conventions

Use modern JavaScript ES modules, two-space indentation, semicolons, and small exported functions with explicit error categories. Keep filenames kebab-case in `src/` and `test/`. Prefer structured objects and existing redaction helpers over ad hoc string parsing. Do not introduce broad abstractions unless they remove real duplication or match existing module boundaries.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`. Place tests in `test/*.test.js`, named after the module or workflow under test. Add focused regression tests for new readiness gates, CLI output, redaction behavior, and protocol boundary handling. For protocol evidence work, tests must prove raw payloads, prompts, cookies, tokens, and user data are not printed.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, for example `Calibrate manual cookie operations readiness`. Include a short body explaining behavior and risk. Record verification with `Tested:` lines and include `Confidence:` when useful. PRs should summarize changed behavior, documentation updates, validation commands, and remaining blocked backlog items.

## Security & Configuration Tips

Never commit or print real cookies, sessions, JWTs, API keys, Bearer tokens, raw payloads, prompts, stream text, or real user data. Do not modify or commit `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/`. External state checks must report aggregate status only.
