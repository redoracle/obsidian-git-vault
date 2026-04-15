import { Setting } from "obsidian";
import { normalizeTrackedDirectory } from "src/syncProvider/pathScope";
import type ObsidianGit from "src/main";
import { wireSecureFieldReveal } from "./secureFieldReveal";
import { renderProviderSectionFrame } from "./providerSectionFrame";

export function renderApiProviderSection({
    containerEl,
    plugin,
    runApiRemoteTargetWorkflow,
    markSyncBaselineRequired,
    reloadSyncManager,
    refreshDisplayWithDelay,
    validateEncryptionPassphraseForCurrentRepo,
    persistAndReloadSyncAndRedraw,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    runApiRemoteTargetWorkflow: () => Promise<void>;
    markSyncBaselineRequired: () => Promise<void>;
    reloadSyncManager: () => Promise<void>;
    refreshDisplayWithDelay: () => void;
    validateEncryptionPassphraseForCurrentRepo: (
        passphrase: string,
        options?: { treatAsEnabled?: boolean }
    ) => Promise<string | null>;
    persistAndReloadSyncAndRedraw: () => Promise<void>;
}): void {
    let passphraseInputEl: HTMLInputElement | undefined;

    const sections = [
        {
            name: "API sync scope",
            desc: "Limit which part of the vault is synced and which paths should stay local.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Tracked directory")
                    .setDesc(
                        "Optional vault-relative folder to sync in API mode. Its contents map to the remote repository root; everything outside stays local."
                    )
                    .addText((t) => {
                        t.setValue(plugin.settings.trackedDirectory ?? "");
                        t.setPlaceholder("folder/subfolder");
                        t.onChange(async (v) => {
                            const trackedDirectory =
                                normalizeTrackedDirectory(v);
                            const previousTrackedDirectory =
                                plugin.settings.trackedDirectory ?? "";
                            plugin.settings.trackedDirectory = trackedDirectory;
                            if (v !== trackedDirectory) {
                                t.setValue(trackedDirectory);
                            }

                            if (previousTrackedDirectory !== trackedDirectory) {
                                await markSyncBaselineRequired();
                            } else {
                                await plugin.saveSettings();
                            }

                            await reloadSyncManager();
                            refreshDisplayWithDelay();
                        });
                    });

                new Setting(containerEl)
                    .setName("Excluded paths")
                    .setDesc(
                        "One .gitignore-style rule per line. Rules are applied after tracked-directory scoping and only affect API backends."
                    )
                    .addTextArea((ta) => {
                        ta.setValue(
                            (plugin.settings.syncExcludePaths ?? []).join("\n")
                        );
                        ta.inputEl.rows = 6;
                        ta.onChange(async (v) => {
                            const previousExcludePatterns = JSON.stringify(
                                plugin.settings.syncExcludePaths ?? []
                            );
                            plugin.settings.syncExcludePaths = v
                                .split("\n")
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0);
                            const nextExcludePatterns = JSON.stringify(
                                plugin.settings.syncExcludePaths
                            );
                            if (
                                previousExcludePatterns !== nextExcludePatterns
                            ) {
                                await markSyncBaselineRequired();
                            } else {
                                await plugin.saveSettings();
                            }
                            await reloadSyncManager();
                            refreshDisplayWithDelay();
                        });
                    });
            },
        },
        {
            name: "Security",
            desc: "Control encryption of API sync contents and the local passphrase used for decryption.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Encrypt synced file contents")
                    .setDesc(
                        "Automatically encrypt each synced file's content with AES-256-GCM before upload and decrypt it on download. This applies to the entire synced scope; selective encryption by extension or filename is not currently supported. File and folder names remain visible on the remote so the repository tree stays navigable. This is separate from the per-file Encrypt/Decrypt file-menu actions, which modify local vault files directly."
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(plugin.settings.apiEncryptionEnabled)
                            .onChange(async (value) => {
                                if (value) {
                                    const passphrase =
                                        plugin.providerSecrets.getEncryptionPassphrase();
                                    if (!passphrase) {
                                        plugin.showNotice(
                                            "Git Vault: Set an encryption passphrase below before enabling encryption.",
                                            6000
                                        );
                                        toggle.setValue(false);
                                        return;
                                    }
                                    const validationError =
                                        await validateEncryptionPassphraseForCurrentRepo(
                                            passphrase,
                                            { treatAsEnabled: true }
                                        );
                                    if (validationError) {
                                        plugin.showNotice(
                                            validationError,
                                            8000
                                        );
                                        toggle.setValue(false);
                                        return;
                                    }
                                }
                                plugin.settings.apiEncryptionEnabled = value;
                                await persistAndReloadSyncAndRedraw();
                                void updatePassphraseHint();
                            })
                    );

                const _passphraseSetting = new Setting(sectionContainerEl)
                    .setName("Encryption passphrase")
                    .setDesc(
                        "Stored in Obsidian secret storage on this device only. Devices that should decrypt the same remote need the same passphrase. Automatic passphrase rotation for an already-encrypted repo is not supported."
                    )
                    .addText((t) => {
                        passphraseInputEl = t.inputEl;
                        t.inputEl.type = "password";
                        t.setValue(
                            plugin.providerSecrets.getEncryptionPassphrase() ??
                                ""
                        );
                        let passphraseValidationTimer: number | undefined;
                        let passphraseValidationSequence = 0;
                        t.onChange((v) => {
                            const nextPassphrase = v.trim();
                            const validationSequence =
                                ++passphraseValidationSequence;
                            if (passphraseValidationTimer !== undefined) {
                                window.clearTimeout(passphraseValidationTimer);
                            }

                            passphraseValidationTimer = window.setTimeout(
                                () => {
                                    void (async () => {
                                        if (
                                            validationSequence !==
                                            passphraseValidationSequence
                                        ) {
                                            return;
                                        }

                                        const validationError =
                                            await validateEncryptionPassphraseForCurrentRepo(
                                                nextPassphrase
                                            );

                                        if (
                                            validationSequence !==
                                            passphraseValidationSequence
                                        ) {
                                            return;
                                        }

                                        if (validationError) {
                                            plugin.showNotice(
                                                validationError,
                                                8000
                                            );
                                            t.setValue(
                                                plugin.providerSecrets.getEncryptionPassphrase() ??
                                                    ""
                                            );
                                            return;
                                        }

                                        plugin.providerSecrets.setEncryptionPassphrase(
                                            nextPassphrase || null
                                        );
                                        void updatePassphraseHint();
                                    })();
                                },
                                300
                            );
                        });
                    })
                    .addExtraButton((button) => {
                        if (passphraseInputEl) {
                            wireSecureFieldReveal(button, {
                                inputEl: passphraseInputEl,
                            });
                        }
                    });

                // A subtle hint element shown when provider-level encryption is
                // enabled but the current passphrase is missing or mismatched.
                const passphraseHint = sectionContainerEl.createEl("div", {
                    cls: "git-vault-passphrase-hint",
                });

                async function updatePassphraseHint() {
                    try {
                        const current =
                            plugin.providerSecrets.getEncryptionPassphrase() ??
                            (passphraseInputEl ? passphraseInputEl.value : "");
                        const validation =
                            await validateEncryptionPassphraseForCurrentRepo(
                                current
                            );
                        if (
                            plugin.settings.apiEncryptionEnabled &&
                            validation
                        ) {
                            const lower = validation.toLowerCase();
                            if (lower.includes("cannot clear")) {
                                passphraseHint.textContent =
                                    "Passphrase required";
                            } else if (
                                lower.includes(
                                    "different encryption passphrase"
                                ) ||
                                lower.includes("previously synced") ||
                                lower.includes("different passphrase")
                            ) {
                                passphraseHint.textContent =
                                    "Passphrase mismatched";
                            } else {
                                passphraseHint.textContent = validation;
                            }
                            // Visual styles come from the `.git-vault-passphrase-hint`
                            // CSS class; avoid setting inline styles so hiding the
                            // element returns it to stylesheet-controlled appearance.
                        } else {
                            passphraseHint.textContent = "";
                        }
                    } catch (err) {
                        console.error("failed to update hint:", err);
                    }
                }

                // Initial render
                void updatePassphraseHint();
            },
        },
        {
            name: "Remote actions & recovery",
            desc: "Use the selected remote, import it into this vault, or recover from a deliberate remote reset.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Use selected remote")
                    .setDesc(
                        "Open the unified remote-actions flow for the selected target. It covers first-time import, dedicated-vault download, reusing an already known local vault, updating the currently linked vault, and recovery actions for deliberate remote resets."
                    )
                    .addButton((button) =>
                        button
                            .setButtonText("Choose action")
                            .setCta()
                            .onClick(async () => {
                                await runApiRemoteTargetWorkflow();
                            })
                    );
            },
        },
    ];

    renderProviderSectionFrame(containerEl, "API sync", sections);
}
