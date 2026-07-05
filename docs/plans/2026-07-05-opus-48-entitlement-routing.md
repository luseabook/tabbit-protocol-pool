# Opus 4.8 Entitlement Routing

> Superseded on 2026-07-05 by `2026-07-05-pro-only-account-pool-admin.md`: current Tabbit product evidence shows only Free and Pro account plans. The gateway no longer treats `premium_only` as a local account tier; it maps paid/premium-only catalog metadata to the highest visible Pro tier and keeps upstream premium wording as `model_entitlement` diagnostics.

## Problem

Cherry Studio can see and request `Claude-Opus-4.8`, but the live gateway account receives an upstream Tabbit error: `Model Claude-Opus-4.8 is available to premium users only`. The current gateway treated `premium_only` catalog models and `Claude-Opus-*` names as local `pro` tier requirements, so a stored account marked `accessTier: "pro"` was selected and the upstream entitlement error reached the client.

## Root Cause

The earlier routing assumption collapsed Tabbit paid access into one local `pro` tier. Live evidence shows `premium_only` Opus models need a stricter local `premium` account for the gateway. The stream error frame also classified the upstream premium-only response as `unknown`, which put the selected account into cooldown and made the operational signal misleading.

## Scope

- Map `premium_only` catalog metadata to local `premium` tier while keeping `pro` metadata on local `pro`.
- Treat `Claude-Opus-*` and explicit premium model names as local `premium` tier when catalog metadata is unavailable.
- Superseded: `/v1/models` is still filtered against the currently selectable account pool, but `premium_only` now requires active Pro rather than a separate Premium tier.
- Superseded: admin session import now accepts only `unknown` / `free` / `pro`; `premium` is not a valid new account import tier.
- Keep free/default routing behavior unchanged.
- Classify upstream premium-only / upgrade-required stream errors as a stable model entitlement category instead of `unknown`.
- Preserve non-secret diagnostics only; do not print cookies, gateway keys, or prompts.

## Verification

- Add failing regression tests for premium-only routing, no-premium local rejection, model-list account-tier filtering, and upstream premium-only error classification.
- Run focused tests for `model-access`, `pooled-request-runner`, `protocol-pool-gateway`, `protocol-tabbit-client`, and `http-server`.
- Run full `npm test`, `git diff --check`, protected-path scan, and a credential-shaped diff scan.
- Deploy to the server, restart `tabbit-pool`, and smoke `/v1/models` plus a local `Claude-Opus-4.8` request without printing secrets.
