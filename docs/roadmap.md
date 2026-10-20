# Roadmap

The first product is a self-hostable OSS authorization library and service integration for developers who own their agent tool backend. It fits existing runtimes and connectors. A managed service can operate the same enforcement engine later. This is an implementation sequence, not a delivery-date commitment.

## 0. Runnable proof of the boundary — implemented

- [x] A TypeScript package built on ucanto.
- [x] Exact operation/resource/task/service binding.
- [x] Recipient-bound delegation with shorter lifetimes.
- [x] Server verification of serialized requests independent of client checks.
- [x] Parent/child revocation and task termination.
- [x] Memory and SQLite state with restart tests.
- [x] An offline GitHub-shaped example and adversarial authorization tests.
- [x] A bounded Node HTTP handler and client transport.
- [x] Separate authority, coordinator, and workers with a simulated credentialed provider.
- [x] Parallel reads, raw escalation attempts, independent-root revocation, and task-end checks across HTTP.

**Evidence:** `npm run check`, `npm run example`, and `npm run example:network -- --workers 3`. The network scenario is an automated test too. This establishes an application permission path, not OS isolation or production readiness.

## 1. One real read-only provider

Build an authenticated owner setup flow and one GitHub issue reader. Select the connection and stable provider object identity through trusted code. Keep credentials in the connector and limit their upstream permissions. Pin or verify the actual target where provider API routes use mutable names.

**Deliverables:** owner authentication integration; resource, grant, and task administration; persistent service identity; a minimal deployment with separate worker and authority access.

**Exit criteria:** a worker reads its selected issue; changing connection, issue, action, or owner fails before dispatch; deployment permissions deny worker access to credentials/state; restart preserves grants and revocations. Document provider limits and credential permissions.

## 2. One runtime adapter, then MCP interoperability

Pick one adopter first: Simon's harness through MCP, an agent-unit tool handler, or a modebox host function. Keep the same enforcement path. Build a reusable adapter after establishing the lifecycle requirements.

**Deliverables:** worker identity provisioning, serialized grant assignment, task/tool binding, child delegation, and verification on new calls after resume/retry. MCP sessions need authenticated worker/task bindings; model-supplied names are not identity.

**Exit criteria:** a complete real agent task works; prompted or nested calls cannot expand authority; one task cannot use another task's session; revoked grants fail after workflow restart; direct and adapted calls enforce the same rules.

## 3. An OSS release with a supported deployment

Review API ergonomics with the adopter, specify the supported ucanto format/version, add schema migrations, and define identity backup/rotation and grant invalidation. Improve audit inspection without logging secrets or tool contents by default. Define and test storage failure behavior.

**Deliverables:** stable package surface, deployment guide, authenticated administration example, storage lifecycle, operational limits, dependency/update policy, and narrowly scoped npm trusted publishing.

**Exit criteria:** independent security review of the profile, verifier integration, and stated deployment boundary; integration/failure tests in that deployment; explicit maintainer approval for publication. The source remains public and MIT licensed while the package is private.

## 4. Scale and broader authority — separate designs

For multiple authority replicas, introduce an async storage contract and shared durable implementation with explicit consistency for revocations/tasks. Add tenant separation, per-principal rate limits, load measurements, and fault tests. The SQLite demo is not a horizontally scalable service.

For writes, bind approval to exact parameters and implement replay handling, atomic consumption or budgets, concurrency control, and provider idempotency/reconciliation. A timed-out payment must not silently become a second payment. Signatures alone do not solve this.

Resource groups, wildcard attenuation, multi-parent grants, budget splitting, and a full delegation explorer need separate semantics and tests. Offline child grants are not currently exhaustively indexed.

**Exit criteria:** each feature's invariants hold under concurrency, retries, storage failures, and revocation races. High-stakes actions are a new supported scope, not a toggle on the read example.

## 5. Optional managed offering

Operate the same OSS verifier with hosted storage, tenant provisioning, identity custody, administration, audit search, monitoring, upgrades, and availability commitments. Managed operations must not become the only place permission enforcement works.

**Exit criteria:** demand from OSS adopters, a supported production boundary, tested tenant isolation/recovery, and clear ownership of keys, data export, and incident response.

## Recommended next milestone

Choose one adopter and complete phases 1–2 for **reading selected GitHub issues**. That gives us a real tool with account data, owner setup, deployment isolation, and end-to-end runtime behavior before expanding to Gmail, Slack, arbitrary code, or financial actions.
