import { expect, test, type Page } from "@playwright/test";
import {
    PLUGIN_ID,
    ProviderSettingsPage,
    launchObsidianApp,
    openSourceControlView,
    prepareTestVault,
    readSecretsSafely,
    type LaunchedObsidian,
    type PreparedVault,
    type ProviderSecretsFixture,
} from "../helpers/obsidian";

const secrets = readSecretsSafely();

type ApiProvider = "github" | "gitlab" | "gitea";

type HostedBranchFixture = {
    provider: ApiProvider;
    baseBranch: string;
    branch: string;
    cleanup: () => Promise<void>;
};

type HttpMethod = "GET" | "POST" | "DELETE";

test.describe("Hosted API provider branch fixtures", () => {
    test.setTimeout(240_000);

    for (const provider of ["github", "gitlab", "gitea"] as const) {
        test(`${provider} creates, selects, switches, and deletes a temporary branch`, async () => {
            let fixture: HostedBranchFixture | undefined;

            try {
                const createdFixture = await createHostedBranchFixture(
                    provider,
                    secrets
                );
                fixture = createdFixture;
                await withVault(async ({ session }) => {
                    const settings = new ProviderSettingsPage(session.page);

                    await settings.open();
                    await configureProviderForBranch(
                        settings,
                        provider,
                        createdFixture.branch,
                        createdFixture.baseBranch
                    );
                    await settings.dismissRemoteActionModalIfVisible();

                    await switchBranchFromPluginSwitcher(
                        session.page,
                        createdFixture.branch
                    );
                    await expectActiveBranch(
                        session.page,
                        provider,
                        createdFixture.branch
                    );

                    await session.audit.assertClean();
                });
            } finally {
                await fixture?.cleanup();
            }
        });
    }
});

