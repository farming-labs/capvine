# Release readiness

The source is public and MIT licensed. The package remains `private: true`, version `0.0.0`, and has no enabled publish workflow. Successful CI demonstrates the listed behavior; it is not independent security review, production approval, or a registry release.

## Compatibility contract

The current proof format is the CAR archive produced by the pinned ucanto dependencies, carrying UCAN **0.9.1** and one `capvine/invoke` capability. It is not a claim to implement the current UCAN working-group specification or arbitrary UCAN profiles. The exact resource, action, task, and receiving-service caveats must remain unchanged through delegation; recipient and shorter lifetime can vary. Each proof has one parent, with at most eight nodes including the invocation. The server checks serialized proofs and current lifecycle state on every call.

Tests pin the decoded wire version, capability fields, and archive identity. A dependency update that changes these must explicitly address compatibility, stored grants, migration, and rejection behavior. Do not silently accept an expanded profile to keep an upgrade passing.

Before the first published preview, review the API with application developers and choose a version in a dedicated release PR. For subsequent 0.x previews, retain exact-version pins in integration examples; breaking API, schema, or wire changes require a new minor line and migration notes, while compatible fixes use patches. A future 1.0 release requires an explicit stable-support commitment. No currently published compatibility guarantee is implied by this proposed release policy.

Public entries cover the core verifier/client, SQLite, HTTP, identity files, authenticated administration, persistent service, saved workflow approvals, adapter composition, filesystem, PostgreSQL, GitHub, account management, the local browser account console, OAuth/OIDC, Gmail, Slack, MCP, worker provisioning, workflow management and console, and configuration. The CLI is `capvine`, including the provisioned stdio `worker` command. The adapter entries are Node server integrations; the package does not promise browser or edge-runtime compatibility. Review declaration dependencies and the built artifact, not just source imports.

## Evidence available

- Plugin setup composes the existing services without changing the capability profile. Tests cover shared-action dispatch, raw signed retargeting denial, initialization/restart, invalid configuration cleanup, account credential separation, wrong/missing keys, and concurrent shutdown. `npm run example:plugins` exercises a custom OIDC provider/resource through a separate MCP process. The `./setup`, `./providers`, and `./resources` entries are included in package consumer checks. See [plugin integration](plugins.md); independent adopter/security review remains open.

- Server-boundary negative tests cover signatures, recipients, exact caveats, proof shape/depth, expiry, revocation, task termination, and failed state/audit access. Failed grant persistence does not return a grant; failed verification/lifecycle/audit storage prevents dispatch.
- The service example and tests cover authenticated administration, private files, state migration, persistent identity, binding conflicts, restart, and graceful draining.
- Filesystem and PostgreSQL tests establish the actual selected targets and bounded reads; PostgreSQL runs as real temporary clusters.
- The public GitHub smoke example checks a live provider without account credentials. MCP tests and a real stdio worker exercise provisioned session bindings. The worker example reads a registered file, retains its identity across proof renewal, reuses a saved approval after authority restart, and rejects calls and further issuance after workflow disable.
- Workflow console tests cover authenticated fixed-scope approval, separate worker provisioning, automatic renewal, persistence, immutable bindings, unreadable assignments, and disable. Browser verification confirms desktop/mobile layout and a real-file CLI read followed by denial after workflow disable. This is local single-owner application evidence, not remote administration or host containment.
- Direct account tests and `npm run example:accounts` exercise OAuth/OIDC code exchange, encrypted storage, refresh rotation, restart, and delegated reads against a local provider fixture. A configured local Google smoke test has also verified consent, refresh, delegated reads, restart, parent revocation, and workflow disabling. Provider-consent revocation and production-host validation remain separate gates.
- Provider fixture tests invalidate unexpired access tokens and refresh tokens, persist reconnect-required status, prevent repeated provider calls, and recover through a fresh connection and approval. They cover disconnect races, failed state writes, temporary provider failures, and the authenticated console flow. This does not establish live Google revocation behavior.
- Slack tests and `npm run example:slack` cover its distinct PKCE exchange/rotation response shapes, workspace/user/app and scope restrictions, encrypted persistence, separate-process MCP reads, revocation, and restart with the HTTP fixture. Live Slack consent, workspace policy, and provider lifecycle behavior remain unverified.
- `test/account-console.test.ts` exercises real HTTP login, session rotation/expiry/logout, origin/CSRF rejection, session-bound OAuth callbacks, account listing, reconnect, and persistence with the provider fixture. The console has also been checked in a browser, including a real Gmail read and retention of its preview after a denied test. It remains a single-owner loopback application; the Gmail screen drives signing identities inside the trusted backend process.
- The [isolated-worker reference check](../examples/isolation/README.md) passed Linux CI: signed calls work through a Unix socket while direct credential access, tampering, and external/provider networking fail. This does not validate a macOS desktop or arbitrary production host.
- `npm run package:check`, after building, creates and inspects a tarball, installs it in a temporary consumer without dev dependencies, imports every public entry, checks consumer TypeScript imports, and invokes the installed CLI. It does not publish or configure registry access.

The [provider validation runner](provider-validation.md), [deployment/recovery drill](deployment.md), [external review packet](security-review.md), and [release bundle procedure](release-runbook.md) make these gates repeatable and reviewable. Their existence is preparation, not external approval.

## State and operations

SQLite schema version 1 migrates the known legacy layout transactionally. Unknown versions/layouts reject. A populated legacy store cannot be silently attached to a new authority. Keep identity and state backups together, restore with revocation rollback explicitly resolved, and never overwrite identity to recover from a startup error. Operator token rotation and authority replacement procedures are in the [service guide](service.md); transparent authority-key rotation is not implemented.

Audit inspection returns bounded invocation outcomes and omits resource contents and credentials. It is not encrypted, tamper-evident, or a complete administration-change ledger. Define retention, disk monitoring, alerting, and recovery for each deployment. A durable async state backend and multi-replica consistency are separate future designs.

Dependencies are pinned at the direct package boundary and locked for repository CI. Review updates for protocol, credential, HTTP, and database behavior; rerun the complete tests, examples, containment check, and package check before merging. npm audit output is supplementary evidence, not proof that a dependency is safe. The isolation Docker image pins an official Node 24 OCI index digest. Review digest updates and rerun containment/recovery checks; a production image still requires its own update and vulnerability-response process.

## Publication gates still open

- [ ] Independent security review of the profile, verifier integration, adapters, administration, and a specific deployment boundary, with findings resolved.
- [ ] API review with adopters and maintainer approval of a release version and support policy.
- [ ] A production-specific credential, TLS/ingress, privilege, monitoring, and recovery review; private-provider account onboarding where required.
- [ ] Verified npm scope/package ownership and approved publisher settings.
- [ ] A reviewed release PR that changes publication settings and introduces a narrowly authorized publishing workflow.
- [ ] A verified registry release and provenance, followed by an installation smoke check.

No internal test result can check off the independent-review or approval gates.

## Trusted publishing procedure

After those gates are approved, configure npm trust for exactly this repository and the reviewed workflow filename, with a protected GitHub environment. Use GitHub-hosted runners and a supported Node/npm version, grant OIDC permission only to the publishing job, and avoid long-lived registry tokens. Prefer staging-only publishing with a maintainer approval step if supported by the chosen release process. Verify the first publish and provenance before declaring the configuration operational; an npm settings form alone is not evidence. Follow the current [npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/) and [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/) when implementing that separate workflow.

This repository deliberately does not add a dormant publish job that can become active merely by changing a tag or boolean. Publication requires a concrete, reviewed release change and explicit authorization.
