<script lang="ts">
    /**
     * SimpleSync.svelte
     *
     * One-button "Sync" UI for Simple Mode.
     * Renders a clean, Git-terminology-free panel with:
     *   – A prominent "Sync" button
     *   – Live status feedback (idle / syncing / error / conflict)
     *   – Basic stats (last sync time, files changed)
     */
    import { onDestroy, onMount } from "svelte";
    import type ObsidianGit from "../../main";
    import { normalizeTrackedDirectory } from "../../syncProvider/pathScope";
    import { syncAuditLog } from "../../syncProvider/syncAuditLog";
    import type { SyncState } from "../../syncProvider/syncState";

    export let plugin: ObsidianGit;

    let state: Readonly<SyncState> = plugin.syncState.getState();
    let unsubscribe: () => void;

    onMount(() => {
        unsubscribe = plugin.syncState.subscribe((s) => {
            state = s;
        });
    });

    onDestroy(() => {
        unsubscribe?.();
    });

    function auditUi(event: string, details: Record<string, unknown> = {}) {
        syncAuditLog("ui.simple-sync", event, {
            provider: plugin.settings.activeSyncProvider,
            ...details,
        });
    }

    // ── Computed labels ──────────────────────────────────────────────────

    $: syncButtonLabel = state.isSyncing ? "Syncing…" : "Sync";

    $: lastSyncLabel = state.lastSyncTime
        ? new Date(state.lastSyncTime).toLocaleTimeString()
        : "Never";

    $: trackedDirectoryLabel =
        normalizeTrackedDirectory(plugin.settings.trackedDirectory ?? "") ||
        "Vault root";

    $: providerLabel =
        state.provider === "git"
            ? "Git"
            : state.provider === "github"
              ? "GitHub"
              : state.provider === "gitlab"
                ? "GitLab"
                : state.provider === "gitea"
                  ? "Gitea"
                  : state.provider ?? "Unknown";

    $: statusLabel = (() => {
        if (state.isSyncing) return "Syncing your notes…";
        if (state.conflicts.length > 0)
            return `${state.conflicts.length} conflict(s) need attention`;
        if (state.lastErrorCode === "ALREADY_EXISTS") {
            return "All notes are up to date";
        }
        if (state.lastError) return `Error: ${state.lastError}`;
        if (!state.isOnline)
            return "Offline – changes will sync when reconnected";
        if (state.pendingChanges.length > 0)
            return `${state.pendingChanges.length} unsaved change(s)`;
        return "All notes are up to date";
    })();

    $: statusClass = (() => {
        if (state.isSyncing) return "status-syncing";
        if (state.conflicts.length > 0) return "status-conflict";
        if (state.lastErrorCode === "ALREADY_EXISTS") return "status-ok";
        if (state.lastError) return "status-error";
        if (!state.isOnline) return "status-offline";
        return "status-ok";
    })();

    $: auditUi("state", {
        isSyncing: state.isSyncing,
        pendingChanges: state.pendingChanges.length,
        conflicts: state.conflicts.length,
        lastError: state.lastError,
        lastSyncTime: state.lastSyncTime,
        syncCount: state.syncCount,
        trackedDirectory: trackedDirectoryLabel,
        providerLabel,
    });

    // ── Actions ──────────────────────────────────────────────────────────

    function triggerSync() {
        if (state.isSyncing) {
            auditUi("click.sync-ignored", {
                reason: "already-syncing",
            });
            return;
        }
        auditUi("click.sync", {
            pendingChanges: state.pendingChanges.length,
            conflicts: state.conflicts.length,
        });
        plugin.syncManager.triggerSync("ui-simple-sync");
    }

    function openConflictResolver() {
        auditUi("click.open-conflict-resolver", {
            conflictCount: state.conflicts.length,
        });
        plugin.syncManager.openConflictResolver(state.conflicts);
    }
</script>

<div class="git-vault-simple">
    <div class="git-vault-header">
        <span class="git-vault-title">Obsidian Git Vault</span>
        <span class="git-vault-provider-badge">{providerLabel}</span>
    </div>

    <div class="git-vault-status {statusClass}">
        <span class="git-vault-status-dot"></span>
        <span class="git-vault-status-text">{statusLabel}</span>
    </div>

    <button
        class="git-vault-sync-btn mod-cta"
        disabled={state.isSyncing}
        on:click={triggerSync}
    >
        {syncButtonLabel}
    </button>

    {#if state.conflicts.length > 0}
        <button class="git-vault-conflict-btn" on:click={openConflictResolver}>
            Resolve {state.conflicts.length} Conflict{state.conflicts.length > 1
                ? "s"
                : ""}
        </button>
    {/if}

    <div class="git-vault-meta">
        {#if state.provider !== "git"}
            <span>Scope: {trackedDirectoryLabel}</span>
            <span>·</span>
        {/if}
        <span>Last sync: {lastSyncLabel}</span>
        {#if state.syncCount > 0}
            <span>·</span>
            <span
                >{state.syncCount} sync{state.syncCount !== 1 ? "s" : ""} this session</span
            >
        {/if}
    </div>
</div>
