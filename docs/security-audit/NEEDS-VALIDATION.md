# NEEDS-VALIDATION

## Upstream-authored workflows reach the fork's branches through the documented sync and would run with the fork's GITHUB_TOKEN write and OIDC authority

- **Fingerprint:** `upstream-sync/.github/workflows:fork-token-publish-authority`
- **Claimed root cause:** The fork treats .github/workflows as upstream-mirrored content instead of fork-owned authorization code. The default branch keeps upstream's publish workflow, the documented upstream merge has no rule or test for .github/, and the compensating controls are GitHub settings (one per-file disable, an action allowlist, a default-token default) that do not stop a new upstream workflow file that declares its own write permissions and uses run: steps.

### Trace
1. `README.md:167` — entrypoint: main mirrors upstream/main, so upstream maintainers author every file on the fork's default branch, including .github/workflows. The fork treats them as lower trust: README.md:179-181 says upstream changes may bring back commands, the PIN, subscriptions or TLS weakening and must not be taken as they are.
2. `README.md:171` — propagation: git switch hardened && git merge upstream/main; a newly added upstream workflow merges cleanly (agents/v5-upstreamsync/artifacts/check-1.txt: merge exit 0, 0 unmerged paths, .github/workflows/x.yml present next to ci.yml).
3. `README.md:174` — propagation: The areas to review after a merge (README.md:174-184) are packaging, carConnector.js/mqtt.js/index.js and new endpoints; .github/ is not named.
4. `haval-h6-mqtt/test/unit/readonly.test.js:12` — propagation: The read-only source scan reads only top-level haval-h6-mqtt/*.js, so no test sees an imported workflow file.
5. `.github/workflows/ci.yml:12` — propagation: contents: read narrows only ci.yml; workflow permissions are per file and do not constrain another workflow file merged next to it.
6. `.github/workflows/docker-build-publish.yml:9` — propagation: On main the upstream workflow triggers on every push to main (line 10) and on v*.*.* tags (line 12).
7. `.github/workflows/docker-build-publish.yml:29` — propagation: The job explicitly requests packages: write (line 29) and id-token: write (line 32).
8. `.github/workflows/docker-build-publish.yml:61` — propagation: docker/login-action logs in to ghcr.io with secrets.GITHUB_TOKEN (line 65) on non-PR events (line 60).
9. `.github/workflows/docker-build-publish.yml:82` — sink: build-push-action pushes the main tree (context ., line 81) as ghcr.io/${{ github.repository }}:latest and a date tag (line 83); cosign signs the digest with the fork's workflow identity (lines 93-101).

### Evidence
- `.github/workflows/docker-build-publish.yml:32`: On main (git show main:): id-token: write next to packages: write at line 29; checkout uses the mutable tag actions/checkout@v4 at line 41. git ls-tree shows this is the only workflow on main, and git rev-parse main == bafa10e (upstream 'Release 1.0.8').
- `README.md:193`: The README states that main still holds docker-build-publish.yml and publishes on every push to main; README.md:196-198 list the three owner steps (allow SHA-pinned actions, disable that one workflow by name, default token read-only).
- `README.md:189`: The post-merge checks (npm ci, lint, npm test, npm audit, test:integration; lines 189-190) inspect no workflow file.
- `docs/AUDIT.md:216`: States the auto-publish workflow is deleted on hardened and 'disabled by ID on GitHub before Actions are enabled'; true for hardened, and the main-branch control it names is a GitHub setting, not source.
- `haval-h6-mqtt/test/unit/readonly.test.js:12`: readdirSync of the haval-h6-mqtt top level, filtered to .js minus eslint.config.js; .github is outside the scan.
- `.github/workflows/ci.yml:8`: ci.yml runs on push to hardened, so the push that lands a merged upstream workflow with a hardened push trigger runs both.
- `docker-compose.yml:25`: build: . with image: gwm-reader:local (line 26): the owner's deployment builds locally and does not pull ghcr.io/<fork>, so the main-branch publish has no consumer in the owner's own deployment.

### Blockers
- Parent deployment fact: GitHub Actions are disabled for the whole fork (enabled:false, set 2026-10-21), and the owner has not pushed to main or used 'Sync fork'; no workflow runs until the owner enables Actions.
- Not source-visible whether the owner has disabled docker-build-publish.yml by ID, set an allowed-actions policy, or set the default workflow token to read-only.
- GitHub host semantics, not observable offline: that an explicit permissions: key raises GITHUB_TOKEN scopes above a read-only repository default for push events, that the allowed-actions policy does not govern run: steps, and that a 'Sync fork' update emits a push event that triggers workflows on main.
- Branch protection or rulesets on main and hardened (required reviews, restricted pushers) are not visible; they decide what an imported workflow with contents: write could change.
- Whether ghcr.io/kaiohenricunha/gwm-reader exists, is public, or is pulled by anyone is not visible; the owner's compose deployment builds locally (docker-compose.yml:25-26).

### Resolution plan
- **Local:** Done offline (agents/v5-upstreamsync/artifacts/check-1.txt): a scratch clone of the target with host git (hooks off, GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, no network, no target code run); a dummy commit on top of main adds .github/workflows/x.yml (push to hardened, permissions contents: write, one run: echo DUMMY_MARKER step); git merge into hardened gives exit 0, 0 unmerged paths, and x.yml beside ci.yml. Regression test to add on hardened: a unit test that asserts the set of files under .github/workflows equals ['ci.yml'] and that every workflow sets top-level permissions to read-only, so the README post-merge 'npm test' fails on an imported workflow.
- **Owner-observed:** Owner-observed and read-only, with Actions still disabled: in the fork's Settings > Actions record the enabled state, the allowed-actions policy and the default workflow permissions; in the Actions tab record whether docker-build-publish.yml is disabled; record branch protection or rulesets for main and hardened; record whether a ghcr.io package exists under the fork and its visibility. Do not push to main, use 'Sync fork', or enable Actions to test this. Fix to evaluate: delete docker-build-publish.yml on main or make hardened the default branch and stop mirroring main; add .github/ and the Dockerfile to the README merge checklist; add the workflow-set test above.
