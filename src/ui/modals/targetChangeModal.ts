import { Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import type {
    TargetChangeAction,
    TargetChangeDetection,
    TargetChangeValidation,
} from "../../setting/controller/targetChangeController";

interface TargetChangeModalOption {
    action: TargetChangeAction;
    label: string;
    description: string;
    cta?: boolean;
}

/**
 * Confirmation modal shown when the user changes the sync target (repo/branch)
 * while the vault is already linked to a provider.
 *
 * Displays warnings about uncommitted changes, conflicts, and mobile bandwidth
 * concerns, and lets the user choose between switching, cloning a dedicated
 * vault, creating a submodule, or cancelling.
 */
export class TargetChangeModal extends Modal {
    private resolveResult: ((value: TargetChangeAction) => void) | null = null;
    private settled = false;

    constructor(
        app: App,
        private readonly detection: TargetChangeDetection,
        private readonly validation: TargetChangeValidation,
        private readonly availableActions: TargetChangeAction[]
    ) {
        super(app);
    }

    openAndGetResult(): Promise<TargetChangeAction> {
        return new Promise<TargetChangeAction>((resolve) => {
            this.resolveResult = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.titleEl.setText("Change sync target");
        this.contentEl.empty();
        this.contentEl.addClass(
            "git-vault-target-change-modal",
            "git-vault-remote-action-modal"
        );

        const changeLabel =
            this.detection.repoChanged && this.detection.branchChanged
                ? "Repository and branch changed"
                : this.detection.repoChanged
                  ? "Repository changed"
                  : "Branch changed";

        this.contentEl.createEl("p", {
            cls: "git-vault-target-change-modal__change-label git-vault-remote-action-modal__intro",
            text: changeLabel,
        });

        if (this.validation.warnings.length > 0) {
            for (const warning of this.validation.warnings) {
                this.contentEl.createEl("p", {
                    cls: "git-vault-target-change-modal__warning git-vault-remote-action-modal__intro",
                    text: warning,
                });
            }
        }

        if (this.validation.blockers.length > 0) {
            for (const blocker of this.validation.blockers) {
                this.contentEl.createEl("p", {
                    cls: "git-vault-target-change-modal__blocker git-vault-remote-action-modal__intro",
                    text: blocker,
                });
            }
        }

        const actionsEl = this.contentEl.createDiv(
            "git-vault-remote-action-modal__actions"
        );

        const options = this.buildOptions();
        const iconMap: Record<string, string> = {
            cancel: "x-circle",
            "switch-vault": "refresh-ccw",
            "clone-dedicated-vault": "folder-down",
            "create-submodule": "git-branch",
        };

        for (const option of options) {
            const isCancel = option.action === "cancel";
            const wrapper = actionsEl.createDiv(
                `git-vault-remote-action-modal__action${isCancel ? " git-vault-remote-action-modal__action--cancel" : ""}`
            );

            const iconEl = wrapper.createDiv(
                "git-vault-remote-action-modal__action-icon"
            );
            setIcon(iconEl, iconMap[option.action] ?? "arrow-right");

            const textEl = wrapper.createDiv(
                "git-vault-remote-action-modal__action-text"
            );
            textEl.createDiv({
                cls: "git-vault-remote-action-modal__action-label",
                text: option.label,
            });
            textEl.createDiv({
                text: option.description,
                cls: "git-vault-remote-action-modal__action-desc",
            });

            const handleAction = () => {
                if (this.settled) return;
                this.settle(option.action, true);
            };

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
            button.addEventListener("click", () => {
                handleAction();
                this.close();
            });
        }
    }

    onClose(): void {
        // Auto-settle as cancel if the user dismisses the modal;
        // skip close() since Obsidian already called it.
        this.settle("cancel", true);
    }

    private settle(action: TargetChangeAction, skipClose = false): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveResult?.(action);
        if (!skipClose) {
            this.close();
        }
    }

    private buildOptions(): TargetChangeModalOption[] {
        const options: TargetChangeModalOption[] = [];

        const canSwitch = this.validation.canProceed;

        if (canSwitch && this.availableActions.includes("switch-vault")) {
            options.push({
                action: "switch-vault",
                label: "Switch target",
                description:
                    "Switch this vault to the new repository/branch and re-download remote contents.",
                cta: true,
            });
        }

        if (this.availableActions.includes("clone-dedicated-vault")) {
            options.push({
                action: "clone-dedicated-vault",
                label: "Clone as dedicated vault",
                description:
                    "Create a new local vault from the selected repository. This vault keeps its current target unchanged.",
            });
        }

        if (this.availableActions.includes("create-submodule")) {
            options.push({
                action: "create-submodule",
                label: "Create submodule",
                description:
                    "Add the new repository as a submodule inside this vault so both can coexist.",
            });
        }

        if (this.availableActions.includes("cancel")) {
            options.push({
                action: "cancel",
                label: "Cancel",
                description: "Keep the current target unchanged.",
            });
        }

        // Ensure the modal always has at least one option
        if (options.length === 0) {
            options.push({
                action: "cancel",
                label: "Cancel",
                description: "Keep the current target unchanged.",
            });
        }

        return options;
    }
}
