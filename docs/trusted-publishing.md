# Staged releases through npm OIDC

Version `0.0.1` was manually published and verified. It has no npm provenance attestation. The `npm-stage.yml` workflow prepares future releases for **staging**, with a separate maintainer approval before npm makes them installable. Adding this workflow does not publish a version or establish that registry trust is configured.

## Release path

1. Merge an explicitly approved release PR that updates the package/lockfile version and release notes. Create its exact `vMAJOR.MINOR.PATCH` tag at that merged commit.
2. Manually dispatch **Stage npm release** from that tag. Do not dispatch from `main`: provenance must identify the same commit as the built package.
3. The source check requires the expected repository, manual dispatch, a clean checkout, exact tag/version/workflow commit agreement, and a commit contained in `origin/main`. Only an explicit registry 404 allows a new version; published versions and uncertain responses fail.
4. The read-only reusable release workflow runs the full tests, examples, recovery, Linux containment and fresh-consumer package checks. It uploads the exact tarball and report from that run.
5. A maintainer reviews the GitHub environment deployment. The staging job downloads that run's artifact by ID, rechecks source and registry state, and checks the report's revision, version, completed package checks, filenames and digests. It never rebuilds the archive or runs package lifecycle scripts.
6. The job uses OIDC to run `npm stage publish` with provenance. It cannot approve the staged version. A maintainer reviews the stage's package, version, source and digest in npm and completes npm's separate 2FA approval.
7. After npm scanning and approval, verify the registry integrity/provenance and a fresh consumer installation before announcing the release. Retain the reports with the GitHub release.

The source and staging scripts run directly with Node 24; they do not require application dependencies in the privileged job. npm itself and the pinned GitHub actions remain trusted tooling. The stage job installs the explicitly pinned npm CLI with lifecycle scripts disabled. Repository writers, workflow code and environment reviewers are part of the release trust boundary. The artifact report is not an independent review or signature.

## One-time configuration

Create a GitHub environment named `npm-staging` with:

- Required maintainer review. A sole maintainer may approve their own dispatch; this is a deliberate approval gate, not independent review.
- Administrator bypass disabled.
- Custom deployment restrictions allowing only tags matching `v*`, with no branch rules. The workflow additionally restricts the tag format and checks main ancestry.
- No npm token secret. `contents: read` applies everywhere; only the staging job has `id-token: write`.

Configure npm trust for exactly:

| Setting                              | Value                   |
| ------------------------------------ | ----------------------- |
| Package                              | `@farming-labs/capvine` |
| GitHub repository                    | `farming-labs/capvine`  |
| Workflow file                        | `npm-stage.yml`         |
| GitHub environment                   | `npm-staging`           |
| Allowed action                       | Staged publication only |
| Direct publishing / dist-tag changes | Disabled                |

Use npm 11.15+ and a supported account login with 2FA. npm's trust endpoints reject bypass-2FA granular tokens even when such a credential can publish a package. Do not copy tokens or OTPs into GitHub or chat. Inspect existing trust first and preserve unrelated entries:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm trust list @farming-labs/capvine --json
npm trust github @farming-labs/capvine --repo farming-labs/capvine --file npm-stage.yml --env npm-staging --allow-stage-publish
```

Verify the returned settings. Do not add `--allow-publish` or disable 2FA to get past an authentication error. Configuration and an actual successful OIDC stage are separate checks; do not mark the roadmap item complete until both are verified.

## Operator commands

After an approved release tag exists:

```sh
gh workflow run npm-stage.yml --ref vX.Y.Z
npm stage list @farming-labs/capvine
npm stage view STAGE_ID
npm stage download STAGE_ID
```

Compare the downloaded archive to the GitHub run's report before approving. Confirm package, version, SHA-256, provenance repository/workflow/commit, and the intended `latest` dist-tag. Then the maintainer performs `npm stage approve STAGE_ID` with npm's authentication challenge. The workflow contains no approval command. Never reuse or move `v0.0.1` to test this workflow, and do not stage an unapproved next version merely to test credentials.

For `E403` on trust configuration, use an account login that satisfies npm's 2FA requirements. For a missing environment approval, inspect the deployment reviewers and allowed tags. For registry failures, retry after resolving the failure; do not convert them into an unpublished result. For artifact mismatch, discard that candidate and investigate rather than editing its report. While npm scans a submitted package it may not yet be installable; publication is complete only after registry and consumer checks pass.

Official references: [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/), [staged publishing](https://docs.npmjs.com/staged-publishing/), and [npm scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
