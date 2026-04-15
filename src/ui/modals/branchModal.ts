import { FuzzySuggestModal } from "obsidian";
import type { App } from "obsidian";

interface IBranchModalHost {
    app: App;
}

export class BranchModal extends FuzzySuggestModal<string> {
    resolve!: (
        value: string | undefined | PromiseLike<string | undefined>
    ) => void;

    constructor(
        plugin: IBranchModalHost,
        private readonly branches: string[]
    ) {
        super(plugin.app);
        this.setPlaceholder("Select branch to checkout");
    }

    onOpen(): void {
        void super.onOpen();
        this.modalEl.setAttribute("data-git-vault-branch-modal", "true");
        this.modalEl.setAttribute("data-git-vault-modal-kind", "branch-picker");
    }

    getItems(): string[] {
        return this.branches;
    }
    getItemText(item: string): string {
        return item;
    }
    onChooseItem(item: string, _: MouseEvent | KeyboardEvent): void {
        this.resolve(item);
    }

    openAndGetResult(): Promise<string | undefined> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    /**
     * @deprecated Use `openAndGetResult()` instead.
     * Legacy wrapper kept for callers that still use the misspelled method name.
     */
    openAndGetReslt(): Promise<string | undefined> {
        return this.openAndGetResult();
    }

    onClose() {
        //onClose gets called before onChooseItem
        void new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
            if (this.resolve) this.resolve(undefined);
        });
    }
}
