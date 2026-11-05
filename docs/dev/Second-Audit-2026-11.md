# Second engineering audit — November 2026

## Scope and baseline

This pass builds on [PR #35](https://github.com/redoracle/obsidian-git-vault/pull/35).
It assesses the Obsidian plugin's hybrid Git architecture, forge-backed
synchronization, request/diagnostic security, dependency supply chain,
documentation, and maintainer workflows.

The established `SyncProvider` interface remains the contract across
desktop Git, GitHub, GitLab, and Gitea/Forgejo. Behavior-preserving
extractions are preferred to a large rewrite of the sync engine.

## Implemented findings

| Priority | Finding | Resolution |
| --- | --- | --- |
| Critical | Git libraries with published security advisories | Upgrade `simple-git` to v4 and `isomorphic-git` to a patched v1 release; validate native import and esbuild externals |
| High | Unbounded GitHub pagination and unsafe next-page links | Extract strict pagination parsing; require the GitHub API origin, detect repeated paths, and cap the request chain |
| High | Audit records and forge notices can leak API credentials | Consolidate pure redaction functions and sanitize nested audit payloads, authentication headers, and URL userinfo |
| High | Native Git environment filtering can be bypassed by custom variables | Extract `createGitEnvironment`, reject unsafe inherited/custom helper and dynamic configuration variables, and preserve normal user settings |
| Medium | Locked dependencies lag allowed compatible patch/minor releases | Refresh compatible packages in the committed lockfile, run frozen install and quality gates, and audit production vulnerabilities |
| Medium | Missing contributor policies and issue/PR conventions | Add security policy, support guidance, code of conduct, code ownership, PR template, feature request, and documentation index |
| Low | README architecture diagram omits other forge providers | Clarify multi-provider API sync and link CI and contributor policies |

## Verification criteria

1. `pnpm install --frozen-lockfile` reproduces the resolved graph.
2. `pnpm run tsc`, `pnpm run svelte`, `pnpm run lint`,
   `pnpm run format`, `pnpm run test`, and `pnpm run build`
   succeed on Node.js 22.
3. `pnpm audit --prod --audit-level high` reports no high or
   critical production advisories at review time.
4. GitHub Actions checks must pass on the final branch tip.
5. Electron/Obsidian desktop and mobile end-to-end flows are
   environment-dependent and require separate human review.

## Architecture follow-ups requiring dedicated PRs

- Decompose `src/main.ts` into lifecycle handlers and orchestration adapters
  with explicit contracts and tests.
- Extract the snapshot/diff/conflict phases from
  `src/syncProvider/apiSyncProvider.ts` without changing two-way
  synchronization semantics or encryption bindings.
- Reduce duplicated provider settings UI and extract shared validated
  form controls from `src/setting/sections/ui/`.
- Profile remote tree traversal and transfer batching under large vaults;
  apply bounded concurrency and caching only after measuring real workloads.
- Expand Electron end-to-end tests for credentials, git CLI compatibility,
  conflict handling, and remote API pagination.
- Review the major-version update backlog separately; **a major package
  upgrade is not automatically safe merely because a newer version exists**.

The README and architecture overview are preserved rather than rewritten
unnecessarily; their user-facing content is the maintained documentation.
