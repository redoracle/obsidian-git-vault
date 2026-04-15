import { Modal, setIcon } from "obsidian";
import type ObsidianGit from "src/main";

export type ApiRemoteAction =
    | "import-current-vault"
    | "import-dedicated-vault"
    | "open-existing-vault"
    | "open-and-update-existing-vault"
    | "update-current-vault"
    | "forget-encryption-binding"
    | "cancel";

export type ApiRemoteActionOption = {
    action: ApiRemoteAction;
    label: string;
    description: string;
    cta?: boolean;
};

export class ApiRemoteActionModal extends Modal {
    private resolveResult: ((value: ApiRemoteAction) => void) | null = null;
    private settled = false;

    constructor(
        plugin: ObsidianGit,
        private readonly title: string,
        private readonly description: string,
        private readonly options: ApiRemoteActionOption[]
    ) {
        super(plugin.app);
    }

    openAndGetResult(): Promise<ApiRemoteAction> {
        return new Promise<ApiRemoteAction>((resolve) => {
            this.resolveResult = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.titleEl.setText(this.title);
        this.contentEl.empty();
        this.contentEl.addClass("git-vault-remote-action-modal");

        this.contentEl.createEl("p", {
            cls: "git-vault-remote-action-modal__intro",
            text: this.description,
        });

        const actionsEl = this.contentEl.createDiv(
            "git-vault-remote-action-modal__actions"
        );

        const iconMap: Partial<Record<ApiRemoteAction, string>> = {
            "import-current-vault": "download",
            "import-dedicated-vault": "folder-down",
            "open-existing-vault": "vault",
            "open-and-update-existing-vault": "refresh-ccw",
            "update-current-vault": "refresh-ccw",
            "forget-encryption-binding": "shield-off",
            cancel: "x-circle",
        };

        for (const option of this.options) {
            const isCancel = option.action === "cancel";
            const wrapper = actionsEl.createDiv(
                `git-vault-remote-action-modal__action${isCancel ? " git-vault-remote-action-modal__action--cancel" : ""}`
            );

            const iconEl = wrapper.createDiv(
                "git-vault-remote-action-modal__action-icon"
            );
            const iconName = iconMap[option.action] ?? "arrow-right";
            setIcon(iconEl, iconName);

            const textEl = wrapper.createDiv(
                "git-vault-remote-action-modal__action-text"
            );
            textEl.createDiv({
                cls: "git-vault-remote-action-modal__action-label",
                text: option.label,
            });
            textEl.createDiv({
                cls: "git-vault-remote-action-modal__action-desc",
                text: option.description,
            });

            const btnCls = [
                "git-vault-remote-action-modal__action-btn",
                option.cta ? "mod-cta" : isCancel ? "mod-muted" : "",
            ]
                .filter(Boolean)
                .join(" ");
            const button = wrapper.createEl("button", {
                text: option.label,
                cls: btnCls,
            });
            button.dataset.syncProAction = option.action;
            button.addEventListener("click", () => {
                this.finish(option.action);
                this.close();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        this.finish("cancel");
    }

    private finish(action: ApiRemoteAction): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.resolveResult?.(action);
    }
}
