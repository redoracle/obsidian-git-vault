<script lang="ts">
    import { Platform, Scope, setIcon } from "obsidian";
    import { SOURCE_CONTROL_VIEW_CONFIG } from "src/constants";
    import type ObsidianGit from "src/main";
    import type {
        FileStatusResult,
        Status,
        StatusRootTreeItem,
        SyncUXMode,
        SyncProviderSetting,
    } from "src/types";
    import { CurrentGitAction, FileType } from "src/types";
    import { arrayProxyWithNewLength, getDisplayPath } from "src/utils";
    import { slide } from "svelte/transition";
    import FileComponent from "./components/fileComponent.svelte";
    import BranchSelect from "./components/branchSelect.svelte";
    import PulledFileComponent from "./components/pulledFileComponent.svelte";
    import StagedFileComponent from "./components/stagedFileComponent.svelte";
    import TreeComponent from "./components/treeComponent.svelte";
    import type GitView from "./sourceControl";
    import TooManyFilesComponent from "./components/tooManyFilesComponent.svelte";
    import { onMount, onDestroy } from "svelte";
    import SimpleSyncComponent from "./simpleSync.svelte";
    import NonMdFilter from "./components/nonMdFilter.svelte";
    import type { SyncState } from "src/syncProvider/syncState";
    import { syncAuditLog } from "src/syncProvider/syncAuditLog";

    interface Props {
        plugin: ObsidianGit;
        view: GitView;
    }

    let { plugin = $bindable(), view }: Props = $props();
    let loading: boolean = $state(false);
    let status: Status | undefined = $state();
    let lastPulledFiles: FileStatusResult[] = $state([]);
    // Branch selection state: checkout progress vs branch list fetching.
    let branchesList = $state([] as string[]);
    let currentBranch = $state("");
    let checkoutInProgress = $state(false);
    // Loading/error state for fetching the available branches is now derived
    // from SyncState.branchSelectionStatus (see $derived declarations below).
    let syncMode: SyncUXMode = $state("advanced");
    // True after the user switches branch (API providers) so the panel shows
    // a "pull to load new branch" hint until the next sync completes.
    let branchJustSwitched = $state(false);
    let commitMessage = $derived(plugin.settings.commitMessage);
    let buttons: HTMLElement[] = $state([]);
    let changesOpen = $state(true);
    let stagedOpen = $state(true);
    let lastPulledFilesOpen = $state(true);
    let unPushedCommits = $state(0);
    let stagedClosed: Record<string, boolean> = $state({});
    let unstagedClosed: Record<string, boolean> = $state({});
    let pulledClosed: Record<string, boolean> = $state({});
    let branchRefreshButtonEl: HTMLButtonElement | null = $state(null);

    let layoutChangeButtonEl: HTMLElement | null = $state(null);
    let stateAuditInterval: number | undefined;
    // Live mirror of the SyncStateManager — updated via subscription below.
    let syncState: Readonly<SyncState> = $state({
        lastSyncTime: null,
        pendingChanges: [],
        conflicts: [],
        provider: "git",
        isSyncing: false,
        isOnline: true,
        syncCount: 0,
        lastError: null,
        lastErrorCode: null,
        cachedGitStatus: null,
        branchSelection: null,
        branchSelectionStatus: "idle" as SyncState["branchSelectionStatus"],
        branchSelectionError: null,
        providerReady: false,
    });
    let unsubscribeSyncState: () => void = () => {};
    // Initialise to a safe default to satisfy Svelte 5 runes (reading a
    // prop/external value directly in $state() triggers state_referenced_locally).
    // The real value is applied in onMount via syncActiveProvider() and kept in
    // sync through the "obsidian-git:sync-provider-changed" workspace event.
    let activeProvider: SyncProviderSetting = $state("git");

    function syncActiveProvider(): void {
        activeProvider = plugin.settings.activeSyncProvider;
    }
    const branchSelectorReady = $derived(
        activeProvider === "git" ? plugin.gitReady : syncState.providerReady
    );
    const branchSelectorBlocked = $derived(
        syncState.isSyncing || plugin.state.gitAction !== CurrentGitAction.idle
    );
    const branchSelectorBlockedReason = $derived(
        syncState.isSyncing
            ? "A sync is already running."
            : plugin.state.gitAction !== CurrentGitAction.idle
              ? "Another Git operation is already running."
              : null
    );
    // True when using an API-backed provider (not local git).
    const isApiProvider = $derived(activeProvider !== "git");

    // ── Non-Markdown file filter ──────────────────────────────────────────
    // When false (default), the source-control panel hides non-.md files.
    let showNonMdFiles = $state(false);

    // ── Branch selection status (derived from SyncState) ────────────────────
    const fetchingBranches = $derived(
        syncState.branchSelectionStatus === "loading"
    );
    const fetchBranchesError = $derived(
        syncState.branchSelectionStatus === "error"
            ? syncState.branchSelectionError ?? "Failed to load branches"
            : null
    );

    // ── Markdown filter helpers ────────────────────────────────────────────
    function isMarkdownLike(path: string): boolean {
        const lower = path.toLowerCase();
        return lower.endsWith(".md") || lower.endsWith(".markdown");
    }

    function filterByMarkdown<T extends { path: string }>(items: T[]): T[] {
        return showNonMdFiles
            ? items
            : items.filter((f) => isMarkdownLike(f.path));
    }

    /** Filtered lists — rebuilt whenever showNonMdFiles or the raw data changes. */
    const visiblePendingChanges = $derived(
        filterByMarkdown(syncState.pendingChanges)
    );
    const visibleChangedFiles = $derived(
        filterByMarkdown(status?.changed ?? [])
    );
    const visibleStagedFiles = $derived(filterByMarkdown(status?.staged ?? []));
    const visibleLastPulledFiles = $derived(filterByMarkdown(lastPulledFiles));

    // Hierarchies are derived from the *filtered* arrays so TreeComponent
    // always receives the same data that the list view renders.
    const changeHierarchy = $derived(
        plugin.gitManager
            ? ({
                  title: "",
                  path: "",
                  vaultPath: "",
                  children:
                      plugin.gitManager.getTreeStructure(visibleChangedFiles),
              } as StatusRootTreeItem)
            : undefined
    );
    const stagedHierarchy = $derived(
        plugin.gitManager
            ? ({
                  title: "",
                  path: "",
                  vaultPath: "",
                  children:
                      plugin.gitManager.getTreeStructure(visibleStagedFiles),
              } as StatusRootTreeItem)
            : undefined
    );
    const lastPulledFilesHierarchy = $derived(
        plugin.gitManager
            ? ({
                  title: "",
                  path: "",
                  vaultPath: "",
                  children: plugin.gitManager.getTreeStructure(
                      visibleLastPulledFiles
                  ),
              } as StatusRootTreeItem)
            : undefined
    );

    let showTree: boolean = $state(false);

    function auditUi(event: string, details: Record<string, unknown> = {}) {
        syncAuditLog("ui.source-control", event, {
            mode: syncMode,
            provider: plugin.settings.activeSyncProvider,
            currentBranch,
            ...details,
        });
    }

    function auditStateSnapshot(): void {
        auditUi("state", {
            isSyncing: syncState.isSyncing,
            pendingChanges: syncState.pendingChanges.length,
            conflicts: syncState.conflicts.length,
            lastError: syncState.lastError,
            branchJustSwitched,
            changedCount: visibleChangedFiles.length,
            stagedCount: visibleStagedFiles.length,
            pulledCount: visibleLastPulledFiles.length,
            showTree,
            showNonMdFiles,
        });
    }

    function setTreeLayout(nextShowTree: boolean): void {
        showTree = nextShowTree;
        plugin.settings.treeStructure = nextShowTree;
        if (layoutChangeButtonEl) {
            setIcon(layoutChangeButtonEl, nextShowTree ? "list" : "folder");
        }
    }

    /**
     * Fetch the current branch list from the active provider.
     * State transitions (loading → ready/error) are published through
     * SyncState and flow into the component via the subscription.
     */
    async function refreshBranches(force = false): Promise<void> {
        if (!plugin.syncManager) return;
        try {
            if (force) {
                await plugin.syncManager.refreshBranchSelection("manual");
            } else {
                await plugin.syncManager.ensureBranchSelectionFresh(
                    "view-mounted"
                );
            }
        } catch (e) {
            plugin.log("Failed to refresh branch selector:", e);
        }
    }

    onMount(() => {
        syncMode = plugin.settings.syncMode;
        // Subscribe to the SyncStateManager so the API-provider file panel
        // updates reactively whenever syncs complete or files change.
        const syncStateStore = plugin.syncState as
            | {
                  subscribe?: (listener: (s: SyncState) => void) => () => void;
              }
            | undefined;
        if (typeof syncStateStore?.subscribe === "function") {
            unsubscribeSyncState = syncStateStore.subscribe((s) => {
                syncState = s;
                // Clear the "pull to load new branch" hint once a sync succeeds.
                if (branchJustSwitched && !s.isSyncing && !s.lastError) {
                    branchJustSwitched = false;
                }
                // Reactively update branch selector whenever the SyncState
                // branchSelection changes (e.g. after init or branch switch).
                // fetchingBranches / fetchBranchesError are derived from
                // s.branchSelectionStatus so they update automatically.
                if (s.branchSelection) {
                    branchesList = s.branchSelection.branches ?? [];
                    currentBranch = s.branchSelection.current ?? "";
                }
            });
        }

        // Read the current SyncState immediately on mount so the branch
        // selector populates without waiting for the next subscriber tick,
        // covering the case where the view is restored from a workspace
        // layout after init() already completed.
        if (plugin.syncState?.getState) {
            const currentState = plugin.syncState.getState();
            if (currentState.branchSelection) {
                branchesList = currentState.branchSelection.branches ?? [];
                currentBranch = currentState.branchSelection.current ?? "";
            }
        }
        // Always ask the SyncManager to ensure freshness — it will skip the
        // fetch if branch selection is already loaded and not stale. Safe to
        // call unconditionally; no duplicate requests are made.
        void plugin.syncManager?.ensureBranchSelectionFresh("view-mounted");

        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:loading-status",
                () => (loading = true)
            )
        );
        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:status-changed",
                () => void refresh().catch(console.error)
            )
        );
        if (view.plugin.cachedStatus == undefined) {
            view.plugin.refresh().catch(console.error);
        } else {
            refresh().catch(console.error);
        }

        view.scope = new Scope(plugin.app.scope);
        view.scope.register(["Ctrl"], "Enter", (_: KeyboardEvent) =>
            commitAndSync()
        );

        // Refresh branches when the SyncManager or provider signals readiness.
        // Uses ensureBranchSelectionFresh to avoid duplicate fetches.
        view.registerEvent(
            view.app.workspace.on("obsidian-git:refreshed", () => {
                void plugin.syncManager?.ensureBranchSelectionFresh(
                    "workspace-refreshed"
                );
            })
        );
        view.registerEvent(
            view.app.workspace.on("obsidian-git:sync-mode-changed", (mode) => {
                syncMode = mode;
            })
        );
        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:sync-provider-changed",
                (provider) => {
                    // Prefer the event payload when present to avoid races
                    // and unnecessary settings reads; fall back to the
                    // authoritative settings value otherwise.
                    if (typeof provider === "string" && provider) {
                        activeProvider = provider;
                    } else {
                        syncActiveProvider();
                    }
                    void plugin.syncManager?.ensureBranchSelectionFresh(
                        "provider-changed"
                    );
                }
            )
        );
        // Ensure UI state reflects settings immediately and robustly.
        syncActiveProvider();
        view.registerEvent(
            view.app.workspace.on(
                "obsidian-git:tree-structure-changed",
                (nextShowTree) => {
                    if (typeof nextShowTree !== "boolean") return;
                    setTreeLayout(nextShowTree);
                }
            )
        );
        setTreeLayout(plugin.settings.treeStructure);

        auditStateSnapshot();
        // Only enable periodic auditing in non-production builds to avoid log spam
        if (process.env.NODE_ENV !== "production") {
            stateAuditInterval = window.setInterval(auditStateSnapshot, 30_000);
        }
    });

    onDestroy(() => {
        unsubscribeSyncState();
        if (typeof stateAuditInterval === "number") {
            window.clearInterval(stateAuditInterval);
        }
    });

    function onBranchChange(e: Event) {
        const select = e.target as HTMLSelectElement;
        const selected = select.value;
        if (!selected) return;
        if (selected === currentBranch) return;
        auditUi("click.branch-change", {
            previousBranch: currentBranch,
            nextBranch: selected,
        });
        // Snapshot the previous branch so we can roll back the bind on failure
        const previous = currentBranch;
        checkoutInProgress = true;
        loading = true;
        void plugin.promiseQueue.addTask(async () => {
            try {
                if (!plugin.syncManager) {
                    plugin.displayError("Sync manager is not initialized yet.");
                    return;
                }
                const switched =
                    await plugin.syncManager.switchBranch(selected);
                if (!switched) {
                    currentBranch = previous;
                    return;
                }
                currentBranch = selected;
                auditUi("branch-change.success", {
                    previousBranch: previous,
                    nextBranch: selected,
                });
                if (activeProvider === "git") {
                    plugin.displayMessage(`Switched to ${selected}`);
                    await plugin.notifyIfNonDefaultTrackingBranch();
                } else {
                    plugin.displayMessage(
                        `Switched sync target to "${selected}" and updated the local vault.`
                    );
                }
            } catch (err) {
                // Roll back the select to the branch we were actually on
                currentBranch = previous;
                auditUi("branch-change.failure", {
                    previousBranch: previous,
                    nextBranch: selected,
                    error: err instanceof Error ? err.message : String(err),
                });
                plugin.displayError(err);
            } finally {
                checkoutInProgress = false;
                loading = false;
                // Trigger a workspace refresh so git-mode consumers also update;
                // the event handler calls ensureBranchSelectionFresh.
                view.app.workspace.trigger("obsidian-git:refreshed");
                refresh().catch(console.error);
            }
        });
    }
    $effect(() => {
        buttons.forEach((btn) => {
            if (!btn) return;
            setIcon(btn, btn.getAttr("data-icon")!);
        });
    });

    $effect(() => {
        if (!layoutChangeButtonEl) return;
        setIcon(layoutChangeButtonEl, showTree ? "list" : "folder");
    });

    $effect(() => {
        if (!branchRefreshButtonEl) return;
        setIcon(branchRefreshButtonEl, "refresh-ccw");
    });

    $effect(() => {
        if (!isApiProvider || checkoutInProgress) return;
        loading = syncState.isSyncing;
    });

    $effect(() => {
        // highlight push button if there are unpushed commits
        buttons.forEach((btn) => {
            // when reloading the view from settings change, the btn are null at first
            if (!btn || btn.id != "push") return;
            if (Platform.isMobile) {
                btn.removeClass("button-border");
                if (unPushedCommits > 0) {
                    btn.addClass("button-border");
                }
            } else {
                btn.firstElementChild?.removeAttribute("color");
                if (unPushedCommits > 0) {
                    btn.firstElementChild?.setAttr(
                        "color",
                        "var(--text-accent)"
                    );
                }
            }
        });
    });

    function commit() {
        loading = true;
        if (status) {
            const onlyStaged = status.staged.length > 0;
            auditUi("click.commit", {
                onlyStaged,
                stagedCount: status.staged.length,
                changedCount: status.changed.length,
            });
            void plugin.promiseQueue.addTask(() =>
                plugin
                    .commit({
                        fromAutoBackup: false,
                        commitMessage,
                        onlyStaged,
                    })
                    .then(() => (commitMessage = plugin.settings.commitMessage))
                    .finally(requestRefresh)
            );
        }
    }

    function commitAndSync() {
        loading = true;
        if (status) {
            // If staged files exist only commit them, but if not, commit all.
            // I hope this is the most intuitive way.
            const onlyStaged = status.staged.length > 0;
            auditUi("click.commit-and-sync", {
                onlyStaged,
                stagedCount: status.staged.length,
                changedCount: status.changed.length,
            });
            void plugin.promiseQueue.addTask(() =>
                plugin
                    .commitAndSync({
                        fromAutoBackup: false,
                        commitMessage,
                        onlyStaged,
                    })
                    .then(() => {
                        commitMessage = plugin.settings.commitMessage;
                    })
                    .finally(requestRefresh)
            );
        }
    }

    async function refresh(): Promise<void> {
        auditUi("refresh:start", {
            gitReady: plugin.gitReady,
        });
        if (!plugin.gitReady) {
            status = undefined;
            loading = false;
            auditUi("refresh:skipped", {
                reason: "git-not-ready",
            });
            return;
        }
        try {
            unPushedCommits = await plugin.gitManager.getUnpushedCommits();

            const nextStatus = plugin.cachedStatus;
            if (
                plugin.lastPulledFiles &&
                plugin.lastPulledFiles != lastPulledFiles
            ) {
                lastPulledFiles = plugin.lastPulledFiles;
            }
            if (nextStatus) {
                const sort = (a: FileStatusResult, b: FileStatusResult) => {
                    return a.vaultPath
                        .split("/")
                        .last()!
                        .localeCompare(getDisplayPath(b.vaultPath));
                };
                status = {
                    ...nextStatus,
                    changed: [...nextStatus.changed].sort(sort),
                    staged: [...nextStatus.staged].sort(sort),
                };
            } else {
                status = undefined;
            }
            auditUi("refresh:success", {
                unpushedCommits: unPushedCommits,
                changedCount: status?.changed.length ?? 0,
                stagedCount: status?.staged.length ?? 0,
                pulledCount: lastPulledFiles.length,
            });
        } catch (error) {
            auditUi("refresh:failure", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            loading = false;
        }
    }

    function requestRefresh() {
        view.app.workspace.trigger("obsidian-git:refresh");
    }

    function clickRefresh() {
        auditUi("click.refresh");
        requestRefresh();
    }

    function clickRefreshBranches() {
        auditUi("click.refresh-branches");
        void refreshBranches(true);
    }

    function stageAll(event: MouseEvent) {
        event.stopPropagation();
        loading = true;
        auditUi("click.stage-all", {
            changedCount: status?.changed.length ?? 0,
        });
        void plugin.promiseQueue.addTask(() =>
            plugin.gitManager
                .stageAll({ status: status })
                .finally(requestRefresh)
        );
    }

    function unstageAll(event: MouseEvent) {
        event.stopPropagation();
        loading = true;
        auditUi("click.unstage-all", {
            stagedCount: status?.staged.length ?? 0,
        });
        void plugin.promiseQueue.addTask(() =>
            plugin.gitManager
                .unstageAll({ status: status })
                .finally(requestRefresh)
        );
    }

    function push() {
        loading = true;
        auditUi("click.push", {
            unPushedCommits,
        });
        if (isApiProvider && plugin.syncManager) {
            plugin.syncManager.triggerPush("ui-advanced-source-control");
            return;
        }

        void plugin.promiseQueue.addTask(() =>
            plugin.push().finally(requestRefresh)
        );
    }

    function pull() {
        loading = true;
        auditUi("click.pull");
        if (isApiProvider && plugin.syncManager) {
            plugin.syncManager.triggerPull("ui-advanced-source-control");
            return;
        }

        void plugin.promiseQueue.addTask(() =>
            plugin.pullChangesFromRemote().finally(requestRefresh)
        );
    }
    function discard(event: Event) {
        event.stopPropagation();
        auditUi("click.discard-all", {
            changedCount: status?.changed.length ?? 0,
        });
        void plugin.discardAll();
    }

    function toggleLayoutChange(): void {
        const nextShowTree = !showTree;
        auditUi("click.toggle-layout", {
            nextShowTree,
        });
        setTreeLayout(nextShowTree);
        void plugin
            .saveSettings()
            .then(() => {
                view.app.workspace.trigger(
                    "obsidian-git:tree-structure-changed",
                    nextShowTree
                );
            })
            .catch((error: unknown) => plugin.displayError(error));
    }

    function clearCommitMessage(): void {
        auditUi("click.clear-commit-message", {
            hadMessage: commitMessage.length > 0,
        });
        commitMessage = "";
    }

    function toggleStagedOpen(): void {
        stagedOpen = !stagedOpen;
        auditUi("click.toggle-staged-section", {
            open: stagedOpen,
        });
    }

    function toggleChangesOpen(): void {
        changesOpen = !changesOpen;
        auditUi("click.toggle-changes-section", {
            open: changesOpen,
        });
    }

    function toggleLastPulledOpen(): void {
        lastPulledFilesOpen = !lastPulledFilesOpen;
        auditUi("click.toggle-pulled-section", {
            open: lastPulledFilesOpen,
        });
    }

    let rows = $derived((commitMessage.match(/\n/g) || []).length + 1 || 1);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if syncMode === "simple"}
    <main
        data-type={SOURCE_CONTROL_VIEW_CONFIG.type}
        class="git-view simple-mode-view"
    >
        <div class="nav-header simple-nav-header">
            <div class="nav-branch">
                <BranchSelect
                    {branchesList}
                    {fetchingBranches}
                    {fetchBranchesError}
                    {currentBranch}
                    {onBranchChange}
                    {checkoutInProgress}
                    pluginReady={branchSelectorReady}
                    isBlocked={branchSelectorBlocked}
                    blockedReason={branchSelectorBlockedReason}
                />
                <button
                    type="button"
                    class="clickable-icon git-vault-branch-refresh"
                    aria-label="Refresh branches"
                    data-git-vault-branch-refresh="true"
                    bind:this={branchRefreshButtonEl}
                    disabled={!branchSelectorReady ||
                        fetchingBranches ||
                        checkoutInProgress}
                    onclick={clickRefreshBranches}
                ></button>
            </div>
        </div>
        <SimpleSyncComponent {plugin} />
    </main>
{:else}
    <main
        data-type={SOURCE_CONTROL_VIEW_CONFIG.type}
        class="git-view"
        data-git-vault-layout={showTree ? "tree" : "list"}
    >
        <div class="nav-header">
            <div class="nav-branch">
                <BranchSelect
                    {branchesList}
                    {fetchingBranches}
                    {fetchBranchesError}
                    {currentBranch}
                    {onBranchChange}
                    {checkoutInProgress}
                    pluginReady={branchSelectorReady}
                    isBlocked={branchSelectorBlocked}
                    blockedReason={branchSelectorBlockedReason}
                />
                <button
                    type="button"
                    class="clickable-icon git-vault-branch-refresh"
                    aria-label="Refresh branches"
                    data-git-vault-branch-refresh="true"
                    bind:this={branchRefreshButtonEl}
                    disabled={!branchSelectorReady ||
                        fetchingBranches ||
                        checkoutInProgress}
                    onclick={clickRefreshBranches}
                ></button>
                {#if isApiProvider || plugin.gitReady}
                    <!-- Filter non-Markdown files from the source-control panel -->
                    <NonMdFilter bind:showNonMdFiles />
                {/if}
            </div>
            <div class="nav-buttons-container">
                {#if !isApiProvider}
                    <!-- Git-only actions -->
                    <div
                        id="backup-btn"
                        data-icon="arrow-up-circle"
                        class="clickable-icon nav-action-button"
                        aria-label="Commit-and-sync"
                        bind:this={buttons[0]}
                        onclick={commitAndSync}
                    ></div>
                    <div
                        id="commit-btn"
                        data-icon="check"
                        class="clickable-icon nav-action-button"
                        aria-label="Commit"
                        bind:this={buttons[1]}
                        onclick={commit}
                    ></div>
                    <div
                        id="stage-all"
                        class="clickable-icon nav-action-button"
                        data-icon="plus-circle"
                        aria-label="Stage all"
                        bind:this={buttons[2]}
                        onclick={stageAll}
                    ></div>
                    <div
                        id="unstage-all"
                        class="clickable-icon nav-action-button"
                        data-icon="minus-circle"
                        aria-label="Unstage all"
                        bind:this={buttons[3]}
                        onclick={unstageAll}
                    ></div>
                {/if}
                <div
                    id="push"
                    class="clickable-icon nav-action-button"
                    data-icon="upload"
                    aria-label="Push"
                    bind:this={buttons[4]}
                    onclick={push}
                ></div>
                <div
                    id="pull"
                    class="clickable-icon nav-action-button"
                    data-icon="download"
                    aria-label="Pull"
                    bind:this={buttons[5]}
                    onclick={pull}
                ></div>
                {#if !isApiProvider}
                    <div
                        id="layoutChange"
                        class="clickable-icon nav-action-button"
                        aria-label="Change Layout"
                        data-icon={showTree ? "list" : "folder"}
                        bind:this={layoutChangeButtonEl}
                        onclick={toggleLayoutChange}
                    ></div>
                {/if}
                <div
                    id="refresh"
                    class="clickable-icon nav-action-button"
                    class:loading
                    data-icon="refresh-ccw"
                    aria-label="Refresh"
                    bind:this={buttons[7]}
                    onclick={clickRefresh}
                ></div>
            </div>
        </div>

        {#if !isApiProvider}
            <div class="git-commit-msg">
                <textarea
                    {rows}
                    class="commit-msg-input"
                    spellcheck="true"
                    placeholder="Commit Message"
                    bind:value={commitMessage}
                ></textarea>
                {#if commitMessage}
                    <div
                        class="git-commit-msg-clear-button"
                        onclick={clearCommitMessage}
                        aria-label={"Clear"}
                    ></div>
                {/if}
            </div>
        {/if}

        <div class="nav-files-container">
            {#if isApiProvider}
                <!-- ── API provider: pending-changes panel ─────────────── -->
                {#if branchJustSwitched}
                    <div class="sync-api-hint">
                        <span class="sync-api-hint-icon">⤵</span>
                        Pull or Sync to load files from
                        <strong>{currentBranch}</strong>
                    </div>
                {/if}
                {#if syncState.isSyncing}
                    <div class="sync-api-hint sync-api-hint--syncing">
                        Syncing…
                    </div>
                {:else if syncState.lastError}
                    <div class="sync-api-hint sync-api-hint--error">
                        {syncState.lastError}
                    </div>
                {:else if syncState.pendingChanges.length > 0}
                    <div class="tree-item nav-folder mod-root">
                        <div class="tree-item nav-folder">
                            <div class="tree-item-self nav-folder-title">
                                <div
                                    class="tree-item-inner nav-folder-title-content"
                                >
                                    Pending Changes
                                </div>
                                <div class="git-tools">
                                    <div class="files-count">
                                        {visiblePendingChanges.length}
                                    </div>
                                </div>
                            </div>
                            <div class="tree-item-children nav-folder-children">
                                {#if visiblePendingChanges.length > 0}
                                    {#each visiblePendingChanges as change (change.path)}
                                        <div class="tree-item nav-file">
                                            <div
                                                class="tree-item-self nav-file-title"
                                            >
                                                <div
                                                    class="tree-item-inner nav-file-title-content"
                                                >
                                                    {change.path
                                                        .split("/")
                                                        .pop() ?? change.path}
                                                </div>
                                                <span
                                                    class="sync-change-badge sync-change-badge--{change.type}"
                                                    title={change.path}
                                                >
                                                    {change.type === "added"
                                                        ? "A"
                                                        : change.type ===
                                                            "deleted"
                                                          ? "D"
                                                          : "M"}
                                                </span>
                                            </div>
                                        </div>
                                    {/each}
                                {:else}
                                    <div class="sync-api-hint">
                                        Pending changes are hidden by the
                                        current Markdown filter
                                    </div>
                                {/if}
                            </div>
                        </div>
                    </div>
                {:else}
                    <div class="sync-api-hint sync-api-hint--ok">
                        All files synced
                        {#if syncState.lastSyncTime}
                            · {new Date(
                                syncState.lastSyncTime
                            ).toLocaleTimeString()}
                        {/if}
                    </div>
                {/if}
            {:else if status && stagedHierarchy && changeHierarchy}
                <div class="tree-item nav-folder mod-root">
                    <div
                        class="staged tree-item nav-folder"
                        class:is-collapsed={!stagedOpen}
                    >
                        <div
                            class="tree-item-self is-clickable nav-folder-title"
                            onclick={toggleStagedOpen}
                        >
                            <div
                                class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                class:is-collapsed={!stagedOpen}
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="24"
                                    height="24"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    class="svg-icon right-triangle"
                                    ><path d="M3 8L12 17L21 8" /></svg
                                >
                            </div>
                            <div
                                class="tree-item-inner nav-folder-title-content"
                            >
                                Staged Changes
                            </div>

                            <div class="git-tools">
                                <div class="buttons">
                                    <div
                                        data-icon="minus"
                                        aria-label="Unstage"
                                        bind:this={buttons[8]}
                                        onclick={unstageAll}
                                        class="clickable-icon"
                                    >
                                        <svg
                                            width="18"
                                            height="18"
                                            viewBox="0 0 18 18"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            class="svg-icon lucide-minus"
                                            ><line
                                                x1="4"
                                                y1="9"
                                                x2="14"
                                                y2="9"
                                            /></svg
                                        >
                                    </div>
                                </div>
                                <div class="files-count">
                                    {visibleStagedFiles.length}
                                </div>
                            </div>
                        </div>
                        {#if stagedOpen}
                            <div
                                class="tree-item-children nav-folder-children"
                                transition:slide|local={{ duration: 150 }}
                            >
                                {#if showTree}
                                    <TreeComponent
                                        hierarchy={stagedHierarchy}
                                        {plugin}
                                        {view}
                                        fileType={FileType.staged}
                                        topLevel={true}
                                        bind:closed={stagedClosed}
                                    />
                                {:else}
                                    {#each arrayProxyWithNewLength(visibleStagedFiles, 500) as stagedFile}
                                        <StagedFileComponent
                                            change={stagedFile}
                                            {view}
                                            manager={plugin.gitManager}
                                        />
                                    {/each}
                                    <TooManyFilesComponent
                                        files={visibleStagedFiles}
                                    />
                                {/if}
                            </div>
                        {/if}
                    </div>
                    <div
                        class="changes tree-item nav-folder"
                        class:is-collapsed={!changesOpen}
                    >
                        <div
                            onclick={toggleChangesOpen}
                            class="tree-item-self is-clickable nav-folder-title"
                        >
                            <div
                                class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                class:is-collapsed={!changesOpen}
                            >
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="24"
                                    height="24"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    class="svg-icon right-triangle"
                                    ><path d="M3 8L12 17L21 8" /></svg
                                >
                            </div>

                            <div
                                class="tree-item-inner nav-folder-title-content"
                            >
                                Changes
                            </div>
                            <div class="git-tools">
                                <div class="buttons">
                                    <div
                                        data-icon="undo"
                                        aria-label="Discard"
                                        onclick={discard}
                                        class="clickable-icon"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="24"
                                            height="24"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            class="svg-icon lucide-undo"
                                            ><path d="M3 7v6h6" /><path
                                                d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"
                                            /></svg
                                        >
                                    </div>
                                    <div
                                        data-icon="plus"
                                        aria-label="Stage"
                                        bind:this={buttons[9]}
                                        onclick={stageAll}
                                        class="clickable-icon"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="24"
                                            height="24"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            class="svg-icon lucide-plus"
                                            ><line
                                                x1="12"
                                                y1="5"
                                                x2="12"
                                                y2="19"
                                            /><line
                                                x1="5"
                                                y1="12"
                                                x2="19"
                                                y2="12"
                                            /></svg
                                        >
                                    </div>
                                </div>
                                <div class="files-count">
                                    {visibleChangedFiles.length}
                                </div>
                            </div>
                        </div>
                        {#if changesOpen}
                            <div
                                class="tree-item-children nav-folder-children"
                                transition:slide|local={{ duration: 150 }}
                            >
                                {#if showTree}
                                    <TreeComponent
                                        hierarchy={changeHierarchy}
                                        {plugin}
                                        {view}
                                        fileType={FileType.changed}
                                        topLevel={true}
                                        bind:closed={unstagedClosed}
                                    />
                                {:else}
                                    {#each arrayProxyWithNewLength(visibleChangedFiles, 500) as change}
                                        <FileComponent
                                            {change}
                                            {view}
                                            manager={plugin.gitManager}
                                        />
                                    {/each}
                                    <TooManyFilesComponent
                                        files={visibleChangedFiles}
                                    />
                                {/if}
                            </div>
                        {/if}
                    </div>
                    {#if visibleLastPulledFiles.length > 0 && lastPulledFilesHierarchy}
                        <div
                            class="pulled nav-folder"
                            class:is-collapsed={!lastPulledFilesOpen}
                        >
                            <div
                                class="tree-item-self is-clickable nav-folder-title"
                                onclick={toggleLastPulledOpen}
                            >
                                <div
                                    class="tree-item-icon nav-folder-collapse-indicator collapse-icon"
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        class="svg-icon right-triangle"
                                        ><path d="M3 8L12 17L21 8" /></svg
                                    >
                                </div>

                                <div
                                    class="tree-item-inner nav-folder-title-content"
                                >
                                    Recently Pulled Files
                                </div>

                                <span class="tree-item-flair"
                                    >{visibleLastPulledFiles.length}</span
                                >
                            </div>
                            {#if lastPulledFilesOpen}
                                <div
                                    class="tree-item-children nav-folder-children"
                                    transition:slide|local={{ duration: 150 }}
                                >
                                    {#if showTree}
                                        <TreeComponent
                                            hierarchy={lastPulledFilesHierarchy}
                                            {plugin}
                                            {view}
                                            fileType={FileType.pulled}
                                            topLevel={true}
                                            bind:closed={pulledClosed}
                                        />
                                    {:else}
                                        {#each visibleLastPulledFiles as change}
                                            <PulledFileComponent
                                                {change}
                                                {view}
                                            />
                                        {/each}
                                        <TooManyFilesComponent
                                            files={visibleLastPulledFiles}
                                        />
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </main>
{/if}
