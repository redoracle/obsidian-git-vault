import type { WorkspaceLeaf } from "obsidian";
import {
    DIFF_VIEW_CONFIG,
    HISTORY_VIEW_CONFIG,
    SOURCE_CONTROL_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "src/constants";
import type {
    IWorkspaceSelectionSync,
    IWorkspaceSelectionSyncHost,
} from "./runtimeServices";

export class WorkspaceSelectionSync implements IWorkspaceSelectionSync {
    constructor(private readonly host: IWorkspaceSelectionSyncHost) {}

    private getDiffPath(
        state: Record<string, unknown> | undefined
    ): string | undefined {
        const path = state?.bFile;
        return typeof path === "string" ? path : undefined;
    }

    private getDiffRef(
        state: Record<string, unknown> | undefined
    ): string | undefined {
        const ref = state?.aRef;
        return typeof ref === "string" ? ref : undefined;
    }

    private getViewType(
        view: WorkspaceLeaf["view"] | null | undefined
    ): string | undefined {
        return typeof view?.getViewType === "function"
            ? view.getViewType()
            : undefined;
    }

    private isDiffView(
        view: WorkspaceLeaf["view"] | null | undefined
    ): boolean {
        const viewType = this.getViewType(view);
        return (
            viewType === DIFF_VIEW_CONFIG.type ||
            viewType === SPLIT_DIFF_VIEW_CONFIG.type
        );
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        const view = leaf?.view;
        if (!view?.getState?.()?.file && !this.isDiffView(view)) {
            return;
        }

        const sourceControlLeaf = this.host.app.workspace
            .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
            .first();
        const historyLeaf = this.host.app.workspace
            .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
            .first();

        sourceControlLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");
        historyLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");

        if (leaf?.view && this.isDiffView(leaf.view)) {
            const viewState = leaf.view.getState();
            const path = this.getDiffPath(viewState);
            if (!path) {
                this.host.setLastDiffViewState(undefined);
                return;
            }
            const diffRef = this.getDiffRef(viewState);
            const escapedPath = path.replace(/["\\]/g, "\\$&");
            this.host.setLastDiffViewState(viewState);
            let el: Element | undefined | null;
            if (sourceControlLeaf && diffRef === "HEAD") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.staged div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (sourceControlLeaf && diffRef === "") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.changes div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (historyLeaf) {
                el = historyLeaf.view.containerEl.querySelector(
                    `div.tree-item-self[data-path="${escapedPath}"]`
                );
            }
            el?.addClass("is-active");
        } else {
            this.host.setLastDiffViewState(undefined);
        }
    }
}
