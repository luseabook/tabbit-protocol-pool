# Paid Model Routing

## Problem

Cherry Studio can request concrete Tabbit paid models without sending `requiresPremium:true`. The first paid-model routing pass treated `premium_only` and all `Claude-Opus-*` names as a stricter `premium` tier, but current Tabbit Pro accounts can use Opus paid models. The actual failing model is `Claude-Opus-4.7`, which appears in the catalog but returns an upstream unavailable/premium-only error.

## Root Cause

`normalizeModelCatalog()` preserves `model_access_type`, but request routing does not use the catalog metadata to infer paid-model requirements. The previous paid check was then over-corrected: it mapped `premium_only` to a local `premium` tier even though Pro accounts should still be eligible. The runner also lacks a denylist for provider-specific model versions that are known unavailable.

## Scope

- Mark normalized model catalog entries with a boolean `requires_premium` derived from `model_access_type`.
- Treat paid catalog metadata and Opus model-name heuristics as `pro` tier routing, so Pro accounts are eligible.
- Prefer explicit catalog access metadata when present; use Opus model-name heuristics only as the fallback when catalog metadata is unavailable or incomplete.
- Filter `Claude-Opus-4.7` out of normalized model catalogs and `/v1/models` output.
- Return a local `invalid_request/UNSUPPORTED_MODEL` error before touching an account or upstream when a request explicitly targets `Claude-Opus-4.7`.
- Keep free models and `tabbit/priority` routing unchanged.
- Return a stable `NO_AVAILABLE_ACCOUNT` result before touching upstream when no active account satisfies the paid tier.

## Verification

- Add regression tests for catalog metadata, `/v1/models` filtering, runner catalog-based paid routing, `Claude-Opus-4.8` Pro routing, and local `Claude-Opus-4.7` rejection.
- Add a boundary regression proving explicit non-paid catalog metadata wins over the Opus-name fallback.
- Run focused tests, full `npm test`, diff checks, protected-path scan, and credential-shaped diff scan.
