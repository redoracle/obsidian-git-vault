<script lang="ts">
    import { TFile } from "obsidian";
    import { hoverPreview } from "src/utils";
    import type { FileStatusResult } from "src/types";
    import { getDisplayPath, getNewLeaf, mayTriggerFileMenu } from "src/utils";
    import type GitView from "../sourceControl";

    interface Props {
        change: FileStatusResult;
        view: GitView;
    }

    let props: Props = $props();
    let side = $derived(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (props.view.leaf.getRoot() as any).side == "left" ? "right" : "left"
    );

    function hover(event: MouseEvent) {
        //Don't show previews of config- or hidden files.
        if (
            props.view.app.vault.getAbstractFileByPath(props.change.vaultPath)
        ) {
            hoverPreview(
                props.view.app,
                event,
                props.view,
                props.change.vaultPath
            );
        }
    }

    function open(event: MouseEvent) {
        event.stopPropagation();
        const file = props.view.app.vault.getAbstractFileByPath(
            props.change.vaultPath
        );
        if (file instanceof TFile) {
            getNewLeaf(props.view.app, event)
                ?.openFile(file)
                ?.catch((e: unknown) => props.view.plugin.displayError(e));
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<main
    onmouseover={hover}
    onclick={open}
    onauxclick={(event) => {
        event.stopPropagation();
        if (event.button == 2)
            mayTriggerFileMenu(
                props.view.app,
                event,
                props.change.vaultPath,
                props.view.leaf,
                "git-source-control"
            );
        else open(event);
    }}
    class="tree-item nav-file"
>
    <div
        class="tree-item-self is-clickable nav-file-title"
        data-path={props.change.vaultPath}
        data-tooltip-position={side}
        aria-label={props.change.vaultPath}
    >
        <div class="tree-item-inner nav-file-title-content">
            {getDisplayPath(props.change.vaultPath)}
        </div>
        <div class="git-tools">
            <span class="type" data-type={props.change.workingDir}
                >{props.change.workingDir}</span
            >
        </div>
    </div>
</main>
