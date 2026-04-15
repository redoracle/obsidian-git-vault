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
    scheduleApiRemoteTargetPrompt,
    reloadSyncManager,
    requestUser,
    fetchProjects,
    fetchBranches,
    setDropdownOptions,
    showNotice,
}: GitLabProviderSectionContext): void {
    let projectInput: TextComponent | undefined;
    let projectDropdown: DropdownComponent | undefined;
    let branchDropdown: DropdownComponent | undefined;
    let dropdownLoadSeq = 0;
    let gitlabTokenComponent: TextComponent | undefined;
    let tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    const currentProjectId = () =>
        normalizeGitLabProjectId(settings.gitlabProjectId ?? "");

    const persistNormalizedTarget = async (
        nextProjectId: string,
        nextBranch: string
    ): Promise<void> => {
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
        const seq = ++dropdownLoadSeq;
        setDropdownOptions(branchDropdown, { "": "Refreshing..." });
        try {
            const branches = await fetchBranches(currentProjectId());
            if (seq !== dropdownLoadSeq) return;
            const nextBranch = setDropdownOptions(
                branchDropdown,
                preserveCurrentDropdownOption(
                    branches,
                    settings.gitlabBranch ?? ""
                ),
                settings.gitlabBranch ?? ""
            );
            // Attempt to persist but do not fail the UI if persistence fails
            try {
                await persistNormalizedTarget(currentProjectId(), nextBranch);
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
        if (projectDropdown) {
            setDropdownOptions(
                projectDropdown,
                transientOptions(currentProjectId(), "Refreshing..."),
                currentProjectId()
            );
        }
        if (branchDropdown) {
            setDropdownOptions(
                branchDropdown,
                transientOptions(settings.gitlabBranch ?? "", "Refreshing..."),
                settings.gitlabBranch ?? ""
            );
        }
        try {
            const projects = await fetchProjects();
            if (seq !== dropdownLoadSeq) return;
            let nextProjectId = currentProjectId();
            if (projectDropdown) {
                nextProjectId = normalizeGitLabProjectId(
                    setDropdownOptions(
                        projectDropdown,
                        preserveCurrentDropdownOption(
                            projects,
                            currentProjectId()
                        ),
                        currentProjectId()
                    )
                );
                projectInput?.setValue(nextProjectId);
            }

            try {
                const branches = await fetchBranches(nextProjectId);
                if (seq !== dropdownLoadSeq) return;
                const nextBranch = branchDropdown
                    ? setDropdownOptions(
                          branchDropdown,
                          preserveCurrentDropdownOption(
                              branches,
                              settings.gitlabBranch ?? ""
                          ),
                          settings.gitlabBranch ?? ""
                      )
                    : settings.gitlabBranch ?? "";
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
                            settings.gitlabProjectId =
                                normalizeGitLabProjectId(v);
                            projectInput?.setValue(settings.gitlabProjectId);
                            await persistAndReloadSync();
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
                            settings.gitlabProjectId =
                                normalizeGitLabProjectId(v);
                            await persistAndReloadSync();
                            if (projectDropdown) {
                                projectDropdown.setValue(currentProjectId());
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
                        dd.onChange(async (v) => {
                            settings.gitlabBranch = v || "";
                            await persistAndReloadSync();
                            if (
                                settings.gitlabProjectId &&
                                settings.gitlabBranch
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

                void refreshProjectsAndBranches();
            },
        },
    ]);
}