async function withVault(
    run: (args: { vault: PreparedVault; session: LaunchedObsidian }) => Promise<void>
): Promise<void> {
    const vault = prepareTestVault(secrets);
    let session: LaunchedObsidian | undefined;

    try {
        session = await launchObsidianApp(
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        await run({ vault, session });
    } finally {
        await session?.close().catch(() => undefined);
        await vault.cleanup().catch(() => undefined);
    }
}

async function configureProviderForBranch(
    settings: ProviderSettingsPage,
    provider: ApiProvider,
    branch: string,
    baseBranch: string
): Promise<void> {
    if (provider === "github") {
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", branch);
        await settings.selectDropdown("Branch", baseBranch);
        return;
    }

    if (provider === "gitlab") {
        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", branch, 60_000);
        await settings.selectDropdown("Branch", baseBranch);
        return;
    }

    await settings.selectSyncBackend("gitea");
    await settings.fillText("Access token", secrets.gitea.token, {
        sensitive: true,
    });
    await settings.fillText("Server URL", secrets.gitea.baseUrl);
    await settings.fillText("Owner / namespace", secrets.gitea.owner);
    await settings.clickExtraButton("Repository");
    await settings.waitForDropdownOption("Repository", secrets.gitea.repo);
    await settings.selectDropdown("Repository", secrets.gitea.repo);
    await settings.clickExtraButton("Branch");
    await settings.waitForDropdownOption("Branch", branch);
    await settings.selectDropdown("Branch", baseBranch);
}

async function switchBranchFromPluginSwitcher(
    page: Page,
    branch: string
): Promise<void> {
    await dismissRemoteActionModalIfPresent(page);
    await openSourceControlView(page);
    await dismissRemoteActionModalIfPresent(page);
    await page.evaluate(async (pluginId) => {
        const plugin = (window as typeof window & {
            app?: {
                plugins?: {
                    plugins?: Record<
                        string,
                        {
                            branchBar?: {
                                display?: () => Promise<void> | void;
                            };
                        }
                    >;
                };
            };
        }).app?.plugins?.plugins?.[pluginId];
        await plugin?.branchBar?.display?.();
    }, PLUGIN_ID);

    const branchSelector = page
        .locator('[data-git-vault-branch-selector="true"]')
        .first();
    await expect(branchSelector).toBeVisible({ timeout: 30_000 });
    await expect
        .poll(
            () => branchSelector.getAttribute("data-git-vault-branch-state"),
            { timeout: 30_000 }
        )
        .toBe("ready");
    await expect
        .poll(
            () =>
                branchSelector.evaluate((element, targetBranch) => {
                    const select = element as HTMLSelectElement;
                    return Array.from(select.options).some(
                        (option) => option.value === targetBranch
                    );
                }, branch),
            { timeout: 30_000 }
        )
        .toBe(true);
    await dismissRemoteActionModalIfPresent(page);
    await branchSelector.selectOption(branch);

    await expect
        .poll(() => currentBranch(page), { timeout: 60_000 })
        .toBe(branch);
}

async function dismissRemoteActionModalIfPresent(page: Page): Promise<void> {
    const modal = page.locator(".git-vault-remote-action-modal").first();
    if (!(await modal.isVisible().catch(() => false))) {
        return;
    }

    const cancelButton = modal
        .locator('button[data-git-vault-action="cancel"]')
        .first();
    if (await cancelButton.isVisible().catch(() => false)) {
        await cancelButton.click();
    } else {
        await page.keyboard.press("Escape");
    }
    await expect(modal).toBeHidden({ timeout: 10_000 });
}

async function expectActiveBranch(
    page: Page,
    provider: ApiProvider,
    branch: string
): Promise<void> {
    await expect.poll(() => currentBranch(page), { timeout: 30_000 }).toBe(branch);
    await expect
        .poll(
            () =>
                page.evaluate(
                    ({ pluginId, settingKey }) => {
                        const plugin = (window as typeof window & {
                            app?: {
                                plugins?: {
                                    plugins?: Record<
                                        string,
                                        { settings?: Record<string, unknown> }
                                    >;
                                };
                            };
                        }).app?.plugins?.plugins?.[pluginId];
                        return plugin?.settings?.[settingKey] ?? "";
                    },
                    {
                        pluginId: PLUGIN_ID,
                        settingKey: `${provider}Branch`,
                    }
                ),
            { timeout: 30_000 }
        )
        .toBe(branch);
}

async function currentBranch(page: Page): Promise<string> {
    return page.evaluate(async (pluginId) => {
        const plugin = (window as typeof window & {
            app?: {
                plugins?: {
                    plugins?: Record<
                        string,
                        {
                            syncManager?: {
                                getBranchSelection?: () => Promise<{
                                    current: string;
                                }>;
                            };
                        }
                    >;
                };
            };
        }).app?.plugins?.plugins?.[pluginId];
        return (
            (await plugin?.syncManager?.getBranchSelection?.())?.current ?? ""
        );
    }, PLUGIN_ID);
}

async function createHostedBranchFixture(
    provider: ApiProvider,
    fixture: ProviderSecretsFixture
): Promise<HostedBranchFixture> {
    const branch = `git-vault-e2e-${provider}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    if (provider === "github") {
        await createGitHubBranch(fixture.github, branch);
        return {
            provider,
            baseBranch: fixture.github.branch,
            branch,
            cleanup: () => deleteGitHubBranch(fixture.github, branch),
        };
    }

    if (provider === "gitlab") {
        await createGitLabBranch(fixture.gitlab, branch);
        return {
            provider,
            baseBranch: fixture.gitlab.branch,
            branch,
            cleanup: () => deleteGitLabBranch(fixture.gitlab, branch),
        };
    }

    await createGiteaBranch(fixture.gitea, branch);
    return {
        provider,
        baseBranch: fixture.gitea.branch,
        branch,
        cleanup: () => deleteGiteaBranch(fixture.gitea, branch),
    };
}

async function createGitHubBranch(
    fixture: ProviderSecretsFixture["github"],
    branch: string
): Promise<void> {
    const ref = await githubRequest<{ object: { sha: string } }>(
        fixture,
        "GET",
        `/repos/${fixture.owner}/${fixture.repo}/git/ref/heads/${encodePathRef(
            fixture.branch
        )}`
    );
    await githubRequest(
        fixture,
        "POST",
        `/repos/${fixture.owner}/${fixture.repo}/git/refs`,
        {
            ref: `refs/heads/${branch}`,
            sha: ref.object.sha,
        }
    );
}

async function deleteGitHubBranch(
    fixture: ProviderSecretsFixture["github"],
    branch: string
): Promise<void> {
    await githubRequest<void>(
        fixture,
        "DELETE",
        `/repos/${fixture.owner}/${fixture.repo}/git/refs/heads/${encodePathRef(
            branch
        )}`,
        undefined,
        [204, 404]
    );
}

async function createGitLabBranch(
    fixture: ProviderSecretsFixture["gitlab"],
    branch: string
): Promise<void> {
    const projectId = encodeURIComponent(fixture.projectId);
    const query = `branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(
        fixture.branch
    )}`;
    const created = await gitlabRequest<{ name?: string }>(
        fixture,
        "POST",
        `/projects/${projectId}/repository/branches?${query}`
    );
    expect(created.name).toBe(branch);
    await waitForGitLabBranch(fixture, branch);
    await waitForGitLabBranchList(fixture, branch);
}

async function deleteGitLabBranch(
    fixture: ProviderSecretsFixture["gitlab"],
    branch: string
): Promise<void> {
    const projectId = encodeURIComponent(fixture.projectId);
    await gitlabRequest<void>(
        fixture,
        "DELETE",
        `/projects/${projectId}/repository/branches/${encodeURIComponent(
            branch
        )}`,
        undefined,
        [204, 404]
    );
}

async function waitForGitLabBranch(
    fixture: ProviderSecretsFixture["gitlab"],
    branch: string
): Promise<void> {
    const projectId = encodeURIComponent(fixture.projectId);
    const encodedBranch = encodeURIComponent(branch);
    const deadline = Date.now() + 60_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            await gitlabRequest(
                fixture,
                "GET",
                `/projects/${projectId}/repository/branches/${encodedBranch}`
            );
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Timed out waiting for GitLab branch fixture ${branch}.`);
}

