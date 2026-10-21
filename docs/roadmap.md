# Roadmap

Capvine is an OSS authorization library for developers who control application resource handlers and access paths. The core supports delegated permissions for services, workers, and applications; agent tools are one integration. Resource adapters connect verified requests to external APIs or application datastores. A managed service can operate the same enforcement engine later.

This is an implementation sequence, not a delivery-date commitment. Database and runtime adapters described below are planned integrations, not current features.

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

## 2. Application integration and resource adapters

Integrate the verified dispatch path into one application workflow or background job. Establish identity provisioning, grant assignment, and lifecycle behavior before extracting reusable runtime adapters. Document how existing roles or ACLs inform issuance policy. A database-backed read adapter should bind a grant to a defined operation and record while retaining database-side permissions.

**Deliverables:** client identity provisioning, serialized grant assignment, job/resource binding, delegation to workers, and verification on new calls after resume/retry. Optional agent-tool and MCP adapters use the same verifier; MCP sessions require authenticated worker/task bindings rather than model-supplied names.

**Exit criteria:** a complete application workflow works; nested calls cannot expand authority; one job cannot use another job's session; revoked grants fail after workflow restart; direct and adapted calls enforce the same rules. Database adapter tests must verify the actual queried record and permitted operation, not just a successful proof check.

## 3. An OSS release with a supported deployment

Review API ergonomics with application developers, specify the supported ucanto format/version, add schema migrations, and define identity backup/rotation and grant invalidation. Improve audit inspection without logging secrets or resource contents by default. Define and test storage failure behavior.

**Deliverables:** stable package surface, deployment guide, authenticated administration example, storage lifecycle, operational limits, dependency/update policy, and narrowly scoped npm trusted publishing.

**Exit criteria:** independent security review of the profile, verifier integration, and stated deployment boundary; integration/failure tests in that deployment; explicit maintainer approval for publication. The source remains public and MIT licensed while the package is private.

## 4. Scale and broader authority — separate designs

For multiple authority replicas, introduce an async storage contract and shared durable implementation with explicit consistency for revocations/tasks. Add tenant separation, per-principal rate limits, load measurements, and fault tests. The SQLite demo is not a horizontally scalable service.

For writes, bind authorization to exact parameters and implement replay handling, atomic consumption or budgets, concurrency control, and provider idempotency/reconciliation. A timeout must not cause a duplicate side effect. Signatures alone do not provide transaction semantics.

Resource groups, wildcard attenuation, multi-parent grants, budget splitting, and a full delegation explorer need separate semantics and tests. Offline child grants are not currently exhaustively indexed.

**Exit criteria:** each feature's invariants hold under concurrency, retries, storage failures, and revocation races. High-stakes actions are a new supported scope, not a toggle on the read example.

## 5. Optional managed offering

Operate the same OSS verifier with hosted storage, tenant provisioning, identity custody, administration, audit search, monitoring, upgrades, and availability commitments. Managed operations must not become the only place permission enforcement works.

**Exit criteria:** demand from OSS adopters, a supported production boundary, tested tenant isolation/recovery, and clear ownership of keys, data export, and incident response.

## Recommended next milestone

Complete phases 1–2 for **reading selected GitHub issues through an application workflow**. This establishes a live connector, authenticated owner setup, deployment isolation, and end-to-end lifecycle behavior. Keep the permission profile independent of that provider so subsequent database and service adapters can use the same verification path.
