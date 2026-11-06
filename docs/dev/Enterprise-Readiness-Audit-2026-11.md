# Enterprise-readiness audit — November 2026

**Repository:** redoracle/obsidian-git-vault
**Baseline examined:** main at 0c7d54f1e2eb739afec49727b8fc65e3472b0e28
**Scope:** tracked inventory (438 tree entries), primary lifecycle, Git and API sync paths, shared queue, state management, provider clients, settings, UI, documentation, tests, and GitHub Actions workflows.

## Executive assessment

The repository has a credible modular foundation and extensive automated
functional tests, but passing CI alone does **not** establish enterprise
readiness. In particular, a desktop/mobile plugin requires runtime and
platform validation, protected release governance, and auditable end-to-end
flows. The changes in this PR resolve specific flow-control and release
transaction risks; other risks below remain explicitly open.

| Area | Current strengths | High-priority gap |
| --- | --- | --- |
| Design and architecture | Shared provider contract, Git/native and API adapters, runtime orchestration, centralized sync state | Several very large modules and async provider reload races |
| Correctness / flow control | Serial operation queue and tested conflict policies | Nested native Git sync queue could self-deadlock; queue clear stranded waiting callers — fixed in this PR |
| UI/UX | Simple and advanced sync modes, responsive screenshot fixtures, branch selector, conflict UI | Runtime accessibility and Obsidian desktop/mobile keyboard/screen-reader smoke tests not in CI |
| Security | Path-scope tests, credential abstractions, redacted audit logs, encryption binding checks | Branch rules, code-scanning, secrets scanning and release provenance require verification/configuration |
| CI | Frozen pnpm installation, TypeScript, Svelte, lint, format, Vitest, build, production audit and Chromium screenshot harness | Many independent installs; real Obsidian/Electron end-to-end tests need a controlled runner |
| Release | Semantic Release 1.1.2 was published and release-note compatibility is tested | Release metadata was written in three partial updates — now one Git commit, with transaction regression tests |
| Documentation | README, security policy, contribution guide, provider architecture | Written guarantees must be separated from platform-validated ones |

## Verified code-level findings and changes

### Critical: native Git sync reentrancy

SyncManager.triggerSync ran runSync from PromiseQueue, while
GitSyncProvider.sync created a *second* task on that same queue and waited for
it. Because the queue is serial, the inner task cannot run until the outer
task finishes, and the outer task cannot finish until the inner task runs.
This is a self-deadlock.

**Resolution:** SyncManager alone owns synchronization serialization.
GitSyncProvider.sync directly performs commit/sync and status refresh. Unit
tests reproduce the nested-call shape with the real PromiseQueue.

### High: shutdown and trigger ordering

The previous PromiseQueue.clear removed its internal task array without
settling pending callers, and a late execution completion could dequeue a
subsequently added task incorrectly.

**Resolution:** Track pending and active tasks separately; settle waiting
promises on terminal shutdown; prevent new scheduling; make callbacks
idempotent; do not invoke onFinished for teardown cancellations; preserve
error reporting for executed tasks. Also coalesce rapid sync trigger events.
The queue cannot force-stop a running I/O operation: future work should
introduce cooperative cancellation at the Git/provider operation boundary.

### High: Simple Mode UI readiness

Previously the Sync button was disabled only while isSyncing was true.
If provider initialization had not completed, a user could submit a request
that did nothing useful. The status message lacked a live-region role.

**Resolution:** Disable Sync until providerReady, explain initialization,
add a status live region, and expose button and container busy state.
Do not disable manual Sync merely because isOnline is false; users should
still be able to request a retry.

### High: partial release metadata writes

The post-release workflow made three independent Contents API PUTs for
manifest.json, versions.json and package.json. A failure between PUTs
could leave version numbers inconsistent.

**Resolution:** After Semantic Release prepares artifacts, stage all three
version metadata files into a *single Git commit* and push atomically.
A failed non-fast-forward push applies no partial update. The synthetic
Git regression test validates exactly three changed paths, idempotent retry
and malformed-version rejection. Release checks include format and production
dependency auditing.

## Readiness gates not yet satisfied

1. **GitHub governance:** Main branch protection is currently disabled.
   Configure a repository ruleset with required passing checks, one or more
   reviews, CODEOWNERS review for sensitive paths, no forced pushes, and
   restricted release workflow permissions. This requires repository
   administration and cannot be established merely by committing YAML.
2. **Functional integration:** Run native Git sync, API sync on GitHub/GitLab/
   Gitea, file conflicts, encryption recovery, branch rollback and provider
   switching against temporary isolated repositories. Include concurrent
   file change and reconnect events.
3. **Device compatibility:** Execute real Obsidian desktop and mobile manual
   smoke tests. The screenshot harness tests deterministic HTML scenarios,
   not all real plugin interactions. Test keyboard focus/escape/submit,
   screen-reader announcements, narrow layouts and contrast against WCAG 2.2
   AA goals.
4. **Release supply chain:** Verify release artifact digests, provenance,
   signed checksums and SBOM generation. Evaluate SHA pinning for third-party
   Actions, CodeQL scanning, dependency review and Dependabot alert triage.
5. **Long-running tasks:** Set operational timeouts/cancellation and document
   retry/backoff/idempotency for forge pagination, remote mutation, and
   notification retries. Audit concurrent provider reload/branch switches.
6. **Maintainable architecture:** Extract responsibility-based modules from
   src/main.ts (~65 KB), src/syncProvider/apiSyncProvider.ts (~80 KB),
   src/gitManager/simpleGit.ts (~60 KB), src/syncProvider/syncManager.ts
   (~48 KB) and the large settings/source-control UI. Do this incrementally
   with characterization tests, never via an untested rewrite.

## Recommended flow-control contract

- Exactly one owner serializes each sync operation.
- Events can request work, but repeated requests coalesce while pending.
- A clear/unload call settles all outstanding waiters and prevents callbacks
  from rearming timers. Running I/O needs separate cooperative cancellation.
- A sync success reflects a completed provider operation; failure leaves
  actionable state and preserves unresolved conflict metadata.
- Destructive file replacement and branch changes must require clear,
  contextual confirmation; do not silently overwrite pending user edits.
- Notifications, loading indicators, and accessibility messages use the
  centralized sync state, not unrelated local booleans.
- Version metadata changes are all-or-nothing; no release is considered
  fully reconciled until both tag/artifacts and the metadata transaction
  have been verified.

## Release incident boundaries

The atomic metadata push follows GitHub release publication. If the remote
moves while publishing, the push is rejected safely, but the published
release may already exist: a maintainer must reconcile or retry the metadata
step. This is preferable to partial writes, but fully automated recovery
under concurrent changes remains future work.

## Acceptance checklist for this PR

- Frozen lockfile installation
- TypeScript, Svelte, ESLint, Prettier and production bundle pass
- Existing plus new Vitest unit/integration tests pass
- Screenshot harness typechecking, npm audit and Chromium tests pass
- Production dependency audit passes
- Temporary formatting workflow is removed after its one-time use
- Changes submitted for reviewed PR merge after all checks are green

**Status:** Targeted code remediations implemented. Enterprise-grade runtime
certification, branch governance, real-client E2E and supply-chain attestations
are explicitly *not* claimed complete.
