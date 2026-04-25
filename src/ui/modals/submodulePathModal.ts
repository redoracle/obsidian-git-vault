import { Modal } from "obsidian";
import type { App } from "obsidian";

/**
 * Modal shown when the user chooses "Create submodule" in the target change
 * confirmation flow.  Asks for the directory path inside the vault where the
 * submodule should be placed, defaulting to a sanitised repo-name folder.
 */
export class SubmodulePathModal extends Modal {
    private resolveResult: ((value: string | null) => void) | null = null;
    private settled = false;

    constructor(
        app: App,
        private readonly repoSuggestion: string
    ) {
        super(app);
    }

    openAndGetResult(): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            this.resolveResult = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.titleEl.setText("Add git submodule");
        this.contentEl.empty();
        this.contentEl.addClass("git-vault-submodule-path-modal");

        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: `Add "${this.repoSuggestion}" as a git submodule inside this vault. Choose the target directory (relative to the vault root).`,
        });

        const inputWrapper = this.contentEl.createDiv(
            "git-vault-submodule-path-modal__input-wrapper"
        );
        const input = inputWrapper.createEl("input", {
            type: "text",
            placeholder: this.repoSuggestion,
            value: this.repoSuggestion,
            cls: "git-vault-submodule-path-modal__input",
        });
        input.style.width = "100%";

        const actionsEl = this.contentEl.createDiv(
            "git-vault-submodule-path-modal__actions"
        );

        const submitBtn = actionsEl.createDiv(
            "git-vault-submodule-path-modal__action git-vault-submodule-path-modal__action--cta"
        );
        submitBtn.setAttribute("role", "button");
        submitBtn.setAttribute("tabindex", "0");
        submitBtn.createSpan({ text: "Add submodule", cls: "mod-bold" });

        const cancelBtn = actionsEl.createDiv(
            "git-vault-submodule-path-modal__action git-vault-submodule-path-modal__action--cancel"
        );
        cancelBtn.setAttribute("role", "button");
        cancelBtn.setAttribute("tabindex", "0");
        cancelBtn.createSpan({ text: "Cancel", cls: "mod-bold" });

        const submit = () => {
            if (this.settled) return;
            const value = input.value.trim();
            if (!value) {
                this.settle(null);
                return;
            }
            this.settle(value);
        };

        submitBtn.addEventListener("click", submit);
        submitBtn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                submit();
            }
        });

        cancelBtn.addEventListener("click", () => this.settle(null));
        cancelBtn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.settle(null);
            }
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                submit();
            }
        });

        // Focus the input on open
        setTimeout(() => input.focus(), 50);
    }

    onClose(): void {
        this.settle(null, true);
    }

    private settle(value: string | null, skipClose = false): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveResult?.(value);
        if (!skipClose) {
            this.close();
        }
    }
}
