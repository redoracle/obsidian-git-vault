import {
    Setting,
    type DropdownComponent,
    type TextComponent,
    type ExtraButtonComponent,
    requestUrl,
    type RequestUrlParam,
} from "obsidian";
import type { INoticeHandle } from "src/notification/noticePresenter";
import type ObsidianGit from "src/main";
import {
    buildHostedHttpsRemoteUrl,
    formatRemoteUrl,
    parseHostedHttpsRemoteUrl,
} from "src/utils";
import { buildOptionsFromNames } from "src/setting/settingsHelpers";
import type { SetDropdownOptions } from "../renderContext";
import * as fs from "fs";
import { wireSecureFieldReveal } from "./secureFieldReveal";
import { styleSettingsRefreshButton } from "./settingsRefreshButton";

// Centralized timeout for Git operations to simplify tuning across the UI
const GIT_OPERATION_TIMEOUT_MS = 20_000;

interface GitHubUserResponse {
    login?: string;
}

interface GitHubCreateRepoResponse {
    clone_url?: string;
}

function getGitAuthStatusDescription({
    useSimpleGit,
    username,
    password,
}: {
    useSimpleGit: boolean;
    username: string;
    password: string;
}): string {
    const processLike = globalThis as typeof globalThis & {
        process?: {
            env?: Record<string, string | undefined>;
            platform?: string;
        };
    };

    // Detect common SSH agent indicators across platforms.
    let sshAgentDetected = false;
    try {
        // Unix-style SSH_AUTH_SOCK
        if (
            typeof processLike.process?.env?.SSH_AUTH_SOCK === "string" &&
            processLike.process.env.SSH_AUTH_SOCK.length > 0
        ) {
            sshAgentDetected = true;
        } else if (processLike.process?.platform === "win32") {
            // Windows: look for SSH_AGENT_PID or the OpenSSH named pipe
            if (
                typeof processLike.process?.env?.SSH_AGENT_PID === "string" &&
                processLike.process.env.SSH_AGENT_PID.length > 0
            ) {
                sshAgentDetected = true;
            } else {
                try {
                    // Named pipe used by OpenSSH agent on Windows
                    if (fs.existsSync("\\\\.\\pipe\\openssh-ssh-agent")) {
                        sshAgentDetected = true;
                    }
                } catch (_err) {
                    // ignore filesystem check errors
                }
            }
        }
    } catch (_err) {
        sshAgentDetected = false;
    }

    const platform = processLike.process?.platform;
    const sshStatus = useSimpleGit
        ? sshAgentDetected
            ? "SSH agent detected for SSH remotes."
            : platform === "win32"
              ? "SSH agent not detected; on Windows ensure the OpenSSH agent service is running or the named pipe \\\\.\\pipe\\openssh-ssh-agent is available."
              : "SSH agent not detected; SSH may still work if your system Git can find a configured key."
        : "SSH is unavailable in the embedded Git fallback.";
    const httpsStatus =
        username.length > 0 && password.length > 0
            ? "HTTPS username and token/password are stored on this device."
            : username.length > 0
              ? "HTTPS username is stored, but no token/password is stored."
              : password.length > 0
                ? "HTTPS token/password is stored; username may still be required by your Git host."
                : "No HTTPS credentials are stored on this device.";

    return `${sshStatus} ${httpsStatus}`;
}

