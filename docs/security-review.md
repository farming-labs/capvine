# External review packet

Request an independent review of a fixed source revision and the intended deployment, followed by retesting of resolved findings. This document defines the handoff; it is not a review report or approval. The `0.0.1` package is an experimental release; publication does not substitute for this review.

## Candidate and reproducibility

Record the full Git commit, lockfile, Node version, deployment configuration/image digests, CI run, and the `package-review.json`/tarball from [release preparation](release-runbook.md). Reject a candidate whose recorded revision does not match its source or whose bundle reports a dirty checkout. Changes after review need a documented scope assessment and review of affected paths.

```sh
npm ci --ignore-scripts
npm run check
npm run example
npm run example:resources
npm run example:mcp
npm run example:accounts
npm run example:slack
npm run example:plugins
npm run example:application
npm run example:recovery
npm run example:inspection
sh examples/isolation/run.sh
```

Use Node 24+, PostgreSQL server binaries, a non-root test user, and Linux Docker for containment. Live-provider evidence and the actual host are separate inputs; the fixture provider is not evidence about real Google/Slack behavior.

## Review scope

Include the plugin composition in `src/setup.ts`, `src/setup-internal.ts`, `src/providers.ts`, `src/resources.ts` and `src/workflow-definition.ts`. Review first-run initialization, missing-key/state rejection, concurrent ownership, plugin cleanup, and dispatch when several plugins share an action. Confirm configuration never approves itself and that account connection remains independent of resource registration and grant issuance. Run `test/setup.test.ts` and the custom-provider example; use the integration steps and reviewer questions in [the plugin guide](plugins.md). Plugins and their dependencies execute with backend privileges.

Include the runtime application boundary in `src/application.ts`, `src/application-contract.ts`, `src/plugins.ts`, `src/owner-client.ts`, and `src/node.ts`. Check that HTTP and direct API methods enforce the same owner/session/origin rules; worker proofs cannot authorize owner operations; callback state cannot cross login sessions; and persistent plugin/resource bindings cannot be silently replaced. Review registration failures and shutdown races, explicit plugin selection, secret-free response envelopes, and the browser-only client dependency graph. Run `test/application.test.ts` and `npm run example:application`.

| Boundary                       | Sources                                                                                                   | Questions to resolve                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proof format and verifier      | `src/profile.ts`, `src/server.ts`, `src/client.ts`                                                        | Are serialized proofs independently checked? Can resource/action/task/service, recipient, lifetime, depth, or a parent restriction be bypassed? Is the supported ucanto/UCAN profile documented accurately? |
| Lifecycle and storage          | `src/sqlite.ts`, `src/approvals.ts`, `src/service.ts`                                                     | Do revocation and task/approval disable fail closed under concurrency/failure? Can a rollback, stale lock, authority mismatch, or incomplete audit restore unintended access?                               |
| Issuance and administration    | `src/administration.ts`, `src/workflows.ts`                                                               | Is the owner authenticated outside model-controlled inputs? Can a worker get a new root or expand a configured workflow? Are renewal and disable correctly bound?                                           |
| Resource dispatch              | `src/adapter.ts`, `src/filesystem.ts`, `src/postgres.ts`, `src/github.ts`, `src/gmail.ts`, `src/slack.ts` | Does the actual filesystem/database/provider target match the immutable registered binding? Can traversal, replacement, mutable names, SSRF, query arguments, or redirects bypass it?                       |
| Credentials and OAuth          | `src/accounts.ts`, `src/account-store.ts`, `src/oauth.ts`, `src/slack-oauth.ts`                           | Are account identity, scope, session/state/PKCE, rotation, revocation, encryption, and reconnect binding enforced without leaking credentials?                                                              |
| Console and worker integration | `src/account-console.ts`, `src/worker.ts`, `src/mcp.ts`                                                   | Can CSRF, session confusion, file substitution, tool arguments, or worker identity reuse grant unintended authority?                                                                                        |
| Deployment and supply chain    | `examples/isolation/`, [deployment runbook](deployment.md), lockfile, workflows                           | Are alternate credential/administration/network paths closed on the actual host? Are build inputs, release artifacts, logs, backups, and publisher access protected?                                        |

Attacker-controlled inputs include prompts, provider content, workers, tool arguments, serialized requests, and network clients. The authority, issuance policy, stores, adapters, credential manager, host/kernel and trusted deployment configuration remain privileged. A permitted read can disclose its result; prompt injection resistance and zero-risk operation are not claimed. Writes, arbitrary SQL/path selection, multiple replicas, remote multi-tenant consoles, and macOS desktop confinement are outside the current supported scope.

Prioritize exploitable bypasses and durable failure modes over code-style feedback. Use raw signed requests and observable handler/provider counters when reporting authorization findings. Do not send personal account contents or real keys in a reproduction. Follow [SECURITY.md](../SECURITY.md) for disclosure.

Include owner discovery and `src/owner-console.ts` / `src/owner-console-browser.ts`. Confirm discovery authenticates before touching providers, does not grant access, bounds and projects results, and validates targets again during registration. Inspect text rendering of provider labels, fixed browser asset paths, session checks on assets, CSP, exact approval review, and the separation between owner UI and worker assignment. Custom discovery is privileged code.

For candidates after `0.0.1`, include `src/inspection.ts`, `src/inspection-cli.ts`, the store queries and the owner/administration routes. Verify both resource and task ownership, bounded cursors, explicit output projections, unknown legacy metadata and storage failures. A worker proof must not authenticate inspection; a denied event's referenced root must not be presented as an authenticated caller. Confirm that unindexed children and unassociated events are disclosed as coverage limits. Run `test/inspection.test.ts`, the service/application tests and `npm run example:inspection`. Review the full operator authority of the CLI token and keep its files outside worker access.

## Adopter API review

Begin with the [application API guide](application.md): configure plugins, integrate a verified owner session, mount the handler, connect an account, register an exact resource, and grant access to a worker. Verify whether adopters understand `storage.directory`, account connection versus grant issuance, recipient identities, and immutable selection. Compare with the compatible fixed-resource setup guide for saved workflows and renewal. Record actual adopter feedback; these guides are not that feedback.

Ask application developers to integrate from the packed artifact rather than source aliases. Exercise one exact file/database record and one provider-backed message, assign a child worker, reuse a saved approval after restart, renew a worker, revoke a parent, and disable the workflow. Record where they confused account connection with permission issuance, resource IDs with provider targets, or token refresh with grant renewal. Check runtime/type imports and the installed CLI without workspace dev dependencies.

Review the public entries and compatibility policy in [release readiness](release-readiness.md). Propose a preview version/support policy only after the APIs and remaining limitations are understood. Internal examples are not adopter feedback.

## Review outcome record

The reviewer should provide their identity/organization and independence, scope and exclusions, exact reviewed revision/deployment, dates, methods, finding severity and reproduction, remediation revisions, retest evidence, and residual risks. The maintainer separately records publication/version/support approval. A clean internal test run or automatically generated bundle cannot substitute for either decision. Track independent review in [issue #50](https://github.com/farming-labs/capvine/issues/50), adopter feedback in [issue #51](https://github.com/farming-labs/capvine/issues/51), and the overall deployment acceptance in [issue #16](https://github.com/farming-labs/capvine/issues/16). Sensitive findings belong in the private disclosure process, not public issue bodies.
