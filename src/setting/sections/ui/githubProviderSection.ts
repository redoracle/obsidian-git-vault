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
    runApiRemoteTargetWorkflow,
    isVaultLinked,
    confirmTargetChange,
    requestUser,
    fetchRepos,
    fetchBranches,
    createRepo,
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
    // ── Draft state for manual repo/branch changes ──────────────────────────
    let draftRepo: string | null = null;
    let draftBranch: string | null = null;
    let applySettingEl: HTMLElement | undefined = undefined;

    const isDraftDirty = (): boolean =>
        (draftRepo !== null && draftRepo !== (settings.githubRepo ?? "")) ||
        (draftBranch !== null && draftBranch !== (settings.githubBranch ?? ""));

    const effectiveRepo = (): string =>
        draftRepo !== null ? draftRepo : settings.githubRepo ?? "";
    const effectiveBranch = (): string =>
        draftBranch !== null ? draftBranch : settings.githubBranch ?? "";

    const revertDraft = (): void => {
        draftRepo = null;
        draftBranch = null;
        if (repoDropdown) repoDropdown.setValue(settings.githubRepo ?? "");
        if (branchDropdown)
            branchDropdown.setValue(settings.githubBranch ?? "");
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
        // Skip auto-persist when the user has uncommitted draft changes
        if (isDraftDirty()) return;
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
        const activeRepo = effectiveRepo();
        const repos = await fetchRepos(owner);
        if (seq !== dropdownLoadSeq) return;
        const nextRepo = setDropdownOptions(
            repoDropdown,
            preserveCurrentDropdownOption(repos, activeRepo),
            activeRepo
        );
        const branches = await fetchBranches(owner, nextRepo);
        if (seq !== dropdownLoadSeq) return;
        const activeBranch = effectiveBranch();
        const nextBranch = setDropdownOptions(
            branchDropdown,
            preserveCurrentDropdownOption(branches, activeBranch),
            activeBranch
        );
        await persistNormalizedTarget(nextRepo, nextBranch);
    };

    const refreshBranchOptions = async (seq: number): Promise<void> => {
        const activeRepo = effectiveRepo();
        const activeBranch = effectiveBranch();
        const branches = await fetchBranches(settings.githubOwner, activeRepo);
        if (seq !== dropdownLoadSeq) return;
        const nextBranch = setDropdownOptions(
            branchDropdown,
            preserveCurrentDropdownOption(branches, activeBranch),
            activeBranch
        );
        await persistNormalizedTarget(activeRepo, nextBranch);
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
                            draftRepo = v || "";
                            // Reset branch draft when repo changes to avoid
                            // carrying a stale branch from the previous repo.
                            draftBranch = settings.githubBranch ?? "";
                            updateApplyButton();

                            const seq = ++dropdownLoadSeq;
                            try {
                                // Refresh branches for the draft repo so the
                                // branch dropdown updates immediately.
                                const branches = await fetchBranches(
                                    settings.githubOwner ?? "",
                                    draftRepo
                                );
                                if (seq !== dropdownLoadSeq) return;
                                setDropdownOptions(
                                    branchDropdown,
                                    preserveCurrentDropdownOption(
                                        branches,
                                        settings.githubBranch ?? ""
                                    ),
                                    // Show the persisted branch, not the draft
                                    settings.githubBranch ?? ""
                                );
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
                        dd.onChange((v) => {
                            draftBranch = v || "";
                            updateApplyButton();
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

                // ── Apply button (visible only when draft differs from settings) ─
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
                                        // User cancelled — revert draft
                                        revertDraft();
                                        return;
                                    }
                                    // Persist the change
                                    settings.githubRepo = repo;
                                    settings.githubBranch = branch;
                                    await persistAndReloadSync();
                                    // Clear draft state
                                    draftRepo = null;
                                    draftBranch = null;
                                    updateApplyButton();
                                    // Open the remote-actions dialog immediately
                                    // after a confirmed switch so the user can
                                    // choose how to use the new target.
                                    if (
                                        settings.githubOwner &&
                                        settings.githubRepo &&
                                        settings.githubBranch
                                    ) {
                                        void Promise.resolve()
                                            .then(() =>
                                                runApiRemoteTargetWorkflow()
                                            )
                                            .catch((error: unknown) => {
                                                console.error(
                                                    "[ObsidianGit] Failed to open remote-actions workflow after GitHub target change",
                                                    error
                                                );
                                                showNotice(
                                                    `Failed to open remote actions: ${
                                                        error instanceof Error
                                                            ? error.message
                                                            : String(error)
                                                    }`,
                                                    6000
                                                );
                                            });
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
                // Initially hidden; shown when draft differs from settings
                applySettingEl.style.display = "none";

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
        {
            name: "Create private repository",
            desc: "Create a new private GitHub repository for the owner above, then upload this vault to it.",
            render: (sectionContainerEl: HTMLElement) => {
                let newRepoNameInput: TextComponent | undefined;

                new Setting(sectionContainerEl)
                    .setName("New repository name")
                    .setDesc(
                        "Name for the private repository to create. Leave blank to use the current repository name."
                    )
                    .addText((t) => {
                        newRepoNameInput = t;
                        t.setPlaceholder(settings.githubRepo || "my-vault");
                    });

                new Setting(sectionContainerEl)
                    .setName("Create and upload vault")
                    .setDesc(
                        "Creates the repository on GitHub, selects it, then opens the sync dialog so you can push this vault. Requires a token with the 'repo' scope or the 'administration: write' fine-grained permission."
                    )
                    .addButton((b) => {
                        b.setButtonText("Create & upload")
                            .setCta()
                            .onClick(async () => {
                                const owner = settings.githubOwner?.trim();
                                if (!owner) {
                                    showNotice(
                                        "Enter an owner / organisation first.",
                                        4000
                                    );
                                    return;
                                }
                                const repoName =
                                    newRepoNameInput?.getValue()?.trim() ||
                                    settings.githubRepo?.trim() ||
                                    "";
                                // Basic validation before making API calls.
                                if (!repoName) {
                                    showNotice(
                                        "Enter a repository name first.",
                                        4000
                                    );
                                    return;
                                }
                                if (repoName.length > 100) {
                                    showNotice(
                                        "Repository name must be 100 characters or fewer.",
                                        4000
                                    );
                                    return;
                                }
                                if (repoName.startsWith(".")) {
                                    showNotice(
                                        "Repository name must not start with a dot ('.').",
                                        4000
                                    );
                                    return;
                                }
                                if (/\s/.test(repoName)) {
                                    showNotice(
                                        "Repository name must not contain spaces.",
                                        4000
                                    );
                                    return;
                                }
                                // Allow letters, numbers, hyphen, underscore, and dot only.
                                if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
                                    showNotice(
                                        "Repository name contains invalid characters. Use only letters, numbers, hyphen (-), underscore (_), or dot (.).",
                                        6000
                                    );
                                    return;
                                }
                                if (!getToken()) {
                                    showNotice(
                                        "Enter a GitHub token first.",
                                        4000
                                    );
                                    return;
                                }

                                b.setDisabled(true);
                                b.setButtonText("Creating…");
                                try {
                                    const result = await createRepo(
                                        owner,
                                        repoName
                                    );
                                    // `createRepo` shows a user-facing notice on
                                    // failure and returns `null`. Respect that
                                    // contract by returning early here.
                                    if (!result) return;

                                    // Select the new repo and prefer the server's
                                    // default branch when available, otherwise
                                    // fall back to "main".
                                    settings.githubRepo = result.name;
                                    const gb =
                                        result.default_branch ??
                                        result.defaultBranch ??
                                        "";
                                    const resolved =
                                        typeof gb === "string" && gb.trim()
                                            ? gb.trim()
                                            : "main";
                                    settings.githubBranch = resolved;
                                    await persistAndReloadSync();

                                    // Refresh dropdowns to reflect the new repo;
                                    // surface a clear notice if this step fails
                                    // so the user knows the repo was created
                                    // even though the UI didn't update.
                                    const seq = ++dropdownLoadSeq;
                                    try {
                                        await refreshRepoAndBranchOptions(
                                            owner,
                                            seq
                                        );
                                    } catch (refreshErr) {
                                        console.error(
                                            "[ObsidianGit] Dropdown refresh failed after GitHub repo creation",
                                            { repo: result.name, seq },
                                            refreshErr
                                        );
                                        showNotice(
                                            `Repository "${result.name}" was created but the dropdown refresh failed — refresh manually.`,
                                            7000
                                        );
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
                                        "[ObsidianGit] Failed to create GitHub repository",
                                        err
                                    );
                                    showNotice(
                                        `Failed to create repository: ${err instanceof Error ? err.message : String(err)}`,
                                        7000
                                    );
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
