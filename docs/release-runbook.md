# Prepare and release the read-only OSS package

The current package is private, version `0.0.0`. The source is public and MIT licensed. The [external review and publication gates](release-readiness.md) still apply. This runbook prepares a reviewable artifact without enabling publishing.

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

## Complete the decisions before changing publication

Record independent security review and resolved findings, adopter API feedback, actual deployment acceptance and provider lifecycle evidence for the supported scope, and maintainer approval of the version and support policy. Use the [review packet](security-review.md). A suggested first preview version is a decision for that release PR, not a version promised by this document.

Confirm npm organization membership and package availability using the authenticated registry account. Scope ownership does not prove trusted publishing or permission to modify an existing package. For an unpublished package, npm's staged-publishing flow can bootstrap the package, but it also creates a publicly visible `0.0.0-stage` placeholder. Treat staging as a registry mutation requiring the reviewed release decision; do not stage this experimental package merely to create a settings page. The staged contents remain private until approval. Verify this behavior against the current npm documentation when executing the release.

## Dedicated release PR

The release PR should contain the approved version and lockfile update, removal of `private: true`, explicit public registry/access configuration, release notes and exact-version installation instructions, and the reviewed publishing workflow. Do not preinstall a dormant publisher that a tag or boolean can accidentally activate.

Configure an npm trusted publisher for exactly:

| Field              | Intended value                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Organization       | `farming-labs`                                                                                                 |
| Repository         | `capvine`                                                                                                      |
| Workflow filename  | The exact reviewed release workflow filename, including extension                                              |
| GitHub environment | A dedicated release environment with maintainer protection                                                     |
| Allowed actions    | Prefer staged publishing requiring maintainer approval, when supported by the chosen bootstrap/release process |

Use a GitHub-hosted runner and a current supported Node/npm combination. Grant `id-token: write` only to the publishing job; keep tests and untrusted PR jobs read-only. Pin actions, verify the released commit/version and reviewed artifact, and avoid long-lived registry tokens. Configure release-branch/tag restrictions and record the concrete reviewer/environment policy. Package settings and one successful release must be verified; scope membership alone is insufficient.

Follow the current [npm trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/) and [staged publishing documentation](https://docs.npmjs.com/staged-publishing/). Newly configured trust currently requires a successful first publish within two days; configure it when the reviewed candidate is ready. Recheck vendor requirements when executing this step.

## Verify the published result

Check the exact registry name/version and integrity, provenance tied to the expected repository/workflow/commit, intended dist-tag, and a fresh consumer installation from the registry. Repeat runtime/type imports and CLI startup against the registry artifact, not a workspace path. Confirm ordinary consumers need no dev dependencies or registry token. Record links and results before closing the release gate. If verification fails, stop promotion and investigate; do not silently overwrite a published version or claim it passed because the local tarball worked.

The [acceptance workflow](acceptance.md) adds a real HTTPS ingress/read probe, revision-bound evidence records and an explicit first-preview proposal. These tools do not supply missing independent review or production/provider evidence and do not publish the package.
