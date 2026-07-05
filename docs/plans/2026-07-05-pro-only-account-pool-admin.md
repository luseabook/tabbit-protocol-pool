# Pro-Only Account Pool Admin

## Problem

The admin UI and routing logic currently expose a local `premium` account tier. Current Tabbit product evidence only shows `free` and `pro`, and the imported account is already on the highest visible plan. Showing or requiring a `premium` account tier is misleading and makes `premium_only` catalog entries impossible to operate from the admin UI.

## Root Cause

The gateway treated upstream `premium_only` model metadata and `premium users only` error copy as proof of a third local account tier. That conflates two different concepts:

- Account plan: the visible Tabbit plan, currently `free` or `pro`.
- Model capability: whether the current protocol/session can actually serve a specific model.

`premium_only` should remain model metadata / entitlement signal, not a selectable local account plan.

## Scope

- Limit admin-import account tiers to `unknown`, `free`, and `pro`.
- Treat `premium_only`, paid metadata, and Opus model-name heuristics as requiring the highest local `pro` tier.
- Keep upstream `premium users only` errors classified as `model_entitlement` without downgrading the account.
- Keep known unavailable model IDs on a denylist, currently `Claude-Opus-4.7`.
- Redesign the account-pool admin view as an operations page: compact summary, account table, status badges, row actions, and a separate import panel.
- Redesign the unauthenticated `/admin` view as a standalone login page: hide the sidebar, menus, and operational panels until Basic login succeeds.
- Keep Tabbit sessions/cookies write-only in the UI; only gateway request keys may be revealed and copied.

## Verification

- Add failing tests proving `premium_only` maps to `pro`, Opus routes through Pro accounts, and `premium` import is rejected.
- Add an HTML regression test so the admin account import selector no longer contains `Premium`.
- Add an admin-shell regression test proving the page starts in `auth-mode`, switches to `admin-mode` after login, and returns to `auth-mode` on logout.
- Run focused tests for `model-access`, `account-pool`, `pooled-request-runner`, `protocol-pool-gateway`, and `http-server`.
- Run full `npm test`, `git diff --check`, protected-path scan, and credential-shaped diff scan before deployment.
