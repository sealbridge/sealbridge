# 0.10.1 release preparation

Prepare paired `sealbridge` and generated `sealbridge-local` distributions from main at `a85ffa79b9a772fd5a8e4907b2ac5dbd149dbca7`, including #328, following the preparation PRs #315 and #307. This PR changes release metadata and documentation only; it does not merge, tag, publish, create a Release or deploy.

- All versioned workspace packages, MCP/A2A metadata, fixtures, source installer pins and README public package pins are 0.10.1. The unversioned sites tooling package stays unversioned. Generated `sealbridge-local` inherits the root version.
- Internal dependencies remain `workspace:*`. Regenerate the lockfile; workspace package versions alone produce no version-driven lockfile diff.
- Node >=22 and protocol 0.2.0 stay unchanged. CI checks Node 22/24 on Ubuntu, macOS and Windows, plus lint/format and three installer jobs (10 checks).
- The merged range since #315 includes the folder-policy acceptance fix (#316), README heading parity (#318), Dependabot Node types policy (#320), TypeScript 6 (#321), `ws` 8.23.0 and its `^8.23.0` floor (#322, #328), transitive Hono updates (#325), Windows command-path performance (#326), CodeQL maintenance (#327), and site/workflow dependencies (#220, #323, #324).
- Recommend local relay users update to 0.10.1 once published. Both generated distribution manifests must report version 0.10.1 and `dependencies.ws: ^8.23.0`. No new breaking changes; the [0.10.0 upgrade notes](../CHANGELOG.md#upgrade-notes--breaking-changes) still apply to upgrades from earlier versions.
- Source installers pin 0.10.1. Hosted installer/site updates require separate deployment approval. READMEs generate site documentation. Keep previous release records unchanged.
- The changelog date is 2026-11-25; verify it at any later publication.

## Future publication checklist (not performed)

- [ ] Confirm both npm Trusted Publisher settings: repository `sealbridge/sealbridge`, workflow filename `publish.yml`, environment `npm-publish`, Allowed actions including **npm publish**. Both distributions published via this workflow on 0.9.1; earlier `sealbridge-local` OIDC E403 failures mean authorization must still be checked. Do not change credentials/settings as part of this PR.
- [ ] Use the unchanged paired publish preflight: frozen install, build, typecheck, schema validation, tests, protocol-release check and package generation. Inspect both generated manifests for 0.10.1 and `dependencies.ws: ^8.23.0`. Freeze and dry-run both tarballs before registry writes; a dry-run does not prove OIDC authorization. Never approve the npm-publish environment through the API.
- [ ] Obtain separate authorization before merging, tagging, publishing, creating a GitHub Release, pushing Docker images, or deploying relay/site/installer assets. Do not change protocol versions.
- [ ] After authorized publication, verify both npm distributions and separately approve any hosted installer/site or relay deployment. This checklist is documentation only; no publication or deployment is performed by this preparation.
