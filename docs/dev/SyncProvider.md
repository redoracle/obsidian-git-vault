# Implementing a New SyncProvider Backend

This guide explains how to add a new sync backend (e.g. GitLab, Gitea, S3, or a self-hosted service) to Obsidian Git Vault.

---

## The SyncProvider Interface

All backends must implement `SyncProvider` from `src/syncProvider/syncProvider.ts`:

```ts
interface SyncProvider {
    /** Called once on plugin load or settings reload. Use for auth checks, repo validation, etc. */
    init(): Promise<void>;

    /**
     * Bidirectional sync — pull remote changes then push local changes.
     * Returns a `SyncResult` because the caller needs an aggregated outcome
     * (files changed, conflicts detected, overall success) when both
     * directions are coordinated in a single operation.
     */
    sync(): Promise<SyncResult>;

    /**
     * Download remote changes only.
     *
     * Returns `void` — errors are surfaced by throwing.  Non-fatal warnings
     * or progress updates should be emitted via `SyncStateManager` or a
     * callback/event rather than through the return value.
     */
    pull(): Promise<void>;

    /**
     * Upload local changes only.
     *
     * Returns `void` — same contract as `pull()`.  Throw on fatal errors;
     * use structured events for partial progress.
     */
    push(): Promise<void>;

    /** Apply a set of conflict resolutions decided by the user or auto-strategy. */
    resolveConflicts(resolutions: ConflictResolution[]): Promise<void>;

    /**
     * Return a snapshot of the current sync status.
     * Avoid expensive operations here — this may be called frequently.
     */
    getStatus(): Promise<SyncStatus>;

    /** Capability flags that drive provider-specific UI hints. */
    getCapabilities(): SyncProviderCapabilities;

    /** Metadata for a specific vault file, used by the sync metadata sidebar. */
    getFileMetadata(path: string): Promise<SyncFileMetadata>;
}
```

### Supporting Types

```ts
interface SyncResult {
    filesChanged: number;
    conflicts: Conflict[];
    message: string;
    success: boolean;
}

interface SyncStatus {
    hasChanges: boolean;
    hasConflicts: boolean;
    lastSyncTime: number | null;
    pendingFiles: number;
    provider: SyncProviderType;
    online: boolean;
}

interface Conflict {
    path: string;
    localContent?: string | Uint8Array;
    remoteContent?: string | Uint8Array;
    baseContent?: string | Uint8Array;
    isBinary?: boolean;
    deletedLocal?: boolean;
    deletedRemote?: boolean;
}

type ConflictResolution =
    | {
          path: string;
          strategy: Exclude<ConflictStrategy, "manual">;
      }
    | {
          path: string;
          strategy: "manual";
          manualContent: string;
      };

type SyncProviderType = "git" | "github" | "gitlab" | "gitea";
type ConflictStrategy =
    | "last-write-wins"
    | "always-local"
    | "always-remote"
    | "manual";
```

---

## Step-by-Step: Adding a Backend

### 1. Create the provider class

```text
src/syncProvider/myBackendSyncProvider.ts
```

```ts
import type ObsidianGit from "src/main";
import type {
    SyncProvider,
    SyncResult,
    SyncStatus,
    Conflict,
    ConflictResolution,
} from "./syncProvider";

export class MyBackendSyncProvider implements SyncProvider {
    constructor(private readonly plugin: ObsidianGit) {}

    async init(): Promise<void> {
        // Validate credentials, check network, ensure repo exists
    }

    async sync(): Promise<SyncResult> {
        // Pull then push; collect conflicts
        return { filesChanged: 0, conflicts: [], message: "OK", success: true };
    }

    async pull(): Promise<void> {
        /* ... */
    }

    async push(): Promise<void> {
        /* ... */
    }

    async resolveConflicts(resolutions: ConflictResolution[]): Promise<void> {
        // Apply each resolution to local vault and/or remote
    }

    async getStatus(): Promise<SyncStatus> {
        /* ... */
    }
}
```

### 2. Add a provider type constant

In `src/types.ts`, extend `SyncProviderSetting`:

```ts
export type SyncProviderSetting =
    | "git"
    | "github"
    | "gitlab"
    | "gitea"
    | "my-backend";
```

### 3. Add default settings

In `src/constants.ts`, no change needed unless you add new config fields. If you do (e.g. an API endpoint URL), add them to `DEFAULT_SETTINGS` in `constants.ts` and declare them in the `ObsidianGitSettings` interface in `types.ts`.

### 4. Wire into SyncManager

In `src/syncProvider/syncManager.ts`, update `buildProvider()`:

```ts
private buildProvider(): SyncProvider {
  const { activeSyncProvider } = this.plugin.settings;

  if (activeSyncProvider === "my-backend") {
    return new MyBackendSyncProvider(this.plugin);
  }

  if (Platform.isMobileApp && activeSyncProvider === "git") {
    return new GitHubApiSyncProvider(this.plugin);
  }

  if (activeSyncProvider === "github") {
    return new GitHubApiSyncProvider(this.plugin);
  }

  if (activeSyncProvider === "gitlab") {
    return new GitLabApiSyncProvider(this.plugin);
  }

  if (activeSyncProvider === "gitea") {
    return new GiteaApiSyncProvider(this.plugin);
  }

  return new GitSyncProvider(this.plugin);
}
```

### 5. Add a settings UI entry

In `src/setting/settings.ts`, add your provider to the Sync Backend dropdown:

```ts
.addOption("my-backend", "My Backend");
```

Add any required credential fields (token, URL, etc.) inside the conditional block that checks `activeSyncProvider === "my-backend"`.

### 6. Add to the Types file

Extend `SyncProviderType` in `syncProvider.ts`:

```ts
export type SyncProviderType =
    | "git"
    | "github"
    | "gitlab"
    | "gitea"
    | "my-backend";
```

---

## Guidelines

- **Use `requestUrl` from `obsidian`** for all HTTP calls. Do not use `fetch` or `XMLHttpRequest` directly — `requestUrl` works on mobile and desktop without CORS restrictions.
- **Never block the main thread.** All network I/O must be `async`.
- **Use `plugin.promiseQueue`** if you need to ensure your operations don't run concurrently with other sync operations.
- **Update `SyncStateManager`** via the mutators (`markSyncStart`, `markSyncSuccess`, etc.) to keep the UI accurate.
- **Handle errors gracefully.** Catch network errors, auth errors, and rate limits; surface them via `syncState.markSyncError(message)` rather than throwing unhandled exceptions.
- **Return real conflict objects** from `sync()` if you detect divergent changes. The `SyncManager` will route them to the conflict resolver automatically.

### Implementing `pull()` and `push()`

- **Throw on fatal errors.** Because `pull()` and `push()` return `void`, the only way for callers to learn about failures is through exceptions. Throw descriptive errors for network failures, auth issues, and unrecoverable states.
- **Use structured events or callbacks for progress / partial results.** If a pull downloads many files, emit progress through `SyncStateManager` rather than trying to return intermediate data.
- **Map pull/push outcomes into `SyncResult` inside `sync()`.** Your `sync()` implementation should call its own `pull()` and `push()` internally, catch their errors, collect conflict/change data, and return a coherent `SyncResult` so callers that need an aggregated outcome can rely on `sync()`'s return value.

---

## Testing Your Backend

1. Build with `pnpm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to a test vault at `.obsidian/plugins/git-vault/`
3. Switch the Sync Backend dropdown to your new provider
4. Test: initial sync (empty remote), incremental sync (changed files), conflict detection, offline behaviour

If you'd like to submit your backend as a PR, please open an issue first to discuss the design.
