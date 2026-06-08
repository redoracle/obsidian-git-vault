import {
    Setting,
    type DropdownComponent,
    type TextComponent,
    type ExtraButtonComponent,
} from "obsidian";
import type { GitLabProviderSectionContext } from "../renderContext";
import { preserveCurrentDropdownOption } from "../../settingsHelpers";
import { wireSecureFieldReveal } from "./secureFieldReveal";
import { renderProviderSectionFrame } from "./providerSectionFrame";
import { styleSettingsRefreshButton } from "./settingsRefreshButton";

function normalizeGitLabProjectId(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    try {
        return decodeURIComponent(trimmed);
    } catch {
        return trimmed;
    }
}

function transientOptions(
    currentValue: string,
    fallbackLabel: string
): Record<string, string> {
    return currentValue
        ? {
              [currentValue]: currentValue,
              "": fallbackLabel,
          }
        : { "": fallbackLabel };
}

export function renderGitLabProviderSection({
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
    fetchProjects,
    fetchBranches,
    createProject,
    getProject,
    setDropdownOptions,
    showNotice,
}: GitLabProviderSectionContext): void {
    let projectInput: TextComponent | undefined;
    let projectDropdown: DropdownComponent | undefined;
    let branchDropdown: DropdownComponent | undefined;
    let dropdownLoadSeq = 0;
    let gitlabTokenComponent: TextComponent | undefined;
    let tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    // ── Draft state ─────────────────────────────────────────────────────────
    let draftProjectId: string | null = null;
    let draftBranch: string | null = null;
    let applySettingEl: HTMLElement | undefined = undefined;

    const isDraftDirty = (): boolean =>
        (draftProjectId !== null &&
            draftProjectId !==
                normalizeGitLabProjectId(settings.gitlabProjectId ?? "")) ||
        (draftBranch !== null && draftBranch !== (settings.gitlabBranch ?? ""));

    const effectiveProjectId = (): string =>
        draftProjectId !== null
            ? draftProjectId
            : normalizeGitLabProjectId(settings.gitlabProjectId ?? "");
    const effectiveBranch = (): string =>
        draftBranch !== null ? draftBranch : settings.gitlabBranch ?? "";

    const revertDraft = (): void => {
        draftProjectId = null;
        draftBranch = null;
        if (projectDropdown) projectDropdown.setValue(currentProjectId());
        if (projectInput) projectInput.setValue(currentProjectId());
        if (branchDropdown)
            branchDropdown.setValue(settings.gitlabBranch ?? "");
        updateApplyButton();
    };

    const updateApplyButton = (): void => {
        if (!applySettingEl) return;
        applySettingEl.style.display = isDraftDirty() ? "" : "none";
    };

    // Resolve a project's default branch via the API. Returns the project's
    // `default_branch` trimmed, or "main" as a safe fallback. Errors are
    // logged and result in returning "main".
    const resolveDefaultBranch = async (projectId: string): Promise<string> => {
        if (!projectId) return "main";
        try {
            const proj = await getProject(projectId);
            const candidate = proj?.default_branch?.trim() || "";
            return candidate || "main";
        } catch (err) {
            console.error(
                "[ObsidianGit] Failed to resolve GitLab default branch",
                err
            );
            return "main";
        }
    };

    const currentProjectId = () =>
        normalizeGitLabProjectId(settings.gitlabProjectId ?? "");

    const persistNormalizedTarget = async (
        nextProjectId: string,
        nextBranch: string
    ): Promise<void> => {
        if (isDraftDirty()) return;
        const projectChanged = currentProjectId() !== nextProjectId;
        const branchChanged = (settings.gitlabBranch ?? "") !== nextBranch;
        settings.gitlabProjectId = nextProjectId;
        projectInput?.setValue(nextProjectId);
        settings.gitlabBranch = nextBranch;
        if (projectChanged || branchChanged) {
            await persistAndReloadSync();
        }
    };

    const refreshBranches = async () => {
        if (!branchDropdown) return;
        const projectId = isDraftDirty()
            ? effectiveProjectId()
            : currentProjectId();
        const seq = ++dropdownLoadSeq;
        setDropdownOptions(branchDropdown, { "": "Refreshing..." });
        try {
            const branches = await fetchBranches(projectId);
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(branches, effectiveBranch()),
                effectiveBranch()
            );
            // Attempt to persist but do not fail the UI if persistence fails
            try {
                await persistNormalizedTarget(projectId, nextBranch);
            } catch (persistError) {
                showNotice(
                    `Failed to persist selection: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
                    6000
                );
            }
            return branches;
        } catch (error) {
            if (seq !== dropdownLoadSeq) return;
            setDropdownOptions(branchDropdown, {
                "": `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
            showNotice(
                `Failed to fetch GitLab branches: ${error instanceof Error ? error.message : String(error)}`,
                6000
            );
            return null;
        }
    };

    const refreshProjectsAndBranches = async () => {
        const seq = ++dropdownLoadSeq;
        const activeProjectId = effectiveProjectId();
        const activeBranch = effectiveBranch();
        if (projectDropdown) {
            setDropdownOptions(
                projectDropdown,
                transientOptions(activeProjectId, "Refreshing..."),
                activeProjectId
            );
        }
        if (branchDropdown) {
            setDropdownOptions(
                branchDropdown,
                transientOptions(activeBranch, "Refreshing..."),
                activeBranch
            );
        }
        try {
            const projects = await fetchProjects();
            if (seq !== dropdownLoadSeq) return;
            let nextProjectId = activeProjectId;
            if (projectDropdown) {
                nextProjectId = normalizeGitLabProjectId(
                    setDropdownOptions(
                        projectDropdown,
                        preserveCurrentDropdownOption(
                            projects,
                            activeProjectId
                        ),
                        activeProjectId
                    )
                );
                projectInput?.setValue(nextProjectId);
            }

            try {
                const branches = await fetchBranches(nextProjectId);
                if (seq !== dropdownLoadSeq) return;
                let nextBranch = branchDropdown
                    ? setDropdownOptions(
                          branchDropdown,
                          preserveCurrentDropdownOption(branches, activeBranch),
                          activeBranch
                      )
                    : activeBranch;

                // If no branch is selected yet, attempt to resolve the
                // project's default branch via the API and fall back to
                // "main" if the lookup fails or returns empty.
                if (!nextBranch) {
                    const candidate = await resolveDefaultBranch(nextProjectId);
                    // If another request started while we awaited, abort.
                    if (seq !== dropdownLoadSeq) return;
                    nextBranch = candidate;
                    if (branchDropdown) {
                        // Ensure the dropdown shows the chosen branch if present
                        setDropdownOptions(
                            branchDropdown,
                            preserveCurrentDropdownOption(branches, nextBranch),
                            nextBranch
                        );
                    }
                }

                try {
                    await persistNormalizedTarget(nextProjectId, nextBranch);
                } catch (persistError) {
                    showNotice(
                        `Failed to persist selection: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
                        6000
                    );
                }
            } catch (error) {
                if (seq !== dropdownLoadSeq) return;
                if (branchDropdown) {
                    setDropdownOptions(branchDropdown, {
                        "": `Error: ${error instanceof Error ? error.message : String(error)}`,
                    });
                }
                showNotice(
                    `Failed to fetch GitLab branches: ${error instanceof Error ? error.message : String(error)}`,
                    6000
                );
            }
        } catch (error) {
            if (seq !== dropdownLoadSeq) return;
            if (projectDropdown) {
                setDropdownOptions(
                    projectDropdown,
                    transientOptions(
                        currentProjectId(),
                        `Error: ${error instanceof Error ? error.message : String(error)}`
                    ),
                    currentProjectId()
                );
            }
            showNotice(
                `Failed to fetch GitLab projects: ${error instanceof Error ? error.message : String(error)}`,
                6000
            );
        }
    };

    renderProviderSectionFrame(containerEl, "GitLab API", [
        {
            name: "Connection",
            desc: "Configure the GitLab server this vault should use.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("API base URL")
                    .setDesc(
                        "Use https://gitlab.com/api/v4 for GitLab.com or your self-managed API base URL."
                    )
                    .addText((t) => {
                        t.setValue(settings.gitlabBaseUrl);
                        t.setPlaceholder("https://gitlab.com/api/v4");
                        t.onChange(async (v) => {
                            settings.gitlabBaseUrl = v.trim();
                            await persistAndReloadSync();
                            void refreshProjectsAndBranches();
                        });
                    });
            },
        },
        {
            name: "Authentication",
            desc: "Store the token used to access the selected GitLab project.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Personal access token")
                    .setDesc(
                        "Stored in Obsidian secret storage on this device. Use the smallest API scopes needed for the target project."
                    )
                    .addText((t) => {
                        gitlabTokenComponent = t;
                        t.inputEl.type = "password";
                        t.setValue(getToken());
                        t.setPlaceholder("glpat-...");
                        t.onChange((v) => {
                            setToken(v.trim() || null);
                            // Debounce the project/branch refresh so rapid
                            // keystrokes don't spam the API.
                            clearTimeout(tokenRefreshTimer);
                            tokenRefreshTimer = setTimeout(() => {
                                void (async () => {
                                    try {
                                        await reloadSyncManager();
                                        await refreshProjectsAndBranches();
                                    } catch (error) {
                                        console.error(
                                            "Failed to reload GitLab sync manager:",
                                            error
                                        );
                                        showNotice(
                                            `Failed to reload GitLab sync manager: ${error instanceof Error ? error.message : String(error)}`,
                                            6000
                                        );
                                    }
                                })();
                            }, 400);
                        });
                    })
                    .addExtraButton((button) => {
                        if (gitlabTokenComponent) {
                            queueMicrotask(() => {
                                if (gitlabTokenComponent) {
                                    wireSecureFieldReveal(
                                        button,
                                        gitlabTokenComponent
                                    );
                                }
                            });
                        }
                    });

                new Setting(sectionContainerEl)
                    .setName("Token check")
                    .setDesc(
                        "Quickly verify the currently stored GitLab token."
                    )
                    .addButton((b) =>
                        b.setButtonText("Check token").onClick(async () => {
                            const label = "Check token";
                            b.setDisabled(true);
                            b.setButtonText("Checking...");
                            try {
                                const token = getToken();
                                if (!token) {
                                    showNotice(
                                        "No GitLab token found. Enter a token first.",
                                        5000
                                    );
                                    return;
                                }
                                const user = await requestUser();
                                if (user && (user.username || user.name)) {
                                    showNotice(
                                        `GitLab token valid for ${user.username || user.name}`,
                                        5000
                                    );
                                } else {
                                    showNotice(
                                        "GitLab token appears invalid or lacks permissions.",
                                        6000
                                    );
                                }
                            } catch (error) {
                                console.error(
                                    "Failed to validate GitLab token:",
                                    error
                                );
                                showNotice(
                                    `Failed to validate GitLab token: ${error instanceof Error ? error.message : String(error)}`,
                                    6000
                                );
                            } finally {
                                b.setButtonText(label);
                                b.setDisabled(false);
                            }
                        })
                    );
            },
        },
        {
            name: "Repository target",
            desc: "Choose which GitLab project and branch this vault should sync against.",
            render: (sectionContainerEl: HTMLElement) => {
                new Setting(sectionContainerEl)
                    .setName("Project")
                    .setDesc("Browse recent accessible GitLab projects.")
                    .addDropdown((dd) => {
                        projectDropdown = dd;
                        dd.addOptions({ "": "Loading projects..." });
                        dd.setValue(currentProjectId());
                        dd.onChange(async (v) => {
                            draftProjectId = normalizeGitLabProjectId(v);
                            projectInput?.setValue(draftProjectId);
                            updateApplyButton();
                            await refreshBranches();
                        });
                    })
                    .addExtraButton((btn: ExtraButtonComponent) => {
                        btn.setIcon("refresh-ccw").setTooltip(
                            "Refresh projects"
                        );
                        styleSettingsRefreshButton(btn);
                        btn.onClick(() => {
                            void refreshProjectsAndBranches();
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Project path / ID")
                    .setDesc(
                        "Numeric project id or namespace/project path such as group/vault."
                    )
                    .addText((t) => {
                        projectInput = t;
                        t.setValue(currentProjectId());
                        t.setPlaceholder("group/my-vault");
                        t.onChange(async (v) => {
                            draftProjectId = normalizeGitLabProjectId(v);
                            updateApplyButton();
                            if (projectDropdown) {
                                projectDropdown.setValue(draftProjectId);
                            }
                            await refreshBranches();
                        });
                    });

                new Setting(sectionContainerEl)
                    .setName("Branch")
                    .setDesc("Branch to sync against on GitLab.")
                    .addDropdown((dd) => {
                        branchDropdown = dd;
                        dd.addOptions({ "": "Select a project first" });
                        dd.setValue(settings.gitlabBranch ?? "");
                        dd.onChange((v) => {
                            draftBranch = v || "";
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
                            : "Set the selected project and branch as the sync target."
                    )
                    .addButton((b) => {
                        b.setButtonText("Apply")
                            .setCta()
                            .onClick(async () => {
                                const projectId = effectiveProjectId();
                                const branch = effectiveBranch();
                                if (!projectId || !branch) {
                                    showNotice(
                                        "Select a project and branch first.",
                                        4000
                                    );
                                    return;
                                }
                                b.setDisabled(true);
                                b.setButtonText("Applying…");
                                try {
                                    const confirmed = await confirmTargetChange(
                                        projectId,
                                        branch
                                    );
                                    if (!confirmed) {
                                        revertDraft();
                                        return;
                                    }
                                    settings.gitlabProjectId = projectId;
                                    settings.gitlabBranch = branch;
                                    await persistAndReloadSync();
                                    draftProjectId = null;
                                    draftBranch = null;
                                    updateApplyButton();
                                    if (
                                        settings.gitlabProjectId &&
                                        settings.gitlabBranch
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

                void refreshProjectsAndBranches();
            },
        },
        {
            name: "Create private project",
            desc: "Create a new private GitLab project under your account, then upload this vault to it.",
            render: (sectionContainerEl: HTMLElement) => {
                let newProjectNameInput: TextComponent | undefined;

                new Setting(sectionContainerEl)
                    .setName("New project name")
                    .setDesc(
                        "Display name for the project to create. GitLab derives the path (slug) from this name automatically."
                    )
                    .addText((t) => {
                        newProjectNameInput = t;
                        t.setPlaceholder(
                            settings.gitlabProjectId
                                ? settings.gitlabProjectId.split("/").pop() ??
                                      "my-vault"
                                : "my-vault"
                        );
                    });

                new Setting(sectionContainerEl)
                    .setName("Create and upload vault")
                    .setDesc(
                        "Creates the project on GitLab, selects it, then opens the sync dialog so you can push this vault. Requires a token with the 'api' scope."
                    )
                    .addButton((b) => {
                        b.setButtonText("Create & upload")
                            .setCta()
                            .onClick(async () => {
                                const projectName = newProjectNameInput
                                    ?.getValue()
                                    ?.trim();
                                if (!projectName) {
                                    showNotice(
                                        "Enter a project name first.",
                                        4000
                                    );
                                    return;
                                }
                                if (!getToken()) {
                                    showNotice(
                                        "Enter a GitLab token first.",
                                        4000
                                    );
                                    return;
                                }

                                b.setDisabled(true);
                                b.setButtonText("Creating…");
                                try {
                                    const result =
                                        await createProject(projectName);
                                    if (!result) return; // notice already shown

                                    // Select the new project and attempt to resolve
                                    // its default branch via the API. Fall back to
                                    // "main" if the lookup fails or returns empty.
                                    settings.gitlabProjectId =
                                        result.pathWithNamespace;
                                    projectInput?.setValue(
                                        result.pathWithNamespace
                                    );

                                    // Resolve the project's default branch (fallback to
                                    // "main" on error or empty) via helper.
                                    const defaultBranch =
                                        await resolveDefaultBranch(
                                            result.pathWithNamespace
                                        );

                                    settings.gitlabBranch = defaultBranch;
                                    await persistAndReloadSync();
                                    await refreshProjectsAndBranches();

                                    showNotice(
                                        `Project "${result.pathWithNamespace}" created. Opening sync dialog…`,
                                        4000
                                    );
                                    // Open the remote-actions dialog immediately
                                    // so the user can choose how to use the new project.
                                    await runApiRemoteTargetWorkflow();
                                } catch (err) {
                                    console.error(
                                        "[ObsidianGit] Failed to create GitLab project",
                                        err
                                    );
                                    showNotice(
                                        `Failed to create project: ${err instanceof Error ? err.message : String(err)}`,
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
