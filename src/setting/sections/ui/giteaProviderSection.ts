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
    scheduleApiRemoteTargetPrompt,
    reloadSyncManager,
    requestUser,
    fetchRepos,
    fetchBranches,
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

    const persistNormalizedTarget = async (
        nextRepo: string,
        nextBranch: string
    ): Promise<void> => {
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
        const seq = ++dropdownLoadSeq;
        setDropdownOptions(branchDropdown, { "": "Refreshing..." });
        try {
            const branches = await fetchBranches(
                settings.giteaOwner ?? "",
                settings.giteaRepo ?? ""
            );
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(
                    branches,
                    settings.giteaBranch ?? ""
                ),
                settings.giteaBranch ?? ""
            );
            await persistNormalizedTarget(settings.giteaRepo ?? "", nextBranch);
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
                preserveCurrentDropdownOption(repos, settings.giteaRepo ?? ""),
                settings.giteaRepo ?? ""
            );
            const branches = await fetchBranches(
                settings.giteaOwner ?? "",
                nextRepo
            );
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(
                    branches,
                    settings.giteaBranch ?? ""
                ),
                settings.giteaBranch ?? ""
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
                        dd.onChange(async (v) => {
                            settings.giteaRepo = v || "";
                            await persistAndReloadSync();
                            await refreshReposAndBranches();
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
                        dd.onChange(async (v) => {
                            settings.giteaBranch = v || "";
                            await persistAndReloadSync();
                            if (
                                settings.giteaOwner &&
                                settings.giteaRepo &&
                                settings.giteaBranch
                            ) {
                                scheduleApiRemoteTargetPrompt();
                            }
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

                if (!initialRepoRefreshContainers.has(containerEl)) {
                    initialRepoRefreshContainers.add(containerEl);
                    void refreshReposAndBranches();
                }
            },
        },
    ]);
}
