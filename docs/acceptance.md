# Deployment and release acceptance

The implementation and its fixtures can be complete while live-provider, deployment and independent-review acceptance remain open. Use the existing [review packet](security-review.md) and [bundle procedure](release-runbook.md), then attach evidence for one exact release candidate.

## Real-host ingress probe

Provision a dedicated read-only worker for one non-sensitive resource on the intended deployment. Keep its assignment in a private directory. From an authorized test machine with Node 24 and this checkout:

```sh
npm run deployment:check -- /private/capvine/test-worker.json
```

The command uses the assignment's pinned service and endpoint, requires HTTPS, retains normal certificate validation, rejects redirects, and bounds each request. It checks an unknown route, wrong method, unsigned and oversized invocations, a malformed browser-origin request, unauthenticated owner/admin routes, and one real permitted read. It discards resource content and prints only outcomes. It neither changes deployment settings nor sends provider credentials. Expired/revoked grants and failed reads fail the probe.

The browser-origin check uses an invalid proof; it does not establish that a valid proof is rejected solely because of its Origin header. The application verifier's tests cover that separately. An HTTP 401/403 on an owner route establishes unauthenticated rejection, not network-level invisibility of that route. Check actual private ingress and trusted proxy restrictions separately.

This probe does not prove worker filesystem/network containment, host patching, backup/revocation continuity, monitoring delivery or provider consent. Run the [host acceptance and recovery checks](deployment.md) on the actual host. Do not substitute a loopback fixture or the Linux CI isolation fixture for that evidence. Only the internal test function permits loopback HTTP; the operator CLI does not.

## Acceptance records

Create a private template for the current commit. Its parent directory must already exist with private permissions:

```sh
npm run release:status -- --template /private/review/acceptance.json
```

Every gate starts as `null`. Record only completed, reviewed evidence. Each record has this shape:

```json
{
  "status": "accepted",
  "revision": "FULL_40_CHARACTER_REVIEWED_COMMIT",
  "recordedAt": "2026-10-24T12:00:00.000Z",
  "recordedBy": "Responsible reviewer or operator",
  "artifact": "/private/review/security-review.txt",
  "sha256": "SHA256_OF_THAT_ARTIFACT"
}
```

Run:

```sh
npm run release:status -- /private/review/acceptance.json
```

The check fails on missing gates, another source revision, malformed records, missing/changed artifacts, or invalid hashes. It checks bounded regular files and prints gate statuses without file contents, credentials or private paths. `npm run release:status` with no record prints the missing gates and exits nonzero; it never treats the absence of evidence as success.

`recordsComplete` means the records and hashes are complete. It does **not** authenticate a reviewer, establish independence, interpret findings, prove a host is safe, or authorize a release. A maintainer must inspect the underlying evidence and decide whether to accept it. A copied or fabricated report does not become valid review evidence by passing this command. Do not wire this checker as the sole authorization for publishing.

Required records:

| Gate                        | Evidence to attach                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Independent security review | Reviewer identity/independence, exact scope/revision, findings, fixes and retest results from the review packet.                    |
| Adopter API review          | An adopter's installation and integration experience; approved support and compatibility decisions.                                 |
| Production host             | Real ingress probe plus containment, secret custody, backup/recovery, monitoring and operator acceptance.                           |
| Google lifecycle            | Consent, observed refresh, delegated read, restart, provider-side revocation, fresh reconnect and continued denial of old workers.  |
| Slack lifecycle             | The same lifecycle plus workspace policy, scopes, PKCE and rotating user-token behavior.                                            |
| Publisher configuration     | Current registry access, exact repository/workflow/environment trust, protected environment and approved initial-publish procedure. |
| Release approval            | Maintainer acceptance of the reviewed revision, artifact digest, version, limitations and publishing change.                        |

Retain the final registry/provenance and fresh-install evidence **after** publication as well. That cannot be claimed as a pre-publication test.

## Current observations

A local Google run on 2026-10-24 passed a real delegated MCP read, refresh (one observed refresh), restart, raw resource-retarget rejection, parent revocation and workflow disable. It used the working tree during development, not a final reviewed release candidate. No message content or credentials were included in the report. This does not close Google provider-consent revocation/reconnection or host acceptance.

No configured Slack test workspace, intended Linux host or independent-review report was available for this run. Version `0.0.1` was subsequently published manually and verified through a fresh registry installation. The `npm-staging` GitHub environment has a required maintainer reviewer, tag-only deployment restrictions and administrator bypass disabled. npm rejected access to trusted-publisher settings with the current credential; an account login with 2FA is still needed to inspect and configure trust. Manual publication does not establish that OIDC staging works.

## Experimental first release

Version `@farming-labs/capvine@0.0.1` is authorized for experimental distribution, with a read-only, single-owner, single-process Node 24 scope. This release decision does not supply the missing independent review, provider lifecycle or production-host evidence above. Acceptance records stay incomplete until actual evidence is available. See [release notes](releases/0.0.1.md).

The first version uses authenticated manual npm publication of the exact checked tarball. It does not claim npm OIDC provenance or an operational trusted publisher. A [staging workflow](trusted-publishing.md) is implemented for subsequent releases; npm trust configuration and its first real stage remain unverified. Verify the [official requirements](https://docs.npmjs.com/trusted-publishers/) when configuring it.

Google's [revocation documentation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke) describes the project-wide effect on a user's grants. Use a dedicated test project or obtain explicit permission for that wider effect. For Slack, validate the actual [token-rotation lifecycle](https://docs.slack.dev/authentication/using-token-rotation/) in the test workspace; a fixture cannot establish workspace policy or app settings.
