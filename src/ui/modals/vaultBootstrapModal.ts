import { Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";

interface IVaultSuccessOptions {
    mode: "success";
    vaultPath: string;
    registeredInSwitcher: boolean;
    onOpenVault: () => void;
}

interface IVaultManualOptions {
    mode: "manual-registration";
    vaultPath: string;
}

interface IVaultOnboardingOptions {
    mode: "onboarding";
    providerLabel: string;
    onOpenSettings: () => void;
}

type VaultBootstrapModalOptions =
    | IVaultSuccessOptions
    | IVaultManualOptions
    | IVaultOnboardingOptions;

export class VaultBootstrapModal extends Modal {
    constructor(
        app: App,
        private readonly options: VaultBootstrapModalOptions
    ) {
        super(app);
    }

    private async copyVaultPathToClipboard(vaultPath: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(vaultPath);
            new Notice("Vault path copied to clipboard.", 4000);
        } catch (error) {
            console.error("Failed to copy vault path:", error);
            new Notice("Unable to copy the vault path on this device.", 5000);
        }
    }

    onOpen(): void {
        this.modalEl.addClass("git-vault-bootstrap-modal");

        switch (this.options.mode) {
            case "success":
                this.renderSuccess();
                return;
            case "manual-registration":
                this.renderManualRegistration();
                return;
            case "onboarding":
                this.renderOnboarding();
                return;
            default: {
                const unexpectedOptions: never = this.options;
                throw new Error(
                    `Unexpected vault bootstrap modal mode: ${String(unexpectedOptions)}`
                );
            }
        }
    }

    onClose(): void {
        this.contentEl.empty();
        this.modalEl.removeClass("git-vault-bootstrap-modal");
    }

    private renderSuccess(): void {
        const { vaultPath, registeredInSwitcher, onOpenVault } = this
            .options as IVaultSuccessOptions;
        this.setTitle("Dedicated vault ready");
        this.contentEl.createEl("p", {
            text: registeredInSwitcher
                ? 'The remote was cloned into a dedicated vault, Git Vault was installed, and the vault was registered in Obsidian\'s switcher. If Obsidian reports "Vault not found", it may not have loaded the new entry yet - open it manually from the vault switcher instead.'
                : "The remote was cloned into a dedicated vault and Git Vault was installed. Obsidian registration is not available in this runtime, so open the vault manually if needed.",
        });
        this.contentEl.createEl("p", {
            cls: "git-vault-bootstrap-path",
            text: vaultPath,
        });

        new Setting(this.contentEl)
            .addButton((button) => {
                if (!registeredInSwitcher) {
                    return button
                        .setButtonText("Close")
                        .onClick(() => this.close());
                }
                return button
                    .setButtonText("Open Vault Now")
                    .setCta()
                    .onClick(() => {
                        onOpenVault();
                        this.close();
                    });
            })
            .addButton((button) =>
                button
                    .setButtonText("Copy path")
                    .onClick(() => this.copyVaultPathToClipboard(vaultPath))
            )
            .addButton((button) =>
                button.setButtonText("Close").onClick(() => this.close())
            );
    }

    private renderManualRegistration(): void {
        const { vaultPath } = this.options as IVaultManualOptions;
        this.setTitle("Register the new vault manually");
        this.contentEl.createEl("p", {
            text: "The clone completed, but mobile Obsidian does not expose the global vault registry for plugins. Register this vault from the app's vault switcher.",
        });
        const listEl = this.contentEl.createEl("ol", {
            cls: "git-vault-bootstrap-steps",
        });
        [
            "Close the current vault if you are done here.",
            "Open the Obsidian vault switcher.",
            "Choose 'Open folder as vault' or the platform-equivalent action.",
            "Select the cloned vault path shown below.",
            "Enable Git Vault if Obsidian asks to trust or enable community plugins.",
        ].forEach((step) => listEl.createEl("li", { text: step }));
        this.contentEl.createEl("p", {
            cls: "git-vault-bootstrap-path",
            text: vaultPath,
        });

        new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Copy path")
                    .setCta()
                    .onClick(() => this.copyVaultPathToClipboard(vaultPath))
            )
            .addButton((button) =>
                button.setButtonText("Close").onClick(() => this.close())
            );
    }

    private renderOnboarding(): void {
        const { providerLabel, onOpenSettings } = this
            .options as IVaultOnboardingOptions;
        this.setTitle("Complete secure setup");
        this.contentEl.createEl("p", {
            text: `Git Vault was installed into this cloned vault with safe defaults. ${providerLabel} credentials were intentionally not copied to this device, and encrypted remotes only work after this device is given the same passphrase as the source device.`,
        });
        this.contentEl.createEl("p", {
            text: "Important: importing or cloning an encrypted remote requires the source device to already know the passphrase so it can decrypt remote content during export. The destination vault still starts without any stored secrets.",
        });
        const listEl = this.contentEl.createEl("ol", {
            cls: "git-vault-bootstrap-steps",
        });
        [
            "Open the Git Vault settings tab.",
            "Enter the token or credentials for this device only.",
            "If the remote uses encryption, enter the exact same passphrase used on the source device.",
            "Run the normal sync action once to verify access.",
        ].forEach((step) => listEl.createEl("li", { text: step }));

        new Setting(this.contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Open Git Vault settings")
                    .setCta()
                    .onClick(() => {
                        onOpenSettings();
                        this.close();
                    })
            )
            .addButton((button) =>
                button.setButtonText("Later").onClick(() => this.close())
            );
    }
}
