import { Modal, setIcon } from "obsidian";
import type { App } from "obsidian";

export class SetupProgressModal extends Modal {
    private statusEl!: HTMLParagraphElement;
    private spinnerEl!: HTMLDivElement;

    constructor(
        app: App,
        private readonly titleText: string
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("git-vault-setup-modal");
        this.setTitle(this.titleText);

        const bodyEl = this.contentEl.createDiv({
            cls: "git-vault-setup-modal-body",
        });
        this.spinnerEl = bodyEl.createDiv({
            cls: "git-vault-setup-spinner is-spinning",
        });
        setIcon(this.spinnerEl, "loader-circle");
        this.statusEl = bodyEl.createEl("p", {
            cls: "git-vault-setup-status",
            text: "Preparing setup…",
        });
    }

    setStatus(message: string): void {
        this.statusEl?.setText(message);
    }

    markFailed(message: string): void {
        this.statusEl?.setText(message);
        this.spinnerEl?.removeClass("is-spinning");
        this.spinnerEl?.addClass("is-failed");
        if (this.spinnerEl) {
            this.spinnerEl.empty();
            setIcon(this.spinnerEl, "alert-triangle");
        }
    }

    onClose(): void {
        this.contentEl.empty();
        this.modalEl.removeClass("git-vault-setup-modal");
    }
}
