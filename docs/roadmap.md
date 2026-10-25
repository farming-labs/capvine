# Roadmap

Capvine is an OSS authorization library for applications, services and workers. Agent tools are one integration. The current package supports delegated, exact-resource reads through trusted application handlers. Version `0.0.1` is published as an experimental preview; it has not completed independent review or production deployment acceptance.

This roadmap separates implemented code, acceptance work that needs real operators or reviewers, and proposed features. It sets an order of work, not delivery dates or authorization to publish another version.

## Current implementation

| Area                   | Delivered                                                                                                                                                       | Evidence and limits                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorization          | ucanto proofs, exact resource/action/task/service binding, recipient-bound delegation, shorter lifetimes, server verification, revocation and task termination. | Raw signed-request tests and separate-process examples. Permissions do not sandbox clients or restrict disclosure of returned data.        |
| Service and state      | Persistent identity, SQLite permission state, schema checks, authenticated single-owner administration, restart and bounded invocation audit.                   | Service and recovery tests. Shared storage, multiple replicas and a complete administration-change ledger are not implemented.             |
| Resources              | Bounded reads of registered files, PostgreSQL records, public GitHub issues, Gmail messages and Slack messages.                                                 | Real file/database tests and live public GitHub reads. PostgreSQL as a resource is separate from a shared backend for permission state.    |
| Account connections    | Direct OAuth/OIDC, encrypted credentials, token refresh, disconnect/reconnect and provider identity binding.                                                    | Google has a local live read/refresh smoke check. Full Google consent-revocation/reconnection and live Slack validation remain open.       |
| Application API        | Provider/resource plugins, owner-session integration, runtime registration, saved approvals, bounded renewal and disable.                                       | Application and fresh-consumer tests. Authentication and privileged plugin code remain the host application's responsibility.              |
| Worker integration     | Private identity/assignment files, child delegation, HTTP invocation and provisioned stdio MCP workers.                                                         | Separate-process reads, restart, renewal and denial tests. Public remote MCP sessions and multi-tenant administration are not implemented. |
| Owner experience       | Account connection, resource discovery, exact-scope review and saved-workflow controls in local consoles.                                                       | Fixture coverage and a separate live Gmail screen. The application owner console still needs an adopter browser walkthrough.               |
| Release and operations | Recovery drill, provider/deployment probes, review packet, package inspection and tag-bound staging workflow.                                                   | Linux reference isolation and package checks pass. The actual host, independent review and npm OIDC staging still need evidence.           |

The manual `0.0.1` registry release and fresh consumer installation are verified. See [release notes](releases/0.0.1.md), [application integration](application.md), [resource adapters](resources.md) and [security limits](../SECURITY.md).

## Next milestone: validate one read-only deployment

