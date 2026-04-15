<script lang="ts">
    export interface Props {
        branchesList: string[];
        /** Loading state for fetching the branch list. */
        fetchingBranches: boolean;
        fetchBranchesError: string | null;
        currentBranch: string;
        onBranchChange: (event: Event) => void;
        /** Loading state for switching the current branch. */
        checkoutInProgress: boolean;
        pluginReady: boolean;
        isBlocked?: boolean;
        blockedReason?: string | null;
    }

    let {
        branchesList,
        fetchingBranches,
        fetchBranchesError,
        currentBranch,
        onBranchChange,
        checkoutInProgress,
        pluginReady,
        isBlocked = false,
        blockedReason = null,
    }: Props = $props();

    const fallbackLabel = $derived(
        fetchingBranches
            ? "Loading branches..."
            : fetchBranchesError
              ? "Unable to load branches"
              : "No branches found"
    );

    const selectorState = $derived(
        fetchingBranches
            ? "loading"
            : checkoutInProgress
              ? "switching"
              : isBlocked
                ? "blocked"
                : fetchBranchesError
                  ? "error"
                  : pluginReady
                    ? "ready"
                    : "disabled"
    );
</script>

<select
    class="branch-select"
    class:has-error={Boolean(fetchBranchesError)}
    onchange={onBranchChange}
    disabled={!pluginReady ||
        checkoutInProgress ||
        fetchingBranches ||
        isBlocked}
    value={currentBranch}
    aria-label="Select branch"
    aria-busy={fetchingBranches || checkoutInProgress}
    data-git-vault-branch-selector="true"
    data-git-vault-branch-state={selectorState}
    data-git-vault-current-branch={currentBranch}
    title={blockedReason ?? fetchBranchesError ?? undefined}
>
    {#if fetchingBranches || fetchBranchesError || branchesList.length === 0}
        {#if currentBranch}
            <option value={currentBranch}>{currentBranch}</option>
        {/if}
        <option value="" disabled title={fetchBranchesError ?? undefined}>
            {fallbackLabel}
        </option>
    {:else}
        {#each branchesList as b}
            <option value={b}>{b}</option>
        {/each}
    {/if}
</select>
