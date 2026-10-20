# Roadmap

## Working prototype

- [x] A TypeScript package built on ucanto.
- [x] Exact operation/resource/task/service binding.
- [x] Recipient-bound delegation with shorter lifetimes.
- [x] Server verification of serialized requests independent of client checks.
- [x] Parent/child revocation and task termination.
- [x] Memory and SQLite state with restart tests.
- [x] An offline GitHub-shaped example and adversarial authorization tests.

## Next: one real integration boundary

- [ ] Separate the example worker and protected authority into different processes.
- [ ] Add a minimal bounded HTTP transport and an authenticated owner administration example.
- [ ] Add one read-only GitHub connector using stable provider resource identifiers and server-held credentials.
- [ ] Demonstrate that agent-controlled names and arguments cannot retarget the actual provider request.
- [ ] Add an MCP adapter with explicit authenticated task/worker bindings and equivalent enforcement across direct and nested tool calls.
- [ ] Test deployed credential and network isolation, not only the SDK call path.

## Before a public package release

- [ ] Review API ergonomics with an application developer.
- [ ] Document supported UCAN/ucanto versions and upgrade policy.
- [ ] Add a versioned storage migration strategy and key rotation design.
- [ ] Improve structured authorization errors and audit inspection without exposing secrets.
- [ ] Obtain independent security review of the profile, verifier integration, and supported deployment boundary.
- [ ] Configure npm trusted publishing with narrowly scoped release permissions.

## Later

Write operations require a separate design covering replay, exact-action approval binding, concurrency, retries, and provider idempotency. Resource sets and budgets require explicit attenuation semantics. A managed offering can operate the same OSS enforcement engine after these boundaries are established.