[Milestone 1](https://github.com/farming-labs/capvine/milestone/1) and [tracker #16](https://github.com/farming-labs/capvine/issues/16) cover a single-owner, single-authority Linux application with isolated workers. The tracker stays open until acceptance is complete. The experimental release is already available; this milestone establishes evidence for a specifically supported deployment and integration scope.

| Work                                                                                 | Current state                                              | Completion criteria                                                                                                                             | Required input                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [npm trusted publishing #45](https://github.com/farming-labs/capvine/issues/45)      | Workflow and GitHub approval environment implemented.      | Verify staging-only registry trust, then an actual OIDC stage and provenance on the next explicitly approved release.                           | Maintainer npm login with 2FA and a separately approved release candidate. |
| [Google lifecycle #47](https://github.com/farming-labs/capvine/issues/47)            | Real read, refresh, restart and local revocation observed. | Revoke consent in Google, reconnect with a fresh binding, and show the retained old worker remains denied.                                      | Dedicated test project/account and a non-sensitive selected message.       |
| [Slack lifecycle #48](https://github.com/farming-labs/capvine/issues/48)             | Provider implementation and fixture tests complete.        | Observe real consent, identity/scope checks, rotation, restart, provider revocation and fresh reconnection without restoring old-worker access. | Dedicated test app/workspace configured for the supported flow.            |
| [Actual deployment #49](https://github.com/farming-labs/capvine/issues/49)           | Reference isolation and validation tools complete.         | Integrate a reproducible launcher/transport on the intended host; verify access paths, HTTPS ingress, secret custody, recovery and monitoring.  | Authorized Linux host, application configuration and responsible operator. |
| [Independent security review #50](https://github.com/farming-labs/capvine/issues/50) | Review packet prepared.                                    | Review a fixed candidate and deployment, resolve findings, retest and record residual risks.                                                    | Independent reviewer and the selected deployment boundary.                 |
| [Adopter API review #51](https://github.com/farming-labs/capvine/issues/51)          | Application/plugin guides and consumer checks complete.    | An adopter integrates the published package into an application; agreed API/setup fixes are implemented and retested.                           | Application developer and an actual integration.                           |

Provider testing, adopter integration and deployment preparation can proceed in parallel. Independent review can be scoped early; its final record must cover the selected candidate and deployment, including remediation. npm setup does not block that work. No new package version is needed merely to test credentials.

Record observed results against the same candidate using [acceptance records](acceptance.md). Internal fixtures, a settings form, or a merged helper do not close an external acceptance item. Maintainers must separately accept the evidence and choose support/compatibility commitments. A later release requires its own version and artifact approval.

## Next code increment: permission inspection

[Issue #52](https://github.com/farming-labs/capvine/issues/52) proposes a bounded, authenticated view of recorded grants and authorization outcomes. It can be developed while external validation is being arranged, using feedback from the adopter review.

The first increment should let an owner inspect a recorded root grant's recipient, exact resource/action/task/service, expiry and revocation state, together with task/workflow status and available invocation outcomes. Reuse the existing owner/administration boundary and state stores. Provide bounded pagination and a CLI/API walkthrough before expanding the UI.

Do not expose private keys, raw proofs, provider credentials or resource contents. A worker proof must not authorize owner inspection. Recorded state does not promise that a provider call will succeed, and revocation does not cancel an operation already dispatched.

Offline child delegations are not exhaustively indexed today. The first inspector must state that limit rather than render an apparently complete delegation tree. A complete explorer needs a separate registration/indexing design. This issue adds visibility without changing issuance or delegation semantics.

**Exit criteria:** authenticated inspection works across restart; unauthorized and cross-owner access, oversized queries and storage failures reject; status distinguishes expiry, recorded revocation and task/workflow disable; the walkthrough demonstrates an allowed read followed by denial after parent revocation.

## Later designs

These are proposals, not current capabilities or requirements for the first single-authority read-only milestone. Select one demonstrated integration need at a time and open a design issue before implementation.

| Proposed work                                 | Decisions and evidence needed before support                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple owners and remote MCP                | Tenant-bound owner/resource/worker identities, authenticated sessions and discovery, credential isolation, per-principal limits and cross-tenant rejection tests. Reuse the same verifier.                                                                    |
| Shared permission state and multiple replicas | An async storage contract, durable shared backend, transactions and explicit consistency for revocation, task disable, renewal and failures. Load/fault tests must cover multiple real processes. A PostgreSQL resource adapter does not supply this backend. |
| Write operations                              | Bind exact parameters; define replay handling, durable idempotency, concurrent execution, provider reconciliation after timeouts and any single-use or budget accounting. Test crashes/retries before supporting irreversible effects.                        |
| Broader delegation and full explorer          | Specify resource groups, wildcard attenuation, multiple parents, budget splitting or child indexing separately. Preserve current exact bindings until new semantics and migration are reviewed.                                                               |
| More resources and usability                  | Add providers, discovery interfaces such as a Slack message picker, binary streaming or resource groups in response to concrete adopter needs. Each connector needs target-binding and credential-lifecycle tests.                                            |
| macOS computer-use containment                | Assess accessibility, browser sessions, shell access, account separation and alternate credential paths on the actual host. Linux container tests do not establish this boundary.                                                                             |
| Managed service                               | Establish OSS demand and a supported deployment first, then design tenant provisioning, identity custody, administration, audit search, monitoring, recovery, data export and availability commitments. OSS enforcement must remain independently usable.     |

## Evidence and completion rules

- Keep code completion separate from live-provider, host and review acceptance. Update the linked issue when its evidence changes.
- Preserve the exact source revision, package/image digests, deployment scope and redacted results. Keep credentials, raw proofs, private account data and sensitive findings out of public issues.
- Use [provider validation](provider-validation.md), [deployment/recovery](deployment.md), the [review packet](security-review.md) and [release procedure](trusted-publishing.md) instead of duplicating those workflows in this document.
- Record external requirements as pending until they are observed. Do not silently skip a provider, substitute a fixture for an actual host, or mark a reviewer decision complete from internal tests.
- Close the deployment tracker only when its child checks and explicit support decision are complete. Continue to state the supported scope; publication cannot establish zero-risk operation.
