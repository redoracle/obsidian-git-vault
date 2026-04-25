import {
    Setting,
    type DropdownComponent,
    type TextComponent,
    type ExtraButtonComponent,
} from "obsidian";
import type { GiteaProviderSectionContext } from "../renderContext";
import { preserveCurrentDropdownOption } from "../../settingsHelpers";
import { wireSecureFieldReveal } from "./secureFieldReveal";
import { renderProviderSectionFrame } from "./providerSectionFrame";
import { styleSettingsRefreshButton } from "./settingsRefreshButton";

const initialRepoRefreshContainers = new WeakSet<HTMLElement>();

export function renderGiteaProviderSection({
    containerEl,
    settings,
    getToken,
    setToken,
    persistAndReloadSync,
    runApiRemoteTargetWorkflow,
    reloadSyncManager,
    isVaultLinked,
    confirmTargetChange,
    requestUser,
    fetchRepos,
    fetchBranches,
    createRepo,
    setDropdownOptions,
    showNotice,
}: GiteaProviderSectionContext): void {
    let repoDropdown: DropdownComponent | undefined;
    let branchDropdown: DropdownComponent | undefined;
    let dropdownLoadSeq = 0;
    let giteaTokenComponent: TextComponent | undefined;
    let ownerDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    let baseUrlDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    let tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let isDisposed = false;
    // ── Draft state ─────────────────────────────────────────────────────────
    let draftRepo: string | null = null;
    let draftBranch: string | null = null;
    let applySettingEl: HTMLElement | undefined = undefined;

    const isDraftDirty = (): boolean =>
        (draftRepo !== null && draftRepo !== (settings.giteaRepo ?? "")) ||
        (draftBranch !== null && draftBranch !== (settings.giteaBranch ?? ""));

    const effectiveRepo = (): string =>
        draftRepo !== null ? draftRepo : settings.giteaRepo ?? "";
    const effectiveBranch = (): string =>
        draftBranch !== null ? draftBranch : settings.giteaBranch ?? "";

    const revertDraft = (): void => {
        draftRepo = null;
        draftBranch = null;
        if (repoDropdown) repoDropdown.setValue(settings.giteaRepo ?? "");
        if (branchDropdown) branchDropdown.setValue(settings.giteaBranch ?? "");
        updateApplyButton();
    };

    const updateApplyButton = (): void => {
        if (!applySettingEl) return;
        applySettingEl.style.display = isDraftDirty() ? "" : "none";
    };

    const persistNormalizedTarget = async (
        nextRepo: string,
        nextBranch: string
    ): Promise<void> => {
        if (isDraftDirty()) return;
        const repoChanged = (settings.giteaRepo ?? "") !== nextRepo;
        const branchChanged = (settings.giteaBranch ?? "") !== nextBranch;
        settings.giteaRepo = nextRepo;
        settings.giteaBranch = nextBranch;
        if (repoChanged || branchChanged) {
            await persistAndReloadSync();
        }
    };

    const dispose = (): void => {
        isDisposed = true;
        clearTimeout(ownerDebounceTimer);
        ownerDebounceTimer = undefined;
        clearTimeout(baseUrlDebounceTimer);
        baseUrlDebounceTimer = undefined;
        clearTimeout(tokenRefreshTimer);
        tokenRefreshTimer = undefined;
    };

    /**
     * Refreshes Gitea branches for the current owner/repo.
     * Returns `undefined` for a stale/no-op call, `null` when fetchBranches
     * fails, and the branch map on success.
     */
    const refreshBranches = async (): Promise<
        Record<string, string> | null | undefined
    > => {
        if (!branchDropdown) return;
        const activeRepo = effectiveRepo();
        const activeBranch = effectiveBranch();
        const seq = ++dropdownLoadSeq;
        setDropdownOptions(branchDropdown, { "": "Refreshing..." });
        try {
            const branches = await fetchBranches(
                settings.giteaOwner ?? "",
                activeRepo
            );
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(branches, activeBranch),
                activeBranch
            );
            await persistNormalizedTarget(activeRepo, nextBranch);
            return branches;
        } catch (error) {
            if (seq !== dropdownLoadSeq) return;
            setDropdownOptions(branchDropdown, {
                "": `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
            showNotice(
                `Failed to fetch Gitea branches: ${error instanceof Error ? error.message : String(error)}`,
                6000
            );
            return null;
        }
    };

    const refreshReposAndBranches = async () => {
        const activeRepo = effectiveRepo();
        const activeBranch = effectiveBranch();
        const seq = ++dropdownLoadSeq;
        if (repoDropdown) {
            setDropdownOptions(repoDropdown, { "": "Refreshing..." });
        }
        if (branchDropdown) {
            setDropdownOptions(branchDropdown, { "": "Refreshing..." });
        }
        try {
            const repos = await fetchRepos(settings.giteaOwner ?? "");
            if (seq !== dropdownLoadSeq) return;
            const nextRepo = setDropdownOptions(
                repoDropdown,
                preserveCurrentDropdownOption(repos, activeRepo),
                activeRepo
            );
            const branches = await fetchBranches(
                settings.giteaOwner ?? "",
                nextRepo
            );
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(branches, activeBranch),
                activeBranch
            );
            await persistNormalizedTarget(nextRepo, nextBranch);
        } catch (error) {
            if (seq !== dropdownLoadSeq) return;
            setDropdownOptions(repoDropdown, {
                "": `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
            setDropdownOptions(branchDropdown, { "": "No branches found" });
            showNotice(
                `Failed to fetch Gitea repositories/branches: ${error instanceof Error ? error.message : String(error)}`,
                6000
            );
        }
    };

    renderProviderSectionFrame(containerEl, "Gitea / Forgejo API", [
        {
            name: "Connection",
            desc: "Configure the Gitea or Forgejo server this vault should use.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Server URL")
                    .setDesc(
                        "Base URL of your Gitea or Forgejo instance, for example https://git.example.com."
                    )
                    .addText((t) => {
                        t.setValue(settings.giteaBaseUrl);
                        t.setPlaceholder("https://git.example.com");
                        t.onChange((v) => {
                            const normalized = v.trim().replace(/\/+$/, "");
                            t.setValue(normalized);
                            settings.giteaBaseUrl = normalized;
                            clearTimeout(baseUrlDebounceTimer);
                            baseUrlDebounceTimer = setTimeout(() => {
                                if (isDisposed) {
                                    return;
                                }
                                void (async () => {
                                    try {
                                        await persistAndReloadSync();
                                        if (isDisposed) {
                                            return;
                                        }
                                        await refreshReposAndBranches();
                                    } catch (error) {
                                        if (isDisposed) {
                                            return;
                                        }
                                        console.error(
                                            "Failed to reload Gitea sync manager:",
                                            error
                                        );
                                        showNotice(
                                            `Failed to reload Gitea sync manager: ${error instanceof Error ? error.message : String(error)}`,
                                            6000
                                        );
                                    }
                                })();
                            }, 400);
                        });
                    });
                return dispose;
            },
        },
        {
            name: "Authentication",
            desc: "Store the access token used to update the selected repository.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Access token")
                    .setDesc(
                        "Stored in Obsidian secret storage on this device."
                    )
                    .addText((t) => {
                        giteaTokenComponent = t;
                        t.inputEl.type = "password";
                        t.setValue(getToken());
                        t.setPlaceholder("token");
                        t.onChange((v) => {
                            setToken(v.trim() || null);
                            // Debounce the repo/branch refresh so rapid
                            // keystrokes don't spam the API.
                            clearTimeout(tokenRefreshTimer);
                            tokenRefreshTimer = setTimeout(() => {
                                void (async () => {
                                    if (isDisposed) return;
                                    try {
                                        await reloadSyncManager();
                                        if (isDisposed) return;
                                        await refreshReposAndBranches();
                                    } catch (error) {
                                        if (isDisposed) return;
                                        console.error(
                                            "Failed to reload Gitea sync manager:",
                                            error
                                        );
                                        showNotice(
                                            `Failed to reload Gitea sync manager: ${error instanceof Error ? error.message : String(error)}`,
                                            6000
                                        );
                                    }
                                })();
                            }, 400);
                        });
                    })
                    .addExtraButton((button) => {
                        // Defer until giteaTokenComponent is assigned so wireSecureFieldReveal
                        // can bind the button to the rendered input; remove once the
                        // button API can be wired directly from the text callback.
                        queueMicrotask(() => {
                            if (giteaTokenComponent) {
                                wireSecureFieldReveal(
                                    button,
                                    giteaTokenComponent
                                );
                            }
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Token check")
                    .setDesc(
                        "Quickly verify the currently stored Gitea / Forgejo token."
                    )
                    .addButton((b) =>
                        b.setButtonText("Check token").onClick(async () => {
                            const token = getToken();
                            if (!token) {
                                showNotice(
                                    "No Gitea token found. Enter a token first.",
                                    5000
                                );
                                return;
                            }
                            try {
                                const user = await requestUser();
                                if (user && (user.login || user.fullName)) {
                                    showNotice(
                                        `Gitea token valid for ${user.login ?? user.fullName}`,
                                        5000
                                    );
                                } else {
                                    showNotice(
                                        "Gitea token appears invalid or lacks permissions.",
                                        6000
                                    );
                                }
                            } catch (error) {
                                console.error(
                                    "Failed to validate Gitea token:",
                                    error
                                );
                                showNotice(
                                    `Failed to validate Gitea token: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                            }
                        })
                    );
            },
        },
        {
            name: "Repository target",
            desc: "Choose which repository and branch this vault should sync against. This backend is correctness-first and currently applies file changes one by one instead of as one atomic batch.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Owner / namespace")
                    .setDesc(
                        "Account, user, or organisation that owns the repository."
                    )
                    .addText((t) => {
                        t.setValue(settings.giteaOwner);
                        t.setPlaceholder("your-username");
                        t.onChange((v) => {
                            settings.giteaOwner = v.trim();
                            clearTimeout(ownerDebounceTimer);
                            ownerDebounceTimer = setTimeout(() => {
                                if (isDisposed) {
                                    return;
                                }
                                void (async () => {
                                    try {
                                        await persistAndReloadSync();
                                        if (isDisposed) {
                                            return;
                                        }
                                        await refreshReposAndBranches();
                                    } catch (error) {
                                        if (isDisposed) {
                                            return;
                                        }
                                        console.error(
                                            "Failed to update Gitea owner and refresh repositories:",
                                            error
                                        );
                                        showNotice(
                                            `Failed to update Gitea owner: ${error instanceof Error ? error.message : String(error)}`,
                                            6000
                                        );
                                    }
                                })();
                            }, 400);
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Repository")
                    .setDesc("Name of the repository to sync with.")
                    .addDropdown((dd) => {
                        repoDropdown = dd;
                        dd.addOptions({ "": "Loading repositories..." });
                        dd.setValue(settings.giteaRepo ?? "");
                        dd.onChange((v) => {
                            const next = v || "";
                            if (
                                next === (draftRepo ?? settings.giteaRepo ?? "")
                            )
                                return;
                            draftRepo = next;
                            updateApplyButton();
                            void refreshReposAndBranches();
                        });
                    })
                    .addExtraButton((btn: ExtraButtonComponent) => {
                        btn.setIcon("refresh-ccw").setTooltip(
                            "Refresh repositories"
                        );
                        styleSettingsRefreshButton(btn);
                        btn.onClick(() => {
                            void refreshReposAndBranches();
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Branch")
                    .setDesc("Branch to sync against on Gitea / Forgejo.")
                    .addDropdown((dd) => {
                        branchDropdown = dd;
                        dd.addOptions({ "": "Select a repository first" });
                        dd.setValue(settings.giteaBranch ?? "");
                        dd.onChange((v) => {
                            const next = v || "";
                            if (
                                next ===
                                (draftBranch ?? settings.giteaBranch ?? "")
                            )
                                return;
                            draftBranch = next;
                            updateApplyButton();
                        });
                    })
                    .addExtraButton((btn: ExtraButtonComponent) => {
                        btn.setIcon("refresh-ccw").setTooltip(
                            "Refresh branches"
                        );
                        styleSettingsRefreshButton(btn);
                        btn.onClick(() => {
                            void refreshBranches();
                        });
                    });

                // ── Apply button ──────────────────────────────────────────────
                const applySetting = new Setting(sectionContainerEl)
                    .setName("Apply target change")
                    .setDesc(
                        isVaultLinked
                            ? "This will replace the current sync target. A confirmation will be shown."
                            : "Set the selected repository and branch as the sync target."
                    )
                    .addButton((b) => {
                        b.setButtonText("Apply")
                            .setCta()
                            .onClick(async () => {
                                const repo = effectiveRepo();
                                const branch = effectiveBranch();
                                if (!repo || !branch) {
                                    showNotice(
                                        "Select a repository and branch first.",
                                        4000
                                    );
                                    return;
                                }
                                b.setDisabled(true);
                                b.setButtonText("Applying…");
                                try {
                                    const confirmed = await confirmTargetChange(
                                        repo,
                                        branch
                                    );
                                    if (!confirmed) {
                                        revertDraft();
                                        return;
                                    }
                                    settings.giteaRepo = repo;
                                    settings.giteaBranch = branch;
                                    await persistAndReloadSync();
                                    draftRepo = null;
                                    draftBranch = null;
                                    updateApplyButton();
                                    if (
                                        settings.giteaOwner &&
                                        settings.giteaRepo &&
                                        settings.giteaBranch
                                    ) {
                                        await runApiRemoteTargetWorkflow();
                                    }
                                } catch (error) {
                                    showNotice(
                                        `Failed to apply target change: ${error instanceof Error ? error.message : String(error)}`,
                                        6000
                                    );
                                } finally {
                                    b.setButtonText("Apply");
                                    b.setDisabled(false);
                                }
                            });
                    });
                applySettingEl = applySetting.settingEl;
                applySettingEl.style.display = "none";

                if (!initialRepoRefreshContainers.has(containerEl)) {
                    initialRepoRefreshContainers.add(containerEl);
                    void refreshReposAndBranches();
                }
            },
        },
        {
            name: "Create private repository",
            desc: "Create a new private repository on this Gitea / Forgejo server, then upload this vault to it.",
            render: (sectionContainerEl: HTMLElement) => {
                let newRepoNameInput: TextComponent | undefined;

                new Setting(sectionContainerEl)
                    .setName("New repository name")
                    .setDesc(
                        "Name for the private repository to create under your account."
                    )
                    .addText((t) => {
                        newRepoNameInput = t;
                        t.setPlaceholder(settings.giteaRepo || "my-vault");
                    });

                new Setting(sectionContainerEl)
                    .setName("Create and upload vault")
                    .setDesc(
                        "Creates the repository on the configured Gitea / Forgejo server, selects it, then opens the sync dialog so you can push this vault."
                    )
                    .addButton((b) => {
                        b.setButtonText("Create & upload")
                            .setCta()
                            .onClick(async () => {
                                const repoName =
                                    newRepoNameInput?.getValue()?.trim() ||
                                    settings.giteaRepo?.trim() ||
                                    "";
                                if (!repoName) {
                                    showNotice(
                                        "Enter a repository name first.",
                                        4000
                                    );
                                    return;
                                }
                                if (!settings.giteaBaseUrl?.trim()) {
                                    showNotice(
                                        "Enter a server URL first.",
                                        4000
                                    );
                                    return;
                                }
                                if (!getToken()) {
                                    showNotice(
                                        "Enter a Gitea token first.",
                                        4000
                                    );
                                    return;
                                }

                                b.setDisabled(true);
                                b.setButtonText("Creating…");
                                try {
                                    const result = await createRepo(repoName);
                                    if (!result) {
                                        // `createRepo` shows a user-visible notice on
                                        // known failures; respect that contract and
                                        // simply return here.
                                        return;
                                    }

                                    // Select the new repo and resolve the default branch
                                    settings.giteaRepo = result.name;
                                    const gb =
                                        result.default_branch ??
                                        result.defaultBranch ??
                                        "";
                                    const resolved =
                                        typeof gb === "string" && gb.trim()
                                            ? gb.trim()
                                            : "main";
                                    settings.giteaBranch = resolved;
                                    try {
                                        await persistAndReloadSync();
                                        await refreshReposAndBranches();
                                    } catch (err) {
                                        console.error(
                                            "Failed to persist settings or refresh repos after creating Gitea repository:",
                                            err
                                        );
                                        showNotice(
                                            `Failed to persist settings or refresh repositories: ${err instanceof Error ? err.message : String(err)}`,
                                            6000
                                        );
                                        return;
                                    }

                                    showNotice(
                                        `Repository "${result.name}" created. Opening sync dialog…`,
                                        4000
                                    );
                                    // Open the remote-actions dialog immediately
                                    // so the user can choose how to use the new repo.
                                    await runApiRemoteTargetWorkflow();
                                } catch (err) {
                                    console.error(
                                        "Failed to create Gitea repository:",
                                        err
                                    );
                                    showNotice(
                                        `Failed to create repository: ${
                                            err instanceof Error
                                                ? err.message
                                                : String(err)
                                        }`,
                                        6000
                                    );
                                    return;
                                } finally {
                                    b.setButtonText("Create & upload");
                                    b.setDisabled(false);
                                }
                            });
                    });
            },
        },
    ]);
}
