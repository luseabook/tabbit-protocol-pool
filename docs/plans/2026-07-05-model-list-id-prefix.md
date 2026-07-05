# Model List ID Prefix

## Problem

Cherry Studio reads `/v1/models` and displays the OpenAI model `id`. The gateway currently exposes internal IDs such as `tabbit/Claude-Opus-4.8`, so the client UI shows an implementation prefix instead of the actual model ID.

## Scope

- Keep internal normalized catalog IDs and routing compatibility unchanged.
- Strip the `tabbit/` prefix only in the public `/v1/models` response `id`.
- Hide internal/default route aliases from the public list: `priority` and `Default`.
- Keep `tabbit_selected_model` available for clients that need the exact Tabbit selected model.
- Preserve support for requests using either `tabbit/<model>` or `<model>`.

## Verification

- Add HTTP and gateway regression tests proving `/v1/models` emits bare IDs.
- Run focused tests, full `npm test`, diff checks, protected-path scan, credential-shaped diff scan, then deploy and verify the live `/v1/models` response.
