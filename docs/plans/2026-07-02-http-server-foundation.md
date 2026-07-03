# HTTP Server Foundation Implementation Plan

## Scope

Add a minimal native node:http route adapter for tabbit-protocol-pool. The route adapter exposes health, models, Chat Completions, and Responses JSON endpoints while reusing OpenAICompat for request semantics.

Out of scope for this plan:

- SSE streaming.
- Anthropic Messages handler.
- Assistants、Threads、Realtime。
- Public network deployment guidance.
- Real Tabbit send endpoint restoration.

## Current state

- OpenAICompat already returns { status, body } for Chat Completions and Responses.
- PooledRequestRunner already handles account selection, success recording, failure recording, and account fallback.
- ProtocolTabbitClient can list models and normalize model catalog.
- No HTTP server file exists yet.

## Design

Add src/http-server.js with these exports:

~~~ts
createProtocolPoolServer({ apiKey, compat, modelsProvider, health }): http.Server
readJson(req): Promise<unknown>
writeJson(res, status, body): void
isAuthorized(req, apiKey): boolean
openAiHttpError(status, message, type, code): { status, body }
~~~

Route matrix:

| Method | Path | Handler |
|---|---|---|
| GET | /health | static or injected health object |
| GET | /v1/models | modelsProvider.listModels or modelsProvider function |
| POST | /v1/chat/completions | compat.handleChatCompletions |
| POST | /v1/responses | compat.handleResponses |

## TDD tasks

### Task 1: Health and JSON writer

Red test:

- create server with minimal compat stub。
- request GET /health。
- assert 200, content-type application/json, body contains { status:'ok', mode:'protocol-pool' }。

Implementation:

- create node:http server。
- add writeJson helper。
- keep /health unauthenticated。

### Task 2: Authentication boundary

Red test:

- POST /v1/chat/completions without Authorization。
- assert 401 OpenAI error envelope。
- repeat with Authorization: Bearer sk-tabbit-local and assert handler is called。

Implementation:

- isAuthorized accepts Authorization Bearer and x-api-key。
- default apiKey is sk-tabbit-local。

### Task 3: JSON body parsing

Red test:

- POST malformed JSON with valid auth。
- assert 400 invalid_request_error。
- POST empty body and assert {} reaches handler。

Implementation:

- read request chunks as UTF-8。
- empty body returns {}。
- JSON.parse failure maps to 400。

### Task 4: OpenAI route wiring

Red test:

- POST /v1/chat/completions calls compat.handleChatCompletions with parsed body and writes returned status/body。
- POST /v1/responses calls compat.handleResponses with parsed body and writes returned status/body。

Implementation:

- no request normalization in route layer。
- no account or protocol logic in route layer。

### Task 5: Models and not found

Red test:

- GET /v1/models with auth returns { object:'list', data:[...] }。
- unknown route returns 404 not_found error。

Implementation:

- normalize ProtocolTabbitClient model entries to OpenAI model shape。
- add default not_found envelope。

### Task 6: Exports and documentation

Red test:

- smoke import from src/index.js includes createProtocolPoolServer。

Implementation:

- export HTTP helpers from src/index.js。
- update README, docs/04, docs/07, docs/08, and M06 docs。

## Regression commands

~~~powershell
cd tabbit-protocol-pool
npm test
cd ..
npm test
~~~

Run markdown link check after doc updates. If package metadata changes, run npm pack dry run from root.

## Acceptance criteria

- test/http-server.test.js covers health, auth, bad JSON, Chat route, Responses route, models route, and 404。
- Existing 43 protocol-pool tests still pass。
- Root project tests still pass。
- No examples contain real API keys, cookies, tokens, or email inbox contents。
- Default bind address remains 127.0.0.1 through loadConfig。


## Implementation result

Completed in this workspace:

- Added src/http-server.js with createProtocolPoolServer(), readJson(), writeJson(), isAuthorized(), and openAiHttpError().
- Added test/http-server.test.js with health, auth, bad JSON, Chat route, Responses route, models route, empty body, incorrect key, and 404 coverage.
- Exported HTTP helpers from src/index.js and updated smoke coverage.

Verified commands:

~~~powershell
cd tabbit-protocol-pool
node --test test/http-server.test.js test/smoke.test.js
~~~

Full regression still required before completion:

~~~powershell
cd tabbit-protocol-pool
npm test
cd ..
npm test
~~~