export function renderGitBackendSection({
    containerEl,
    plugin,
    refreshDisplayWithDelay,
    reloadSyncManager,
    getGitSyncSettingsState,
    setDropdownOptions,
    getStoredGitHttpUsername,
    setStoredGitHttpUsername,
    getStoredGitHttpPassword,
    setStoredGitHttpPassword,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    refreshDisplayWithDelay: () => void;
    reloadSyncManager: () => Promise<void>;
    getGitSyncSettingsState: (plugin: ObsidianGit) => Promise<{
        repoReady: boolean;
        headReady: boolean;
        currentBranch?: string;
        tracking?: string;
        branches: string[];
        remotes: string[];
        remoteName: string;
        remoteUrl: string;
    }>;
    setDropdownOptions: SetDropdownOptions;
    getStoredGitHttpUsername: () => string;
    setStoredGitHttpUsername: (username: string) => void;
    getStoredGitHttpPassword: () => string;
    setStoredGitHttpPassword: (password: string) => void;
}): void {
    new Setting(containerEl).setName("Git backend").setHeading();

    const runtimeLabel = plugin.useSimpleGit
        ? "Native Git (desktop)"
        : "Isomorphic Git fallback";
    const authDescription = plugin.useSimpleGit
        ? "Uses system Git. SSH remotes use your existing ssh-agent/private key. HTTPS remotes use your Git credential helper, askpass prompt, or the username/PAT stored below. Git Vault does not store SSH private keys."
        : "Uses the embedded Git fallback. Use an HTTPS remote and store HTTP credentials below. SSH keys are not supported in this runtime.";

    new Setting(containerEl)
        .setName("Git runtime")
        .setDesc(`${runtimeLabel}. ${authDescription}`);

    new Setting(containerEl).setName("Git setup guide").setHeading();

    new Setting(containerEl)
        .setName("Setup path")
        .setDesc(
            plugin.gitReady
                ? "This vault is already a Git repository. Review the remote and HTTPS credentials below, then sync from the Git view."
                : "Already cloned? Open that repository folder as the Obsidian vault. Cloning? Enter the Remote URL below, then choose a clone action. Publishing this vault? Enter the Remote URL, optional HTTPS credentials, then initialize."
        );

    let localBranchDropdown: DropdownComponent | undefined;
    let upstreamBranchDropdown: DropdownComponent | undefined;
    let remoteNameInput: TextComponent | undefined;
    let remoteUrlInput: TextComponent | undefined;
    let hostedBaseUrlInput: TextComponent | undefined;
    let hostedNamespacePathInput: TextComponent | undefined;
    let hostedRepositoryInput: TextComponent | undefined;
    let gitHttpPasswordInput: TextComponent | undefined;
    let remoteName = "origin";
    let remoteUrl = "";
    const remoteUrlValidation: {
        el: HTMLDivElement | undefined;
    } = {
        el: undefined,
    };
    const setRemoteUrlValidation = (message: string | null): void => {
        if (!remoteUrlValidation.el) {
            return;
        }

        remoteUrlValidation.el.textContent = message ?? "";
        remoteUrlValidation.el.toggleClass("is-visible", Boolean(message));
    };
    let remoteNameDirty = false;
    let remoteUrlDirty = false;
    let hostedTargetDirty = false;
    let advancedGitSettingsEl: HTMLElement | undefined;

    const getAdvancedGitSettingsEl = (): HTMLElement => {
        if (!plugin.gitReady) {
            return containerEl;
        }
        if (advancedGitSettingsEl) {
            return advancedGitSettingsEl;
        }

        const advancedDetails = containerEl.createEl("details", {
            cls: "git-vault-git-advanced-details",
            attr: {
                "data-git-vault-git-advanced": "true",
            },
        });
        advancedDetails.createEl("summary", {
            text: "Advanced Git options",
            cls: "git-vault-git-advanced-summary",
        });
        const descriptionEl = advancedDetails.createDiv({
            cls: "git-vault-git-advanced-description",
        });
        descriptionEl.setText(
            "Remote aliases, hosted URL helpers, and branch tracking controls for existing Git repositories."
        );
        advancedGitSettingsEl = advancedDetails.createDiv({
            cls: "git-vault-git-advanced-content",
        });

        return advancedGitSettingsEl;
    };

    const getEnteredRemoteUrl = (): string =>
        remoteUrlInput?.inputEl.value.trim() ?? remoteUrl.trim();

    let _isCloning = false;
    let cloneNoticeHandle: INoticeHandle | undefined;

    const cloneFromEnteredRemote = async (
        target: "current-vault" | "dedicated-vault"
    ): Promise<void> => {
        if (_isCloning) {
            plugin.showNotice(
                "A clone operation is already in progress.",
                3000
            );
            return;
        }
        const enteredRemoteUrl = getEnteredRemoteUrl();
        if (!enteredRemoteUrl) {
            setRemoteUrlValidation("Enter a remote URL before cloning.");
            plugin.showNotice("Enter a remote URL before cloning.", 5000);
            return;
        }

        // Clear any previous validation and mark cloning state.
        setRemoteUrlValidation(null);
        _isCloning = true;
        cloneNoticeHandle = plugin.showNotice("Cloning...", 0);

        try {
            await plugin.cloneNewRepo({
                remoteUrl: formatRemoteUrl(enteredRemoteUrl),
                target,
            });
            refreshDisplayWithDelay();
            // Operation succeeded — hide persistent notice and show success.
            cloneNoticeHandle?.hide();
            plugin.showNotice("Clone completed.", 4000);
        } catch (error) {
            console.error("Failed to clone repo:", error);
            cloneNoticeHandle?.hide();
            plugin.showNotice(
                `Failed to clone repo: ${error instanceof Error ? error.message : String(error)}`,
                7000
            );
        } finally {
            _isCloning = false;
            cloneNoticeHandle = undefined;
        }
    };

    const syncHostedTargetInputs = (
        sourceRemoteUrl: string,
        force = false
    ): void => {
        if (!force && hostedTargetDirty) {
            return;
        }

        const parsedTarget = parseHostedHttpsRemoteUrl(sourceRemoteUrl);
        hostedBaseUrlInput?.setValue(parsedTarget?.baseUrl ?? "");
        hostedNamespacePathInput?.setValue(parsedTarget?.namespacePath ?? "");
        hostedRepositoryInput?.setValue(parsedTarget?.repository ?? "");
        hostedTargetDirty = false;
    };

    const refreshGitSettings = async (
        options: { forceInputs?: boolean; fetchRemoteBranches?: boolean } = {}
    ) => {
        const { forceInputs = false, fetchRemoteBranches = true } = options;
        const state = await getGitSyncSettingsState(plugin);
        remoteName = state.remoteName;
        remoteUrl = state.remoteUrl;

        const currentRemoteNameInput =
            remoteNameInput?.inputEl.value.trim() ?? "";
        const currentRemoteUrlInput =
            remoteUrlInput?.inputEl.value.trim() ?? "";

        if (
            forceInputs ||
            !remoteNameDirty ||
            currentRemoteNameInput === remoteName.trim()
        ) {
            remoteNameInput?.setValue(remoteName);
            remoteNameDirty = false;
        }
        if (
            forceInputs ||
            !remoteUrlDirty ||
            currentRemoteUrlInput === remoteUrl.trim()
        ) {
            remoteUrlInput?.setValue(remoteUrl);
            remoteUrlDirty = false;
        }

        if (forceInputs || currentRemoteUrlInput === remoteUrl.trim()) {
            setRemoteUrlValidation(null);
        }

        syncHostedTargetInputs(remoteUrl, forceInputs);

        if (localBranchDropdown) {
            setDropdownOptions(
                localBranchDropdown,
                buildOptionsFromNames(
                    state.branches,
                    state.headReady
                        ? "No local branches found"
                        : "No local branch yet"
                ),
                state.currentBranch ?? ""
            );
        }

        if (upstreamBranchDropdown) {
            if (!remoteName) {
                setDropdownOptions(upstreamBranchDropdown, {
                    "": "Set a remote first",
                });
                return;
            }
            if (!fetchRemoteBranches) {
                if (state.tracking) {
                    setDropdownOptions(
                        upstreamBranchDropdown,
                        {
                            [state.tracking]: state.tracking,
                        },
                        state.tracking
                    );
                } else {
                    setDropdownOptions(upstreamBranchDropdown, {
                        "": "Refresh remote branches to load options",
                    });
                }
                return;
            }
            try {
                setDropdownOptions(upstreamBranchDropdown, {
                    "": "Fetching from remote...",
                });
                await Promise.race([
                    plugin.gitManager.fetch(remoteName),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error("Fetch timed out")),
                            GIT_OPERATION_TIMEOUT_MS
                        )
                    ),
                ]);
                const remoteBranches =
                    await plugin.gitManager.getRemoteBranches(remoteName);
                const options = buildOptionsFromNames(
                    remoteBranches,
                    "No remote branches found"
                );
                setDropdownOptions(
                    upstreamBranchDropdown,
                    options,
                    state.tracking ?? ""
                );
            } catch (error) {
                setDropdownOptions(upstreamBranchDropdown, {
                    "": `Error: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
    };

    const initializeCurrentVault = async (): Promise<void> => {
        const enteredRemoteName = remoteNameInput?.inputEl.value.trim();
        const enteredRemoteUrl = getEnteredRemoteUrl();
        const normalizedRemoteName =
            enteredRemoteName || remoteName.trim() || "origin";

        try {
            const initialized = await plugin.createNewRepo({
                remoteName: normalizedRemoteName,
                remoteUrl: enteredRemoteUrl,
            });
            if (!initialized) {
                setRemoteUrlValidation(
                    "Initialization failed. Check the Git notice or console output, then try again."
                );
                return;
            }
            await reloadSyncManager();
            setRemoteUrlValidation(
                enteredRemoteUrl
                    ? `Initialized repo and saved remote ${normalizedRemoteName}.`
                    : "Initialized repo. Add a remote URL when you are ready to push."
            );
            refreshDisplayWithDelay();
        } catch (error) {
            console.error("Failed to initialize repo:", error);
            plugin.showNotice(
                `Failed to initialize repo: ${error instanceof Error ? error.message : String(error)}`,
                7000
            );
        }
    };

    const requestGitHubJson = async <T>(
        method: "GET" | "POST",
        path: string,
        token: string,
        body?: Record<string, unknown>
    ): Promise<{ status: number; json?: T; text?: string }> => {
        const response = await requestUrl({
            url: `https://api.github.com${path}`,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: body ? JSON.stringify(body) : undefined,
            throw: false,
            timeout: GIT_OPERATION_TIMEOUT_MS,
        } as RequestUrlParam);

        // Safely surface parsed JSON only when the response appears to be JSON.
        // Use `unknown` and narrow before accessing properties to satisfy
        // strict ESLint/TypeScript rules (avoid `any` and unsafe member access).
        let parsedJson: T | undefined = undefined;
        const respObj = response as unknown;
        const rawText =
            respObj &&
            typeof respObj === "object" &&
            "text" in (respObj as Record<string, unknown>) &&
            typeof (respObj as Record<string, unknown>)["text"] === "string"
                ? ((respObj as Record<string, unknown>)["text"] as string)
                : undefined;

        try {
            const headersRaw =
                respObj &&
                typeof respObj === "object" &&
                "headers" in (respObj as Record<string, unknown>)
                    ? (respObj as Record<string, unknown>)["headers"]
                    : undefined;

            let contentType = "";
            if (headersRaw && typeof headersRaw === "object") {
                // Check for a Fetch-like Headers object with `get()` first
                if (
                    "get" in headersRaw &&
                    typeof (headersRaw as { get?: unknown }).get === "function"
                ) {
                    const getter = (
                        headersRaw as { get: (k: string) => string | null }
                    ).get;
                    contentType = getter("content-type") ?? "";
                } else {
                    // Otherwise treat it as a plain record of strings
                    const hdrs = headersRaw as Record<string, unknown>;
                    const ct = hdrs["content-type"] ?? hdrs["Content-Type"];
                    if (typeof ct === "string") contentType = ct;
                }
            }

            if (contentType && /json/i.test(contentType)) {
                if (
                    respObj &&
                    typeof respObj === "object" &&
                    "json" in (respObj as Record<string, unknown>)
                ) {
                    const candidate = (respObj as Record<string, unknown>)[
                        "json"
                    ];
                    if (candidate !== undefined) {
                        parsedJson = candidate as unknown as T;
                    }
                } else if (typeof rawText === "string" && rawText.length > 0) {
                    try {
                        parsedJson = JSON.parse(rawText) as T;
                    } catch {
                        parsedJson = undefined;
                    }
                }
            }
        } catch {
            // fall back to undefined when anything goes wrong parsing
            parsedJson = undefined;
        }

        // Determine numeric status safely
        const status =
            respObj &&
            typeof respObj === "object" &&
            "status" in (respObj as Record<string, unknown>) &&
            typeof (respObj as Record<string, unknown>)["status"] === "number"
                ? ((respObj as Record<string, unknown>)["status"] as number)
                : 0;

        return {
            status,
            json: parsedJson,
            text: rawText,
        };
    };

    const safeStringify = (value: unknown): string => {
        if (value === undefined) return "";
        if (value === null) return "null";
        if (typeof value === "string") return value;
        if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
        )
            return String(value);
        if (typeof value === "symbol") return value.toString();
        if (typeof value === "object") {
            try {
                return JSON.stringify(value);
            } catch {
                const obj = value as Record<string, unknown>;
                const msg = obj["message"];
                if (typeof msg === "string") return msg;
                return "[object Object]";
            }
        }
        if (typeof value === "function") {
            const fnName = (value as { name?: string }).name;
            return fnName ? `[function ${fnName}]` : "[function]";
        }
        // Fallback: return empty string to avoid unsafe object-to-string conversions
        return "";
    };

    const createPrivateGitHubRepoFromRemote = async (): Promise<void> => {
        const parsedRemote = parseHostedHttpsRemoteUrl(getEnteredRemoteUrl());
        if (
            !parsedRemote ||
            parsedRemote.baseUrl !== "https://github.com" ||
            parsedRemote.namespacePath.includes("/")
        ) {
            setRemoteUrlValidation(
                "Enter an HTTPS GitHub remote URL like https://github.com/owner/repo.git before creating the remote."
            );
            return;
        }

        const token = getStoredGitHttpPassword().trim();
        if (!token) {
            setRemoteUrlValidation(
                "Enter a GitHub personal access token before creating the remote."
            );
            return;
        }

        const owner = parsedRemote.namespacePath;
        const repository = parsedRemote.repository;
        setRemoteUrlValidation("Creating private GitHub repository...");

        try {
            const user = await requestGitHubJson<GitHubUserResponse>(
                "GET",
                "/user",
                token
            );
            if (user.status !== 200 || !user.json?.login) {
                setRemoteUrlValidation(
                    `GitHub authentication failed with status ${user.status}.`
                );
                return;
            }

            const endpoint =
                user.json.login === owner
                    ? "/user/repos"
                    : `/orgs/${encodeURIComponent(owner)}/repos`;
            const created = await requestGitHubJson<GitHubCreateRepoResponse>(
                "POST",
                endpoint,
                token,
                {
                    name: repository,
                    private: true,
                    auto_init: false,
                }
            );

            if (created.status === 201) {
                const cloneUrl =
                    created.json?.clone_url ??
                    buildHostedHttpsRemoteUrl(parsedRemote);
                if (cloneUrl && remoteUrlInput) {
                    remoteUrlInput.setValue(cloneUrl);
                    remoteUrl = cloneUrl;
                    remoteUrlDirty = true;
                }
                setRemoteUrlValidation(
                    `Created private GitHub repository ${owner}/${repository}.`
                );
                plugin.showNotice(
                    `Created private GitHub repository ${owner}/${repository}.`,
                    5000
                );
                return;
            }
            if (created.status === 422) {
                // Extract any structured error details returned by GitHub API
                let details = "";
                try {
                    const body = created.json as unknown;
                    if (body && typeof body === "object") {
                        const asObj = body as Record<string, unknown>;
                        const msg = asObj["message"];
                        if (typeof msg === "string") details += ` ${msg}`;
                        const errs = asObj["errors"];
                        if (errs !== undefined) {
                            try {
                                details += ` ${JSON.stringify(errs)}`;
                            } catch {
                                details += ` ${safeStringify(errs)}`;
                            }
                        }
                    } else if (
                        typeof created.text === "string" &&
                        created.text.length > 0
                    ) {
                        details += ` ${created.text}`;
                    }
                } catch {
                    // ignore parse errors
                }

                setRemoteUrlValidation(
                    `GitHub says ${owner}/${repository} already exists or cannot be created. Continue only if the remote URL is correct.${details ? " Details: " + details.trim() : ""}`
                );
                return;
            }

            // Generic non-OK response: include any returned body/message when available
            {
                let details = "";
                try {
                    const body = created.json as unknown;
                    if (body && typeof body === "object") {
                        const asObj = body as Record<string, unknown>;
                        const msg = asObj["message"];
                        if (typeof msg === "string") details += ` ${msg}`;
                        const errs = asObj["errors"];
                        if (errs !== undefined) {
                            try {
                                details += ` ${JSON.stringify(errs)}`;
                            } catch {
                                details += ` ${safeStringify(errs)}`;
                            }
                        }
                    } else if (
                        typeof created.text === "string" &&
                        created.text.length > 0
                    ) {
                        details += ` ${created.text}`;
                    }
                } catch {
                    // ignore
                }

                setRemoteUrlValidation(
                    `GitHub repository creation failed with status ${created.status}.${details ? " Details: " + details.trim() : ""}`
                );
            }
        } catch (error) {
            // Try to enrich thrown errors with any available response body
            let extra = "";
            try {
                const errObj = error as unknown;
                if (
                    errObj &&
                    typeof errObj === "object" &&
                    "response" in (errObj as Record<string, unknown>)
                ) {
                    const maybeResponse = (errObj as Record<string, unknown>)[
                        "response"
                    ];
                    if (maybeResponse && typeof maybeResponse === "object") {
                        const resp = maybeResponse as Record<string, unknown>;
                        // If `json` is a function (e.g., fetch-like), call it and inspect
                        if (
                            "json" in resp &&
                            typeof resp["json"] === "function"
                        ) {
                            try {
                                const parsed = await (
                                    resp["json"] as () => Promise<unknown>
                                )();
                                if (parsed && typeof parsed === "object") {
                                    const p = parsed as Record<string, unknown>;
                                    const msg = p["message"];
                                    if (typeof msg === "string")
                                        extra += ` ${msg}`;
                                    if (p["errors"] !== undefined) {
                                        try {
                                            extra += ` ${JSON.stringify(p["errors"])}`;
                                        } catch {
                                            extra += ` ${safeStringify(p["errors"])}`;
                                        }
                                    }
                                }
                            } catch {
                                // ignore JSON parse failures
                            }
                        } else if (
                            "json" in resp &&
                            resp["json"] !== undefined
                        ) {
                            const parsed = resp["json"] as unknown;
                            if (parsed && typeof parsed === "object") {
                                const p = parsed as Record<string, unknown>;
                                const msg = p["message"];
                                if (typeof msg === "string") extra += ` ${msg}`;
                                if (p["errors"] !== undefined) {
                                    try {
                                        extra += ` ${JSON.stringify(p["errors"])}`;
                                    } catch {
                                        extra += ` ${safeStringify(p["errors"])}`;
                                    }
                                }
                            }
                        }

                        if (
                            "text" in resp &&
                            typeof resp["text"] === "string"
                        ) {
                            extra += ` ${resp["text"]}`;
                        }
                    }
                }
            } catch {
                // ignore any extraction errors
            }

            setRemoteUrlValidation(
                `GitHub repository creation failed: ${error instanceof Error ? error.message : String(error)}${extra ? " Details: " + extra.trim() : ""}`
            );
        }
    };

    new Setting(containerEl)
        .setName("Connection")
        .setDesc("Configure the remote this vault should sync against.")
        .setHeading();

    new Setting(containerEl)
        .setName("Repository status")
        .setDesc(
            plugin.gitReady
                ? "Uses the local repository at the configured base path."
                : "Ready for setup. This vault does not have an active local Git repository yet."
        );

    new Setting(getAdvancedGitSettingsEl())
        .setName("Remote name")
        .setDesc(
            "Usually `origin`. If you use multiple remotes, enter the one this vault should sync against."
        )
        .addText((t) => {
            remoteNameInput = t;
            t.setPlaceholder("origin");
            t.onChange((value) => {
                remoteNameDirty = true;
                remoteName = value.trim() || "origin";
            });
        })
        .addExtraButton((btn: ExtraButtonComponent) => {
            btn.setIcon("refresh-ccw").setTooltip(
                "Load current Git remote settings"
            );
            styleSettingsRefreshButton(btn);
            btn.onClick(() => {
                void refreshGitSettings({ forceInputs: true }).catch(
                    (error) => {
                        plugin.showNotice(
                            `Failed to refresh Git settings: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                );
            });
        });

    const remoteUrlSetting = new Setting(containerEl)
        .setName("Remote URL")
        .setDesc(
            plugin.useSimpleGit
                ? "Use an HTTPS URL for PAT/credential-helper auth, or an SSH URL such as git@github.com:owner/repo.git for key-based auth."
                : "Use an HTTPS URL. The embedded Git fallback currently expects HTTP auth rather than SSH keys."
        )
        .addText((t) => {
            remoteUrlInput = t;
            t.setPlaceholder("https://github.com/owner/repo.git");
            t.onChange((value) => {
                remoteUrlDirty = true;
                remoteUrl = value.trim();
                setRemoteUrlValidation(null);
            });
        })
        .addButton((button) =>
            button
                .setButtonText(
                    plugin.gitReady ? "Save remote" : "Clone into current vault"
                )
                .onClick(async () => {
                    const enteredRemoteName =
                        remoteNameInput?.inputEl.value.trim();
                    const enteredRemoteUrl =
                        remoteUrlInput?.inputEl.value.trim();
                    const normalizedRemoteName =
                        enteredRemoteName || remoteName.trim() || "origin";
                    const normalizedRemoteUrl =
                        enteredRemoteUrl ?? remoteUrl.trim();
                    if (!normalizedRemoteUrl) {
                        setRemoteUrlValidation(
                            plugin.gitReady
                                ? "Enter a remote URL before saving."
                                : "Enter a remote URL before cloning."
                        );
                        plugin.showNotice(
                            plugin.gitReady
                                ? "Enter a remote URL before saving."
                                : "Enter a remote URL before cloning.",
                            5000
                        );
                        return;
                    }

                    if (!plugin.gitReady) {
                        await cloneFromEnteredRemote("current-vault");
                        return;
                    }

                    try {
                        await plugin.gitManager.setRemote(
                            normalizedRemoteName,
                            formatRemoteUrl(normalizedRemoteUrl)
                        );
                        await reloadSyncManager();
                        await refreshGitSettings({ forceInputs: true });
                        setRemoteUrlValidation(null);
                        plugin.showNotice(
                            `Saved remote ${normalizedRemoteName}.`,
                            4000
                        );
                    } catch (error) {
                        console.error("Failed to save remote:", error);
                        setRemoteUrlValidation(
                            `Failed to save remote: ${error instanceof Error ? error.message : String(error)}`
                        );
                        plugin.showNotice(
                            `Failed to save remote: ${error instanceof Error ? error.message : String(error)}`,
                            7000
                        );
                    }
                })
        );

    remoteUrlValidation.el = remoteUrlSetting.controlEl.createDiv({
        cls: "git-vault-remote-url-validation",
    });

    new Setting(containerEl)
        .setName("Remote check")
        .setDesc(
            plugin.useSimpleGit
                ? "Runs a lightweight Git remote probe against the entered URL using your current system Git credentials, SSH agent, credential helper, or askpass flow."
                : "Runs a lightweight remote probe against the entered HTTP(S) URL using the stored HTTPS credentials for the embedded Git fallback."
        )
        .addButton((button) =>
            button.setButtonText("Check remote").onClick(async () => {
                const enteredRemoteUrl = getEnteredRemoteUrl();
                if (!enteredRemoteUrl) {
                    setRemoteUrlValidation(
                        "Enter a remote URL before checking it."
                    );
                    plugin.showNotice(
                        "Enter a remote URL before checking it.",
                        5000
                    );
                    return;
                }

                const normalizedRemoteUrl = formatRemoteUrl(enteredRemoteUrl);
                setRemoteUrlValidation("Checking remote...");

                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                try {
                    // Centralized timeout with explicit cancellation of the timer
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutHandle = setTimeout(
                            () => reject(new Error("Remote check timed out")),
                            GIT_OPERATION_TIMEOUT_MS
                        );
                    });
                    const remoteBranches = await Promise.race<string[]>([
                        plugin.gitManager
                            .getRemoteBranchesFromUrl(normalizedRemoteUrl)
                            .then((branches) => {
                                clearTimeout(timeoutHandle);
                                return branches;
                            }),
                        timeoutPromise,
                    ]);
                    const branchLabel =
                        remoteBranches.length === 1 ? "branch" : "branches";
                    const summary =
                        remoteBranches.length > 0
                            ? `Remote check succeeded. Found ${remoteBranches.length} ${branchLabel}.`
                            : "Remote check succeeded. The remote responded, but no branches were listed.";
                    setRemoteUrlValidation(summary);
                    plugin.showNotice(summary, 5000);
                } catch (error) {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    const message =
                        error instanceof Error ? error.message : String(error);
                    setRemoteUrlValidation(`Remote check failed: ${message}`);
                    plugin.showNotice(`Remote check failed: ${message}`, 7000);
                }
            })
        );

    new Setting(getAdvancedGitSettingsEl())
        .setName("Hosted HTTPS helper")
        .setDesc(
            "Optional convenience builder for hosted HTTP(S) remotes. The full Remote URL remains the source of truth in Git mode, and repository browsing stays API-only."
        )
        .setHeading();

    new Setting(getAdvancedGitSettingsEl())
        .setName("Base URL")
        .setDesc(
            "Examples: https://github.com, https://gitlab.com, or your self-hosted Git base URL."
        )
        .addText((t) => {
            hostedBaseUrlInput = t;
            t.setPlaceholder("https://github.com");
            t.onChange(() => {
                hostedTargetDirty = true;
            });
        });

    new Setting(getAdvancedGitSettingsEl())
        .setName("Owner / namespace path")
        .setDesc(
            "GitHub uses a single owner. GitLab-style subgroup paths can include `/`, for example `group/subgroup`."
        )
        .addText((t) => {
            hostedNamespacePathInput = t;
            t.setPlaceholder("owner or group/subgroup");
            t.onChange(() => {
                hostedTargetDirty = true;
            });
        });

    new Setting(getAdvancedGitSettingsEl())
        .setName("Repository")
        .setDesc(
            "Repository name only. The helper will build a Git remote URL and write it into the Remote URL field above."
        )
        .addText((t) => {
            hostedRepositoryInput = t;
            t.setPlaceholder("repo");
            t.onChange(() => {
                hostedTargetDirty = true;
            });
        });

    new Setting(getAdvancedGitSettingsEl())
        .setName("Remote helper actions")
        .setDesc(
            "Use the helper to compose a hosted HTTP(S) remote URL. Use the full Remote URL field for SSH or other non-HTTP transports."
        )
        .addButton((button) =>
            button.setButtonText("Load from remote URL").onClick(() => {
                const parsedTarget = parseHostedHttpsRemoteUrl(
                    getEnteredRemoteUrl()
                );

                if (!parsedTarget) {
                    setRemoteUrlValidation(
                        "The current remote URL is not a parseable HTTP(S) hosted Git URL."
                    );
                    plugin.showNotice(
                        "The current remote URL is not a parseable HTTP(S) hosted Git URL.",
                        7000
                    );
                    return;
                }

                hostedBaseUrlInput?.setValue(parsedTarget.baseUrl);
                hostedNamespacePathInput?.setValue(parsedTarget.namespacePath);
                hostedRepositoryInput?.setValue(parsedTarget.repository);
                hostedTargetDirty = false;
                setRemoteUrlValidation(
                    "Loaded hosted HTTP(S) fields from the current remote URL."
                );
            })
        )
        .addButton((button) =>
            button.setButtonText("Apply to remote URL").onClick(() => {
                const builtRemoteUrl = buildHostedHttpsRemoteUrl({
                    baseUrl: hostedBaseUrlInput?.inputEl.value ?? "",
                    namespacePath:
                        hostedNamespacePathInput?.inputEl.value ?? "",
                    repository: hostedRepositoryInput?.inputEl.value ?? "",
                });

                if (!builtRemoteUrl) {
                    setRemoteUrlValidation(
                        "Base URL, owner or namespace path, and repository are all required to build a hosted HTTP(S) remote URL."
                    );
                    plugin.showNotice(
                        "Base URL, owner or namespace path, and repository are all required to build a hosted HTTP(S) remote URL.",
                        7000
                    );
                    return;
                }

                if (remoteUrlInput) {
                    remoteUrlInput.setValue(builtRemoteUrl);
                    remoteUrl = builtRemoteUrl;
                    remoteUrlDirty = true;
                    hostedTargetDirty = false;
                    setRemoteUrlValidation(
                        plugin.gitReady
                            ? "Updated the Remote URL field from the hosted HTTP(S) helper. Save remote to persist it."
                            : "Updated the Remote URL field from the hosted HTTP(S) helper. Clone repo to use it."
                    );
                } else {
                    // Guard updates when the Remote URL input is not present
                    // (defensive: avoid diverging UI/internal state).
                    setRemoteUrlValidation(
                        "Remote URL field not available in this UI. Open settings to edit and save the remote."
                    );
                    plugin.showNotice(
                        "Remote URL field not available; open settings to edit and save the remote.",
                        7000
                    );
                }
            })
        );

    new Setting(containerEl)
        .setName("Authentication")
        .setDesc(
            "Credentials used for HTTPS remotes and the embedded Git fallback."
        )
        .setHeading();

    new Setting(containerEl).setName("Authentication status").setDesc(
        getGitAuthStatusDescription({
            useSimpleGit: plugin.useSimpleGit,
            username: getStoredGitHttpUsername(),
            password: getStoredGitHttpPassword(),
        })
    );

    new Setting(containerEl)
        .setName("Username")
        .setDesc(
            plugin.providerSecrets.isSupported()
                ? "Stored in Obsidian secret storage on this device. Used for HTTPS remotes and authentication with the embedded Git fallback."
                : "Stored in local Obsidian storage because secure secret storage is unavailable in this runtime."
        )
        .addText((t) => {
            t.setValue(getStoredGitHttpUsername());
            t.setPlaceholder("your-username");
            t.onChange((value) => {
                setStoredGitHttpUsername(value.trim());
            });
        });

    new Setting(containerEl)
        .setName("Personal access token / password")
        .setDesc(
            plugin.providerSecrets.isSupported()
                ? "Used for HTTPS remotes and the embedded Git fallback; stored in Obsidian secret storage on this device. Prefer a PAT over an account password whenever your Git host supports it."
                : "Used for HTTPS remotes and the embedded Git fallback; stored in local Obsidian storage because secure secret storage is unavailable in this runtime."
        )
        .addText((t) => {
            t.inputEl.type = "password";
            t.inputEl.autocapitalize = "off";
            t.inputEl.autocomplete = "off";
            t.inputEl.spellcheck = false;
            gitHttpPasswordInput = t;
            t.setValue(getStoredGitHttpPassword());
            t.setPlaceholder("token");
            t.onChange((value) => {
                setStoredGitHttpPassword(value.trim());
            });
        })
        .addExtraButton((button) => {
            queueMicrotask(() => {
                if (!gitHttpPasswordInput) {
                    console.warn(
                        "[Git Vault] gitHttpPasswordInput not available for secure-field reveal wiring"
                    );
                    return;
                }
                wireSecureFieldReveal(button, gitHttpPasswordInput);
            });
        });

    if (!plugin.gitReady) {
        new Setting(containerEl)
            .setName("Repository setup")
            .setDesc(
                "Use the fields above for the GitHub, GitLab, Gitea, or self-hosted Git remote. Initialize creates a repo in the current vault and saves the remote URL if one is entered."
            )
            .setHeading();

        new Setting(containerEl)
            .setName("Initialize and publish this vault")
            .setDesc(
                "Start Git in the current vault and save the Remote URL as the push target."
            )
            .addButton((button) =>
                button
                    .setButtonText("Initialize current vault")
                    .setCta()
                    .onClick(async () => {
                        await initializeCurrentVault();
                    })
            );

        new Setting(containerEl)
            .setName("Create private GitHub remote")
            .setDesc(
                "For HTTPS GitHub remotes. Enter Remote URL and PAT above, create the private repository, then initialize this vault."
            )
            .addButton((button) =>
                button
                    .setButtonText("Create private repo")
                    .onClick(async () => {
                        await createPrivateGitHubRepoFromRemote();
                    })
            );

        new Setting(containerEl)
            .setName("Clone an existing remote")
            .setDesc(
                "Use the Remote URL above to clone into this vault or create a separate Obsidian vault for the cloned repo."
            )
            .addButton((button) =>
                button
                    .setButtonText("Clone into current vault")
                    .onClick(async () => {
                        await cloneFromEnteredRemote("current-vault");
                    })
            )
            .addButton((button) =>
                button
                    .setButtonText("Clone as separate vault")
                    .onClick(async () => {
                        await cloneFromEnteredRemote("dedicated-vault");
                    })
            );

        void refreshGitSettings({
            forceInputs: false,
            fetchRemoteBranches: false,
        }).catch((error) => {
            plugin.showNotice(
                `Failed to initialize Git settings: ${error instanceof Error ? error.message : String(error)}`,
                6000
            );
        });
        return;
    }

    new Setting(getAdvancedGitSettingsEl())
        .setName("Branch tracking")
        .setDesc("Choose the local branch and its upstream remote branch.")
        .setHeading();

    new Setting(getAdvancedGitSettingsEl())
        .setName("Local branch")
        .setDesc(
            "Select the local branch to operate on. If the repo has no commits yet, create or check out a branch first."
        )
        .addDropdown((dd) => {
            localBranchDropdown = dd;
            dd.addOptions({ "": "Loading branches..." });
            dd.setValue("");
            dd.onChange((value) => {
                if (!value) return;
                void plugin.promiseQueue.addTask(async () => {
                    try {
                        await plugin.gitManager.checkout(value);
                        plugin.displayMessage(`Switched to ${value}`);
                        await plugin.notifyIfNonDefaultTrackingBranch();
                        plugin.app.workspace.trigger("obsidian-git:refresh");
                        await reloadSyncManager();
                        await refreshGitSettings({ forceInputs: true });
                    } catch (error) {
                        plugin.displayError(error);
                    }
                });
            });
        })
        .addExtraButton((btn: ExtraButtonComponent) => {
            btn.setIcon("refresh-ccw").setTooltip("Refresh local branches");
            styleSettingsRefreshButton(btn);
            btn.onClick(() => {
                void refreshGitSettings({
                    forceInputs: true,
                    fetchRemoteBranches: false,
                }).catch((error) => {
                    plugin.showNotice(
                        `Failed to refresh branches: ${error instanceof Error ? error.message : String(error)}`
                    );
                });
            });
        });

    new Setting(getAdvancedGitSettingsEl())
        .setName("Upstream branch")
        .setDesc(
            "Remote tracking branch used by pull/push. Save the remote first if nothing appears here."
        )
        .addDropdown((dd) => {
            upstreamBranchDropdown = dd;
            dd.addOptions({ "": "Loading remote branches..." });
            dd.setValue("");
            dd.onChange((value) => {
                if (!value) return;
                void plugin.promiseQueue.addTask(async () => {
                    try {
                        await plugin.gitManager.updateUpstreamBranch(value);
                        plugin.displayMessage(
                            `Set upstream branch to ${value}`
                        );
                        await plugin.notifyIfNonDefaultTrackingBranch();
                        await reloadSyncManager();
                        await refreshGitSettings({ forceInputs: true });
                    } catch (error) {
                        plugin.displayError(error);
                    }
                });
            });
        })
        .addExtraButton((btn: ExtraButtonComponent) => {
            btn.setIcon("refresh-ccw").setTooltip("Refresh remote branches");
            styleSettingsRefreshButton(btn);
            btn.onClick(() => {
                void refreshGitSettings({ forceInputs: true }).catch(
                    (error) => {
                        plugin.showNotice(
                            `Failed to refresh remote branches: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                );
            });
        });

    void refreshGitSettings({
        forceInputs: false,
        fetchRemoteBranches: false,
    }).catch((error) => {
        plugin.showNotice(
            `Failed to initialize Git settings: ${error instanceof Error ? error.message : String(error)}`,
            6000
        );
    });
}
