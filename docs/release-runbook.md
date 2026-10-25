# Prepare and release the read-only OSS package

Version `0.0.1` is authorized as an experimental release. The source is public and MIT licensed. [Independent review and production acceptance](release-readiness.md) remain open; publication does not close them. The first release uses the checked tarball and existing authenticated npm account, with no CI credential upload or claimed npm provenance.

## Create a checked review bundle

From a clean checkout of the candidate revision:

```sh
npm ci --ignore-scripts
npm run check
npm run example
npm run example:recovery
npm run release:bundle -- /tmp/capvine-review-candidate
```

The output directory must be new and outside the checkout. The command packs the artifact, validates its contents, installs that exact tarball in a fresh consumer without dev dependencies, imports all public entries, type-checks consumer imports, runs the installed CLI, and verifies both fixed-resource and runtime application workflows against that installed artifact. It then retains that tarball and a report containing the revision, dirty-checkout indicator, Node version, package metadata, SHA-256, and npm-style SHA-512 integrity. No keys, account data, credentials, or local configuration belong in this bundle. The report explicitly does not approve publication.

The manually dispatched **Release review bundle** GitHub workflow runs the full tests, examples, recovery and Linux containment checks, then uploads the package/report for 14 days. It has read-only repository permission, no registry credentials, no OIDC permission, and no publish command. Archive the chosen evidence in the review record before artifact retention expires. CI artifact integrity is not npm provenance.

## Production acceptance and future automation

Before claiming a supported production deployment, record independent security review and resolved findings, adopter API feedback, actual deployment acceptance and provider lifecycle evidence for the supported scope, and maintainer approval of the support policy. Use the [review packet](security-review.md). Version `0.0.1` is approved for experimental distribution; this does not approve a supported production deployment.

Confirm npm organization membership and package availability using the authenticated registry account. Scope ownership does not prove trusted publishing or permission to modify an existing package. For an unpublished package, npm's staged-publishing flow can bootstrap the package, but it also creates a publicly visible `0.0.0-stage` placeholder. Treat staging as a registry mutation requiring the reviewed release decision; do not stage this experimental package merely to create a settings page. The staged contents remain private until approval. Verify this behavior against the current npm documentation when executing the release.

## Dedicated release PR

The release PR contains the approved version and lockfile update, public registry/access configuration, release notes and exact-version installation instructions. The initial release was manual; future releases use the [staging workflow](trusted-publishing.md) after its registry trust is configured. Dispatch requires an explicitly approved release tag; final npm approval remains a separate maintainer action.

Configure an npm trusted publisher for exactly:

| Field              | Intended value                                                    |
| ------------------ | ----------------------------------------------------------------- |
| Organization       | `farming-labs`                                                    |
| Repository         | `capvine`                                                         |
| Workflow filename  | `npm-stage.yml`                                                   |
| GitHub environment | `npm-staging`, restricted to version tags and maintainer approval |
| Allowed actions    | Staging only; npm approval remains a separate maintainer action   |

Use a GitHub-hosted runner and a current supported Node/npm combination. Grant `id-token: write` only to the publishing job; keep tests and untrusted PR jobs read-only. Pin actions, verify the released commit/version and reviewed artifact, and avoid long-lived registry tokens. Configure release-branch/tag restrictions and record the concrete reviewer/environment policy. Package settings and one successful release must be verified; scope membership alone is insufficient.

Follow the current [npm trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/) and [staged publishing documentation](https://docs.npmjs.com/staged-publishing/). Configure trust when an approved candidate is ready, inspect the returned restrictions, and verify an actual OIDC stage. Recheck vendor requirements when executing this step.

## Verify the published result

Check the exact registry name/version and integrity, intended dist-tag, and a fresh consumer installation from the registry. For automated releases, also check provenance tied to the expected repository/workflow/commit. The manual `0.0.1` bootstrap has no npm provenance attestation. Repeat runtime/type imports and CLI startup against the registry artifact, not a workspace path. Confirm ordinary consumers need no dev dependencies or registry token. Record links and results before closing the release gate. If verification fails, stop promotion and investigate; do not silently overwrite a published version or claim it passed because the local tarball worked.

The [acceptance workflow](acceptance.md) adds a real HTTPS ingress/read probe, revision-bound evidence records and the experimental release scope. These tools do not supply missing independent review or production/provider evidence and do not publish the package.

## Publish the authorized 0.0.1 artifact

After the release PR is merged, build a clean-checkout review bundle using the commands above. Verify the report's revision, version, clean checkout and artifact digest, then publish that exact tarball with the authenticated package owner:

```sh
npm whoami --registry=https://registry.npmjs.org/
npm publish /private/release/farming-labs-capvine-0.0.1.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
npm view @farming-labs/capvine@0.0.1 version dist.integrity dist-tags --json
```

Complete npm's authentication challenge if requested; do not place account tokens in the repository or CI. Compare registry integrity to the bundle report, verify a clean registry installation, and attach the tarball/report to the GitHub release. Keep incomplete external acceptance records incomplete.
