import {
    Setting,
    type DropdownComponent,
    type TextComponent,
    type ExtraButtonComponent,
} from "obsidian";
import type { GitHubProviderSectionContext } from "../renderContext";
import { preserveCurrentDropdownOption } from "../../settingsHelpers";
import { wireSecureFieldReveal } from "./secureFieldReveal";
import { renderProviderSectionFrame } from "./providerSectionFrame";

export function renderGitHubProviderSection({
    containerEl,
    settings,
    getToken,
    setToken,
    persistAndReloadSync,
    scheduleApiRemoteTargetPrompt,
    requestUser,
    fetchRepos,
    fetchBranches,
    setDropdownOptions,
    showNotice,
}: GitHubProviderSectionContext): void {
    // Declared up front so the synchronous addText/addDropdown callbacks below
    // can assign to them without hitting the temporal dead zone.
    let ownerTextComponent: TextComponent | undefined = undefined;
    let githubTokenComponent: TextComponent | undefined = undefined;
    let repoDropdown: DropdownComponent | undefined = undefined;
    let branchDropdown: DropdownComponent | undefined = undefined;
    // Sequence counter to discard out-of-order repo/branch fetches when the
    // user changes the dropdowns or the initial load resolves late.
    let dropdownLoadSeq = 0;

    const persistNormalizedTarget = async (
        nextRepo: string,
        nextBranch: string
    ): Promise<void> => {
        const repoChanged = (settings.githubRepo ?? "") !== nextRepo;
        const branchChanged = (settings.githubBranch ?? "") !== nextBranch;
        settings.githubRepo = nextRepo;
        settings.githubBranch = nextBranch;
        if (repoChanged || branchChanged) {
            await persistAndReloadSync();
        }
    };

    const refreshRepoAndBranchOptions = async (
        owner: string,
        seq: number
    ): Promise<void> => {
        const repos = await fetchRepos(owner);
        if (seq !== dropdownLoadSeq) return;
        const nextRepo = setDropdownOptions(
            repoDropdown,
            preserveCurrentDropdownOption(repos, settings.githubRepo ?? ""),
            settings.githubRepo ?? ""
        );
        const branches = await fetchBranches(owner, nextRepo);
        if (seq !== dropdownLoadSeq) return;
        const nextBranch = setDropdownOptions(
            branchDropdown,
            preserveCurrentDropdownOption(
                branches,
                settings.githubBranch ?? ""
            ),
            settings.githubBranch ?? ""
        );
        await persistNormalizedTarget(nextRepo, nextBranch);
    };

    const refreshBranchOptions = async (seq: number): Promise<void> => {
        const branches = await fetchBranches(
            settings.githubOwner,
            settings.githubRepo
        );
        if (seq !== dropdownLoadSeq) return;
        const nextBranch = setDropdownOptions(
            branchDropdown,
            preserveCurrentDropdownOption(
                branches,
                settings.githubBranch ?? ""
            ),
            settings.githubBranch ?? ""
        );
        await persistNormalizedTarget(settings.githubRepo ?? "", nextBranch);
    };

    // Debounce timer for the token input so we don't fire API calls on every
    // keystroke while the user is typing or pasting a token character by character.
    let tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    renderProviderSectionFrame(containerEl, "GitHub API", [
        {
            name: "Authentication",
            desc: "Store the token for this device and verify that it can access the target repository.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Personal access token")
                    .setDesc(
                        "Stored in Obsidian secret storage on this device, not in synced plugin settings. Use a fine-grained token with the smallest scopes possible, rotate it regularly, and remove or rotate it if an older install ever synced a plaintext copy."
                    )
                    .addText((t) => {
                        githubTokenComponent = t;
                        t.inputEl.type = "password";
                        t.setValue(getToken());
                        t.setPlaceholder("ghp_...");
                        t.onChange(async (v) => {
                            try {
                                const token = v.trim();
                                setToken(token.length > 0 ? token : null);
                                settings.githubToken = "";
                                await persistAndReloadSync();
                            } catch (error) {
                                console.error(
                                    "Failed to persist GitHub token:",
                                    error
                                );
                                showNotice(
                                    `Failed to persist GitHub token: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                                return;
                            }
                            // Token changed — debounce the repo/branch refresh
                            // so rapid keystrokes don't spam the API. The
                            // dropdownLoadSeq guard still discards stale results.
                            clearTimeout(tokenRefreshTimer);
                            tokenRefreshTimer = setTimeout(() => {
                                const seq = ++dropdownLoadSeq;
                                const owner = settings.githubOwner ?? "";
                                void (async () => {
                                    try {
                                        await refreshRepoAndBranchOptions(
                                            owner,
                                            seq
                                        );
                                    } catch (fetchError) {
                                        if (seq !== dropdownLoadSeq) return;
                                        console.error(
                                            "[ObsidianGit] Failed to refresh repo/branch dropdowns after token change:",
                                            fetchError
                                        );
                                    }
                                })();
                            }, 400);
                        });
                    })
                    .addExtraButton((button) => {
                        if (githubTokenComponent) {
                            wireSecureFieldReveal(button, githubTokenComponent);
                        }
                    });

                new Setting(sectionContainerEl)
                    .setName("Token check")
                    .setDesc(
                        "Quickly verify the currently stored GitHub token."
                    )
                    .addButton((b) =>
                        b.setButtonText("Check token").onClick(async () => {
                            const token = getToken();
                            if (!token) {
                                showNotice(
                                    "No GitHub token found. Enter a token first.",
                                    5000
                                );
                                return;
                            }
                            try {
                                const user = await requestUser();
                                if (user && user.login) {
                                    showNotice(
                                        `GitHub token valid for ${user.login}`,
                                        5000
                                    );
                                } else {
                                    showNotice(
                                        "GitHub token appears invalid or lacks permissions.",
                                        6000
                                    );
                                }
                            } catch (error) {
                                console.error(
                                    "Failed to validate GitHub token:",
                                    error
                                );
                                showNotice(
                                    `Failed to validate GitHub token: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                            }
                        })
                    );

                containerEl.createEl("p", {
                    cls: "setting-item-description",
                    text: "Safer options: keep scopes limited to the target repository, rotate the token if the vault was ever synced with it present, and clear the field before exporting or backing up older plugin settings.",
                });
                // Cleanup function: ensure any pending token refresh timer is cleared
                // when the provider section is destroyed to avoid running after teardown.
                return () => {
                    if (tokenRefreshTimer) {
                        clearTimeout(tokenRefreshTimer);
                        tokenRefreshTimer = undefined;
                    }
                };
            },
        },
        {
            name: "Repository target",
            desc: "Choose which GitHub repository and branch this vault should sync against.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Owner / organization")
                    .setDesc(
                        "Account or organisation that owns the repository."
                    )
                    .addText((t) => {
                        ownerTextComponent = t;
                        t.setValue(settings.githubOwner);
                        t.setPlaceholder("your-username");
                        t.onChange(async (v) => {
                            const previousOwner = settings.githubOwner;
                            settings.githubOwner = v.trim();
                            // Owner change must reload immediately — debounce risks
                            // a sync firing against the old provider during the delay.
                            try {
                                await persistAndReloadSync();
                            } catch (e) {
                                settings.githubOwner = previousOwner;
                                ownerTextComponent?.setValue(
                                    previousOwner ?? ""
                                );
                                const errorMsg =
                                    e instanceof Error ? e.message : String(e);
                                console.error(
                                    "[ObsidianGit] Failed to persist GitHub owner change",
                                    {
                                        error: errorMsg,
                                        owner: previousOwner,
                                    }
                                );
                                showNotice(
                                    `Failed to save GitHub owner: ${errorMsg}`,
                                    6000
                                );
                                return;
                            }
                            // Refresh repo/branch dropdowns for the new owner
                            const seq = ++dropdownLoadSeq;
                            const owner = settings.githubOwner ?? "";
                            try {
                                await refreshRepoAndBranchOptions(owner, seq);
                            } catch (e) {
                                if (seq !== dropdownLoadSeq) return;
                                const errorMsg =
                                    e instanceof Error ? e.message : String(e);
                                console.error(
                                    "[ObsidianGit] Failed to update repo/branch dropdowns after owner change",
                                    {
                                        error: errorMsg,
                                        owner,
                                        repo: settings.githubRepo,
                                    }
                                );
                                showNotice(
                                    `Failed to update GitHub repos/branches for ${owner}/${settings.githubRepo ?? ""}: ${errorMsg}`,
                                    6000
                                );
                            }
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Repository")
                    .setDesc("Name of the repository to sync with.")
                    .addDropdown((dd) => {
                        repoDropdown = dd;
                        dd.addOptions({ "": "Loading repositories..." });
                        dd.setValue(settings.githubRepo ?? "");
                        dd.onChange(async (v) => {
                            const previousRepo = settings.githubRepo;
                            settings.githubRepo = v || "";
                            try {
                                await persistAndReloadSync();
                            } catch (error) {
                                settings.githubRepo = previousRepo;
                                repoDropdown?.setValue(previousRepo ?? "");
                                console.error(
                                    "Failed to persist GitHub repo change:",
                                    error
                                );
                                showNotice(
                                    `Failed to save GitHub repo: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                                return;
                            }

                            const seq = ++dropdownLoadSeq;
                            try {
                                await refreshBranchOptions(seq);
                            } catch (error) {
                                console.error(
                                    "Failed to fetch GitHub branches after repo change:",
                                    error
                                );
                                if (seq !== dropdownLoadSeq) return;
                                setDropdownOptions(branchDropdown, {
                                    "": "Failed to fetch branches",
                                });
                                showNotice(
                                    `Failed to fetch branches: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                            }
                        });
                    })
                    .addExtraButton((btn: ExtraButtonComponent) => {
                        btn.setIcon("refresh-ccw").setTooltip(
                            "Refresh repositories"
                        );
                        btn.extraSettingsEl.classList.add(
                            "git-vault-settings-refresh-btn"
                        );
                        btn.onClick(async () => {
                            if (!repoDropdown) return;
                            const seq = ++dropdownLoadSeq;
                            setDropdownOptions(repoDropdown, {
                                "": "Refreshing...",
                            });
                            try {
                                await refreshRepoAndBranchOptions(
                                    settings.githubOwner ?? "",
                                    seq
                                );
                            } catch (e) {
                                if (seq !== dropdownLoadSeq) return;
                                const errorMsg =
                                    e instanceof Error ? e.message : String(e);
                                setDropdownOptions(repoDropdown, {
                                    "": `Error: ${errorMsg}`,
                                });
                                showNotice(
                                    `Failed to fetch repositories: ${errorMsg}`,
                                    6000
                                );
                            }
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Branch")
                    .setDesc("Branch to sync against (default: main).")
                    .addDropdown((dd) => {
                        branchDropdown = dd;
                        dd.addOptions({ "": "Select a branch" });
                        dd.setValue(settings.githubBranch ?? "");
                        dd.onChange(async (v) => {
                            const previousBranch = settings.githubBranch;
                            settings.githubBranch = v || "";
                            try {
                                await persistAndReloadSync();
                                if (
                                    settings.githubOwner &&
                                    settings.githubRepo &&
                                    settings.githubBranch
                                ) {
                                    scheduleApiRemoteTargetPrompt();
                                }
                            } catch (error) {
                                settings.githubBranch = previousBranch;
                                branchDropdown?.setValue(previousBranch ?? "");
                                console.error(
                                    "Failed to persist GitHub branch change:",
                                    error
                                );
                                showNotice(
                                    `Failed to save GitHub branch: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                            }
                        });
                    })
                    .addExtraButton((btn: ExtraButtonComponent) => {
                        btn.setIcon("refresh-ccw").setTooltip(
                            "Refresh branches"
                        );
                        btn.extraSettingsEl.classList.add(
                            "git-vault-settings-refresh-btn"
                        );
                        btn.onClick(async () => {
                            if (!branchDropdown) return;
                            const seq = ++dropdownLoadSeq;
                            setDropdownOptions(branchDropdown, {
                                "": "Refreshing...",
                            });
                            try {
                                await refreshBranchOptions(seq);
                            } catch (e) {
                                if (seq !== dropdownLoadSeq) return;
                                const errorMsg =
                                    e instanceof Error ? e.message : String(e);
                                setDropdownOptions(branchDropdown, {
                                    "": `Error: ${errorMsg}`,
                                });
                                showNotice(
                                    `Failed to fetch branches: ${errorMsg}`,
                                    6000
                                );
                            }
                        });
                    });

                void (async () => {
                    const seq = ++dropdownLoadSeq;
                    try {
                        const owner = settings.githubOwner ?? "";
                        await refreshRepoAndBranchOptions(owner, seq);
                    } catch (e) {
                        if (seq !== dropdownLoadSeq) return;
                        const errorMsg =
                            e instanceof Error ? e.message : String(e);
                        setDropdownOptions(repoDropdown, {
                            "": `Error: ${errorMsg}`,
                        });
                        setDropdownOptions(branchDropdown, {
                            "": "No branches found",
                        });
                        showNotice(
                            `Failed to fetch GitHub repos/branches: ${errorMsg}`,
                            6000
                        );
                    }
                })();
            },
        },
    ]);
}
