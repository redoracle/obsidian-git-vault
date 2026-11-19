# Contributing to Obsidian Git Vault

Thanks for improving Git Vault. Keep changes small, testable, and compatible
with desktop Git mode and the GitHub, GitLab, and Gitea/Forgejo API backends.

## Toolchain

- Node.js 22 (the version used by CI)
- pnpm 10 (CI pins **10.34.9**)
- Git for testing desktop workflows
- Obsidian for manual desktop and mobile testing

Install dependencies with a frozen lockfile:

```sh
pnpm install --frozen-lockfile
```

Dependencies that execute install scripts are intentionally allowlisted in
`pnpm-workspace.yaml`. Review any newly requested build script before approval.

## Quality gates

```sh
pnpm run tsc
pnpm run svelte
pnpm run lint
pnpm run format
pnpm run test
pnpm run build
pnpm run test:release-notes
pnpm run test:release-metadata
```

`make check` also checks formatting across source, configuration, and docs.
`pnpm run test:e2e` runs the Obsidian/Electron Playwright tests and requires
the local Obsidian testing environment; it is not part of lightweight PR CI.

**Before a PR:** check the frozen install, types, lint, formatting, tests,
and production bundle. Include a regression test for behavioral fixes.
If some environment-dependent checks could not be run, state that in the PR.

## Architectural boundaries

- `src/runtime/` coordinates lifecycle, operations, and UI adapters.
- `src/syncProvider/` owns the provider interface, sync state, API
  comparison/conflicts, scoping, and excluded paths.
- `src/setting/` owns settings validation, persistence, and provider setup.
- `src/editor/` and `src/ui/` present results and should not contain
  forge-specific storage logic.

Read [the architecture guide](docs/Architecture.md) and
[the provider contract](docs/dev/SyncProvider.md) before changing sync behavior.

Remote paths are untrusted. Use the path-scope helpers before accessing the
vault, and never normalize away `..` components before validating them.
Keep tokens and passphrases out of logs, examples, fixtures, and pull requests.
Do not weaken protections around repository identity, encryption binding,
sync conflicts, or the tracked directory.

## Dependencies and releases

The committed `pnpm-lock.yaml` is authoritative. Update package ranges and
the lockfile together; never merge an unfrozen install. Distinguish updates
already covered by the lockfile from new dependency resolutions, and run the
quality gates after either kind of change.

Use conventional commits (`fix:`, `feat:`, `docs:`, `test:`, `chore:`).
Releases are automated from `main`; do not edit release artifacts by hand.

## Async flow-control contract

The shared PromiseQueue owns FIFO execution. SyncManager is the sole queue owner
for a full sync: never enqueue a second task from inside GitSyncProvider.sync.
A queue clear during unload settles waiters without invoking completion hooks.
Avoid scheduling timers, notices or state writes after plugin teardown.

See [the enterprise-readiness audit](docs/dev/Enterprise-Readiness-Audit-2026-11.md)
for remaining production and governance checks.
