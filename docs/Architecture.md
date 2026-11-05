# Architecture

This document describes the internal architecture of Obsidian Git Vault for contributors and maintainers.

---

## High-Level Overview

```text
┌─────────────────────────────────────────────────────────┐
│                    Obsidian Git Vault                    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │                    UI Layer                     │    │
│  │  ┌──────────────┐    ┌────────────────────────┐ │    │
│  │  │  SimpleSync  │    │    SourceControlView   │ │    │
│  │  │  (Svelte 5)  │    │  + HistoryView + Diff  │ │    │
│  │  └──────┬───────┘    └──────────┬─────────────┘ │    │
│  └─────────┼───────────────────────┼───────────────┘    │
│            │                       │                    │
│            └──────────┬────────────┘                    │
│                       ▼                                 │
│         ┌─────────────────────────┐                     │
│         │       SyncManager       │                     │
│         │  • provider selection   │ ← Smart Triggers    │
│         │  • PromiseQueue routing │   (file/idle/net/   │
│         │  • conflict routing     │    close)           │
│         └────────────┬────────────┘                     │
│                      │                                  │
│         ┌────────────▼────────────┐                     │
│         │     SyncStateManager    │                     │
│         │  • isSyncing            │                     │
│         │  • conflicts[]          │                     │
│         │  • pendingChanges[]     │                     │
│         │  • lastSyncTime         │                     │
│         │  • isOnline / provider  │                     │
│         └────────────┬────────────┘                     │
│                      │                                  │
│         ┌────────────┴────────────┐                     │
│         ▼                         ▼                     │
│  ┌─────────────┐        ┌──────────────────┐            │
│  │ GitSync     │        │ ApiSyncProvider  │            │
│  │ Provider    │        │ + forge clients  │            │
│  │             │        │                  │            │
│  │ simple-git  │        │ requestUrl +     │            │
│  │ or iso-git  │        │ GitHub / GitLab  │            │
│  └──────┬──────┘        │ / Gitea APIs     │            │
│                              └───────┬──────┘            │
└─────────┼────────────────────────────┼───────────────────┘
          ▼                            ▼
    Git remote                 Forge REST APIs
  (any Git host)      (GitHub / GitLab / Gitea / Forgejo)
```

---

## Module Reference

### `src/syncProvider/syncProvider.ts`

The core abstraction. Defines the `SyncProvider` interface that all backends must implement, plus all shared types.

```ts
interface SyncProvider {
    init(): Promise<void>;
    sync(): Promise<SyncResult>;
    pull(): Promise<void>;
    push(): Promise<void>;
    resolveConflicts(resolutions: ConflictResolution[]): Promise<void>;
    getStatus(): Promise<SyncStatus>;
}
```

See [SyncProvider.md](dev/SyncProvider.md) for full interface documentation and instructions for implementing a new backend.

---

### `src/syncProvider/gitSyncProvider.ts`

Adapts the existing `GitManager` abstraction (which wraps either `simple-git` or `isomorphic-git`) to the `SyncProvider` interface.

Key behaviour:

-   `sync()` enqueues a task on `plugin.promiseQueue` and resolves when `commitAndSync` completes
-   `resolveConflicts()` stages or discards files per resolution strategy
-   `getStatus()` delegates to `gitManager.status()`

---

### `src/syncProvider/apiSyncProvider.ts`

A shared REST API sync engine with no Git dependency.

Key behaviour:

-   Uses `requestUrl` from the Obsidian API — works on mobile without native fetch restrictions
-   Applies tracked-directory scoping and exclude-path rules before building the local snapshot
-   Optionally encrypts file contents before upload and decrypts them after download
-   Provides per-file sync metadata and conflict-compatible content comparison across providers

### `src/syncProvider/apiClient.ts`

Forge-specific client adapters used by `ApiSyncProvider`.

-   `GitHubForgeClient` uses Git Database endpoints for atomic batch writes
-   `GitLabForgeClient` uses repository tree/files endpoints plus commit `actions[]`
-   `GiteaForgeClient` uses repository contents traversal and per-file writes

---

### `src/syncProvider/syncState.ts`

Centralized reactive state store. UI components subscribe to state changes via `subscribe(listener)`.

```ts
interface SyncState {
    lastSyncTime: number | null;
    pendingChanges: string[];
    conflicts: Conflict[];
    provider: SyncProviderType | null;
    isSyncing: boolean;
    isOnline: boolean;
    syncCount: number;
    lastError: string | null;
}
```

Convenience mutators: `markSyncStart()`, `markSyncSuccess(n)`, `markSyncError(msg)`, `setConflicts()`, `clearConflicts()`, `setOnline()`.

---

### `src/syncProvider/syncManager.ts`