async function waitForGitLabBranchList(
    fixture: ProviderSecretsFixture["gitlab"],
    branch: string
): Promise<void> {
    const projectId = encodeURIComponent(fixture.projectId);
    const deadline = Date.now() + 60_000;
    let lastBranchNames: string[] = [];
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const branches = await gitlabRequest<Array<{ name?: string }>>(
                fixture,
                "GET",
                `/projects/${projectId}/repository/branches?per_page=100`
            );
            lastBranchNames = branches
                .map((candidate) => candidate.name ?? "")
                .filter((name) => name.length > 0);
            if (lastBranchNames.includes(branch)) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const observed = lastBranchNames.length
        ? lastBranchNames.join(", ")
        : "none";
    throw lastError instanceof Error
        ? lastError
        : new Error(
              `Timed out waiting for GitLab branch list to include ${branch}. Last branches: ${observed}`
          );
}

async function createGiteaBranch(
    fixture: ProviderSecretsFixture["gitea"],
    branch: string
): Promise<void> {
    await giteaRequest(fixture, "POST", `/repos/${fixture.owner}/${fixture.repo}/branches`, {
        new_branch_name: branch,
        old_branch_name: fixture.branch,
    });
}

async function deleteGiteaBranch(
    fixture: ProviderSecretsFixture["gitea"],
    branch: string
): Promise<void> {
    await giteaRequest<void>(
        fixture,
        "DELETE",
        `/repos/${fixture.owner}/${fixture.repo}/branches/${encodeURIComponent(
            branch
        )}`,
        undefined,
        [204, 404]
    );
}

async function githubRequest<T = unknown>(
    fixture: ProviderSecretsFixture["github"],
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
    expectedStatuses = [200, 201]
): Promise<T> {
    return providerRequest<T>({
        url: `https://api.github.com${apiPath}`,
        method,
        headers: {
            Authorization: `Bearer ${fixture.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body,
        expectedStatuses,
    });
}

async function gitlabRequest<T = unknown>(
    fixture: ProviderSecretsFixture["gitlab"],
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
    expectedStatuses = [200, 201]
): Promise<T> {
    return providerRequest<T>({
        url: `${normalizeBaseUrl(fixture.baseUrl, "/api/v4")}${apiPath}`,
        method,
        headers: {
            "PRIVATE-TOKEN": fixture.token,
        },
        body,
        expectedStatuses,
    });
}

async function giteaRequest<T = unknown>(
    fixture: ProviderSecretsFixture["gitea"],
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
    expectedStatuses = [200, 201]
): Promise<T> {
    return providerRequest<T>({
        url: `${normalizeBaseUrl(fixture.baseUrl, "/api/v1")}${apiPath}`,
        method,
        headers: {
            Authorization: `token ${fixture.token}`,
            Accept: "application/json",
        },
        body,
        expectedStatuses,
    });
}

async function providerRequest<T>(
    {
        url,
        method,
        headers,
        body,
        expectedStatuses,
    }: {
        url: string;
        method: HttpMethod;
        headers: Record<string, string>;
        body?: unknown;
        expectedStatuses: number[];
    }
): Promise<T>;
async function providerRequest(
    {
        url,
        method,
        headers,
        body,
        expectedStatuses,
    }: {
        url: string;
        method: HttpMethod;
        headers: Record<string, string>;
        body?: unknown;
        expectedStatuses: number[];
    }
): Promise<void>;
async function providerRequest<T>({
    url,
    method,
    headers,
    body,
    expectedStatuses,
}: {
    url: string;
    method: HttpMethod;
    headers: Record<string, string>;
    body?: unknown;
    expectedStatuses: number[];
}): Promise<T | void> {
    const response = await fetch(url, {
        method,
        headers:
            body === undefined
                ? headers
                : {
                      ...headers,
                      "Content-Type": "application/json",
                  },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!expectedStatuses.includes(response.status)) {
        throw new Error(
            `${method} ${redactProviderUrl(url)} failed with HTTP ${
                response.status
            }: ${(await response.text()).slice(0, 300)}`
        );
    }

    if (response.status === 204) {
        return undefined;
    }

    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

function normalizeBaseUrl(value: string, apiSuffix: string): string {
    const trimmed = value.replace(/\/+$/u, "");
    return trimmed.endsWith(apiSuffix) ? trimmed : `${trimmed}${apiSuffix}`;
}

function encodePathRef(ref: string): string {
    return ref.split("/").map(encodeURIComponent).join("/");
}

function redactProviderUrl(value: string): string {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
}
