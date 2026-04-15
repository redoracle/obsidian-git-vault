<script lang="ts">
    import { setIcon } from "obsidian";
    import { syncAuditLog } from "src/syncProvider/syncAuditLog";

    interface Props {
        showNonMdFiles: boolean;
        mdFilterIconEl?: HTMLElement | null;
    }

    let {
        showNonMdFiles = $bindable(),
        mdFilterIconEl = $bindable(null),
    }: Props = $props();

    function toggleNonMdFiles(): void {
        syncAuditLog("ui.source-control", "click.toggle-non-md-filter", {
            nextShowNonMdFiles: !showNonMdFiles,
        });
        showNonMdFiles = !showNonMdFiles;
    }

    $effect(() => {
        if (mdFilterIconEl) {
            setIcon(
                mdFilterIconEl,
                showNonMdFiles ? "file-code-2" : "file-text"
            );
        }
    });
</script>

<button
    type="button"
    class="clickable-icon git-vault-md-filter"
    class:is-active={showNonMdFiles}
    aria-label={showNonMdFiles
        ? "Showing all files — click to hide non-Markdown"
        : "Showing Markdown files only — click to reveal all"}
    aria-pressed={showNonMdFiles}
    title={showNonMdFiles ? "Hide non-Markdown files" : "Show all files"}
    data-git-vault-non-md-filter={showNonMdFiles ? "visible" : "hidden"}
    bind:this={mdFilterIconEl}
    onclick={toggleNonMdFiles}
></button>