Top-level coordinator. Owned by the `ObsidianGit` plugin instance (`plugin.syncManager`).

Responsibilities:

-   **Provider selection:** chooses `GitSyncProvider`, `GitHubApiSyncProvider`, `GitLabApiSyncProvider`, or `GiteaApiSyncProvider` based on `settings.activeSyncProvider` and `Platform.isMobileApp`
-   **Smart triggers:** registers and deregisters `EventRef`-based vault/workspace listeners and `setInterval`/`setTimeout`-based timers
-   **Queue routing:** all sync operations go through `plugin.promiseQueue`
-   **Conflict routing:** if `lastResult.conflicts.length > 0` and strategy is `manual`, opens `ConflictModal`; otherwise auto-resolves

---

### `src/ui/sourceControl/simpleSync.svelte`

Svelte 5 component. Subscribes to `plugin.syncState` and renders the Simple Mode panel.

Reactive local variables are declared with the `$state()` rune (e.g. `let loading = $state(false)`). The external store `plugin.syncState` is consumed via `.subscribe()` — the unsubscribe function returned by that call is stored and invoked inside `onDestroy()` to prevent memory leaks. Alternatively, if the store is imported into scope it can be read with Svelte's `$store` auto-subscription prefix, which also cleans up automatically.

---

### `src/ui/modals/conflictModal.ts`

Extends Obsidian's `Modal`. Iterates through `conflicts[]`, renders a side-by-side diff for each, accumulates resolutions in a `Map<string, ConflictResolution>`, and calls `onResolved(resolutions)` on Apply.

---

## Data Flow: Sync Triggered by File Change

```text
1.  vault.on("modify", handler)          [SyncManager.registerSmartTriggers]
2.  handler fires → clearTimeout/setTimeout (debounce)
3.  debounce fires → SyncManager.triggerSync()
4.  triggerSync → plugin.promiseQueue.addTask(runSync)
5.  runSync → syncState.markSyncStart()
6.  runSync → provider.sync() → ...(Git or GitHub API)...
7.  provider returns SyncResult
8.  runSync → syncState.markSyncSuccess(n) or markSyncError(msg)
9.  if conflicts & manual → SyncManager.openConflictResolver(conflicts)
10. if conflicts & auto   → SyncManager.applyConflictResolutions(conflicts)
11. UI re-renders from syncState subscription
```

---

## Adding a New Sync Backend

See [dev/SyncProvider.md](dev/SyncProvider.md) for a step-by-step guide to implementing the `SyncProvider` interface and wiring it into the plugin.

---

## Trust boundaries and path safety

API sync reads filenames from external forge responses. Treat those names as
untrusted input: `toVaultScopedPath` in `src/syncProvider/pathScope.ts` rejects
parent-directory traversal, absolute paths, Windows drive paths, backslashes,
and NUL bytes before converting a remote filename to a vault-relative path.
The inverse conversion also rejects parent traversal; scoped paths must remain
within the user-selected tracked directory. Do not bypass these helpers when
adding new provider implementations.

Provider credentials and encryption passphrases belong in Obsidian's secret
storage; never log them, include them in sync audit payloads, or serialize them
into sync manifests. A selected remote/branch must be checked against the
stored repository fingerprint before applying a remote baseline.

GitHub and GitLab support atomic multi-file remote writes; Gitea/Forgejo uses
per-file writes and can leave a partially applied remote change when a request
fails. Preserve these semantics when designing retries and conflict handling.

---

## Second-pass module boundaries and refactoring roadmap

- `src/security/logRedaction.ts` defines pure credential redaction used by
  audit logs and provider notices, avoiding Obsidian runtime dependencies.
- `src/setting/infra/githubPagination.ts` parses and validates pagination
  independently of the HTTP transport. The GitHub client limits pages and
  rejects duplicate pages and foreign hosts.
- `src/gitManager/simpleGit.ts` owns native Git, while
  `src/gitManager/isomorphicGit.ts` owns the browser-compatible fallback.
  Major dependency upgrades need regression tests for both paths.
- `src/main.ts`, `src/syncProvider/apiSyncProvider.ts`, and
  `src/setting/settings.ts` are still large orchestration boundaries.
  Extract one responsibility at a time; do not rewrite provider contracts
  or settings migration paths in a single breaking change.

Review [SECURITY.md](../SECURITY.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md) before modifying these boundaries.

---

## Native Git environment security

The native Git backend constructs its subprocess environment through
`src/gitManager/gitEnvironment.ts` rather than duplicating or overriding
sensitive variable rules inside `SimpleGit`. Unsafe Git editor, pager,
askpass, SSH command, and dynamic configuration variables are removed from
the inherited environment and rejected from user-configured extra variables.
The configured Git directory and ordinary environment variables remain
supported. Path augmentation uses the platform-specific delimiter.
