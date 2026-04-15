<script lang="ts">
    import { setIcon, TFile } from "obsidian";
    import { hoverPreview } from "src/utils";
    import type { GitManager } from "src/gitManager/gitManager";
    import type { FileStatusResult } from "src/types";
    import {
        fileIsBinary,
        fileOpenableInObsidian,
        getDisplayPath,
        getNewLeaf,
        mayTriggerFileMenu,
    } from "src/utils";
    import type GitView from "../sourceControl";

    interface Props {
        change: FileStatusResult;
        view: GitView;
        manager: GitManager;
    }

    let props: Props = $props();
    let buttons: HTMLElement[] = $state([]);
    let side = $derived(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (props.view.leaf.getRoot() as any).side == "left" ? "right" : "left"
    );

    $effect(() => {
        for (const b of buttons) if (b) setIcon(b, b.getAttr("data-icon")!);
    });

    function mainClick(event: MouseEvent) {
        event.stopPropagation();
        if (fileIsBinary(props.change.path)) {
            open(event);
        } else {
            showDiff(event);
        }
    }

    function hover(event: MouseEvent) {
        //Don't show previews of config- or hidden files.
        if (props.view.app.vault.getFileByPath(props.change.vaultPath)) {
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
                .catch((e: unknown) => props.view.plugin.displayError(e));
        }
    }

    function showDiff(event: MouseEvent) {
        event.stopPropagation();
        props.view.plugin.tools.openDiff({
            aFile: props.change.from ?? props.change.path,
            bFile: props.change.path,
            aRef: "HEAD",
            bRef: "",
            event,
        });
    }

    function unstage(event: MouseEvent) {
        event.stopPropagation();

        props.manager
            .unstage(props.change.path, false)
            .catch((e: unknown) => props.view.plugin.displayError(e))
            .finally(() => {
                props.view.app.workspace.trigger("obsidian-git:refresh");
            });
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<main
    onmouseover={hover}
    onclick={mainClick}
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
        else mainClick(event);
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
            <div class="buttons">
                {#if fileOpenableInObsidian(props.change.vaultPath, props.view.app)}
                    <div
                        data-icon="go-to-file"
                        aria-label="Open File"
                        bind:this={buttons[0]}
                        onclick={open}
                        class="clickable-icon"
                    ></div>
                {/if}
                <div
                    data-icon="minus"
                    aria-label="Unstage"
                    bind:this={buttons[1]}
                    onclick={unstage}
                    class="clickable-icon"
                ></div>
            </div>
            <div class="type" data-type={props.change.index}>
                {props.change.index}
            </div>
        </div>
    </div>
</main>
