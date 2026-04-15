import * as fsPromises from "fs/promises";
import * as path from "path";
import type ObsidianGit from "src/main";
import { PlatformGuard } from "src/platform/platformGuard";
import type { IPluginContext } from "src/pluginContext";
import { fingerprintsMatch } from "src/syncProvider/repoIdentity";
import {
    ApiRemoteActionModal,
    type ApiRemoteActionOption,
} from "src/ui/modals/apiRemoteActionModal";
import type { RepoBindingService } from "./repoBindingService";

type RemoteTargetDecision =
    | {
          kind: "new-target";
          fingerprint: string;
      }
    | {
          kind: "current-vault-linked";
          fingerprint: string;
      }
    | {
          kind: "external-vault-linked";
          fingerprint: string;
          vaultPath: string;
          deeplinkVaultName: string;
      };

type RegisteredVaultEntry = {
    path: string;
    ts?: number;
    open?: boolean;
};

type ObsidianRegistry = {
    vaults?: Record<string, RegisteredVaultEntry>;
};

// Backward compatibility for vaults created before the plugin id was renamed.
const FALLBACK_PLUGIN_ID = "obsidian-git-vault";

function assertUnreachable(value: never): never {
    throw new Error(`Unexpected value: ${String(value)}`);
}

/**
 * Sanitize an absolute filesystem path coming from an external source
 * (e.g., Obsidian registry). Returns a canonical absolute path string
 * constructed from validated segments, or `null` if the input is invalid.
 *
 * Notes:
 * - This function intentionally does not call `fs.realpath()` so it does
 *   not dereference symlinks.  Callers may `realpath()` later if they
 *   need to follow symlinks for legitimate reasons, but string values
 *   returned from this function are safe to use for path comparisons
 *   and for constructing child paths.
 */
function sanitizeAbsolutePath(candidate: string): string | null {
    if (!candidate || typeof candidate !== "string") return null;
    const normalized = path.normalize(candidate);
    // Reject obvious injects (null bytes)
    if (normalized.includes("\0")) return null;
    // Require absolute paths only
    if (!path.isAbsolute(normalized)) return null;
    // Split into path segments and reject upward-traversal or relative markers
    const segments = normalized.split(path.sep).filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    if (segments.includes("..") || segments.includes(".")) return null;
    // Allow a conservative set of characters in each segment to reduce
    // risk of surprises while still permitting common names. Use Unicode
    // letter/number classes to support non-ASCII names.
    // Also permit common safe filename characters: @ # ( ) + = ' !
    const segmentRegex = /^[\p{L}\p{N}._\-\s@#()+='!]+$/u;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.length > 255) return null;
        // Allow Windows drive-letter (e.g. "C:") as the first segment
        if (i === 0 && /^[A-Za-z]:$/.test(seg)) {
            continue;
        }
        if (!segmentRegex.test(seg)) return null;
    }
    // Return the normalized absolute path (segments already validated).
    // Avoid calling `path.join`/`path.resolve` on untrusted segments to
    // prevent dataflow-based static warnings; `normalized` is already
    // cleaned and verified above.
    return normalized;
}

export class ApiRemoteTargetWorkflow {
    constructor(
        private readonly plugin: IPluginContext,
        private readonly getConcretePlugin: () => ObsidianGit,
        private readonly repoBinding: RepoBindingService,
        private readonly runProviderBootstrapOrSync: () => Promise<void>,
        private readonly importActiveApiRepoAsDedicatedVault: () => Promise<void>,
        private readonly resetEncryptionBindingForCurrentRepo: () => Promise<void>
    ) {}

    async run(): Promise<void> {
        const decision = await this.describeCurrentTarget();
        if (!decision) {
            this.plugin.makeSyncNotice(
                "Git Vault: finish selecting an API provider, repository/project, and branch first.",
                7000
            );
            return;
        }

        const action = await new ApiRemoteActionModal(
            this.getConcretePlugin(),
            "Use Selected Remote",
            this.buildDecisionDescription(decision),
            this.buildDecisionOptions(decision)
        ).openAndGetResult();

        switch (action) {
            case "import-current-vault":
            case "update-current-vault":
                await this.runProviderBootstrapOrSync();
                return;
            case "import-dedicated-vault":
                await this.importActiveApiRepoAsDedicatedVault();
                return;
            case "open-existing-vault":
                if (decision.kind === "external-vault-linked") {
                    await this.openVault(
                        decision.vaultPath,
                        decision.deeplinkVaultName
                    );
                }
                return;
            case "open-and-update-existing-vault":
                if (decision.kind === "external-vault-linked") {
                    // Queue a pending sync request and attempt to open the vault.
                    // We will clear the pending request on both success and failure
                    // of opening the vault to avoid leaving orphaned requests.
                    this.getConcretePlugin().localStorage.setPendingVaultSyncRequest(
                        {
                            action: "sync-existing-vault",
                            vaultPath: decision.vaultPath,
                            fingerprint: decision.fingerprint,
                            requestedAt: Date.now(),
                        }
                    );
                    try {
                        await this.openVault(
                            decision.vaultPath,
                            decision.deeplinkVaultName,
                            {
                                shouldSyncAfterOpen: true,
                            }
                        );
                        // Leave the pending request in local storage so the
                        // newly opened matching vault can consume it on load.
                        // It is cleared by takePendingVaultSyncRequestForPath()
                        // or by the failure path below.
                    } catch (error) {
                        // Clear the pending request on failure as well and surface error.
                        this.getConcretePlugin().localStorage.setPendingVaultSyncRequest(
                            null
                        );
                        this.getConcretePlugin().displayError(error);
                    }
                }
                return;
            case "forget-encryption-binding":
                await this.resetEncryptionBindingForCurrentRepo();
                return;
            case "cancel":
                return;
            default: {
                if (process.env.NODE_ENV !== "production") {
                    assertUnreachable(action);
                }
                console.warn(
                    `ApiRemoteTargetWorkflow: unexpected remote action ${String(action)}`
                );
                return;
            }
        }
    }

    async describeCurrentTarget(): Promise<RemoteTargetDecision | null> {
        const fingerprint = this.repoBinding.computeActiveApiRepoFingerprint();
        if (!fingerprint) {
            return null;
        }

        if (!(await this.repoBinding.shouldBootstrapApiProvider())) {
            return {
                kind: "current-vault-linked",
                fingerprint,
            };
        }

        const externalVaultInfo =
            await this.findRegisteredVaultWithFingerprint(fingerprint);
        if (externalVaultInfo) {
            return {
                kind: "external-vault-linked",
                fingerprint,
                vaultPath: externalVaultInfo.vaultPath,
                deeplinkVaultName: externalVaultInfo.deeplinkVaultName,
            };
        }

        return {
            kind: "new-target",
            fingerprint,
        };
    }

    private buildDecisionDescription(decision: RemoteTargetDecision): string {
        switch (decision.kind) {
            case "new-target":
                return "Choose how Git Vault should use the selected remote. Importing into the current vault establishes a pull-first baseline before any push resumes.";
            case "current-vault-linked":
                return "This vault is already linked to the selected remote target. Update it now, and Git Vault will surface conflicts if local and remote changes diverge.";
            case "external-vault-linked":
                return `A matching local vault already exists at ${decision.vaultPath}. Open it as-is, open it and update that local copy now, or import the selected remote into the current vault instead.`;
        }
    }

    private buildDecisionOptions(
        decision: RemoteTargetDecision
    ): ApiRemoteActionOption[] {
        switch (decision.kind) {
            case "new-target":
                return [
                    {
                        action: "import-current-vault",
                        label: "Import into current vault",
                        description:
                            "Pull the selected remote into the vault that is currently open.",
                        cta: true,
                    },
                    {
                        action: "import-dedicated-vault",
                        label: "Clone as dedicated vault",
                        description:
                            "Download the selected remote into a separate folder so it can be opened as its own Obsidian vault.",
                    },
                    {
                        action: "cancel",
                        label: "Cancel",
                        description:
                            "Keep the selected target in settings but do nothing for now.",
                    },
                ];
            case "current-vault-linked":
                return [
                    {
                        action: "update-current-vault",
                        label: "Update this vault",
                        description:
                            "Run the normal sync/update flow against the selected remote target.",
                        cta: true,
                    },
                    {
                        action: "forget-encryption-binding",
                        label: "Forget encryption binding",
                        description:
                            "Clear this device's stored encrypted-sync binding for the selected repo and disable encrypted API sync.",
                    },
                    {
                        action: "cancel",
                        label: "Cancel",
                        description:
                            "Leave the current vault unchanged for now.",
                    },
                ];
            case "external-vault-linked":
                return [
                    {
                        action: "open-existing-vault",
                        label: "Open existing vault",
                        description:
                            "Switch to the already known local vault for this remote target without changing it yet.",
                        cta: true,
                    },
                    {
                        action: "open-and-update-existing-vault",
                        label: "Open and update existing vault",
                        description:
                            "Switch to the linked local vault and run Git Vault there as soon as it opens.",
                    },
                    {
                        action: "import-current-vault",
                        label: "Use current vault instead",
                        description:
                            "Replace this vault's baseline with the selected remote instead of switching vaults.",
                    },
                    {
                        action: "forget-encryption-binding",
                        label: "Forget encryption binding",
                        description:
                            "Clear this device's stored encrypted-sync binding for the selected repo and disable encrypted API sync.",
                    },
                    {
                        action: "cancel",
                        label: "Cancel",
                        description:
                            "Keep the target selection but do nothing for now.",
                    },
                ];
        }
    }

    private async findRegisteredVaultWithFingerprint(
        targetFingerprint: string
    ): Promise<{ vaultPath: string; deeplinkVaultName: string } | null> {
        const adapter = this.plugin.app.vault.adapter as {
            getBasePath?: () => string;
            basePath?: string;
        };
        const basePath =
            typeof adapter.getBasePath === "function"
                ? adapter.getBasePath()
                : typeof adapter.basePath === "string"
                  ? adapter.basePath
                  : null;
        if (!basePath) {
            return null;
        }

        const currentVaultPath = path.resolve(basePath);
        const registry = await this.readObsidianRegistry();
        const vaultEntries = Object.entries(registry.vaults ?? {});

        for (const [vaultId, entry] of vaultEntries) {
            if (!entry?.path) {
                continue;
            }

            // Sanitize and canonicalize registry-provided path without resolving
            // symlinks. Let the central sanitizer handle null-bytes, absoluteness,
            // and segment checks to avoid duplicating validation logic here.
            const rawEntryPath = entry.path;
            const sanitizedCandidate = sanitizeAbsolutePath(rawEntryPath);
            if (!sanitizedCandidate) {
                continue;
            }
            const candidatePath = sanitizedCandidate;

            if (candidatePath === currentVaultPath) {
                continue;
            }

            const fingerprint = await this.readVaultFingerprint(candidatePath);
            if (
                fingerprint &&
                fingerprintsMatch(fingerprint, targetFingerprint)
            ) {
                return {
                    vaultPath: candidatePath,
                    // Obsidian's URL handler expects the visible vault name,
                    // not the registry key. Use the sanitized candidate path
                    // so an invalid registry entry cannot influence the link.
                    deeplinkVaultName: path.basename(candidatePath) || vaultId,
                };
            }
        }

        return null;
    }

    private async readVaultFingerprint(
        vaultPath: string
    ): Promise<string | null> {
        const pluginIds = [
            this.getConcretePlugin().manifest.id,
            FALLBACK_PLUGIN_ID,
        ];

        const sanitizedVaultPath = sanitizeAbsolutePath(vaultPath);
        if (!sanitizedVaultPath) {
            // Invalid or suspicious input; bail out early rather than
            // re-running sanitization for each plugin id.
            return null;
        }

        // Canonicalize the vault path once. When realpath fails (non-existent
        // path), fall back to the sanitized path rather than resolving the
        // original untrusted input.
        let vaultRealPath: string;
        try {
            vaultRealPath = await fsPromises.realpath(sanitizedVaultPath);
        } catch (_) {
            vaultRealPath = sanitizedVaultPath;
        }

        for (const pluginId of pluginIds) {
            const dataPath = path.join(
                vaultRealPath,
                ".obsidian",
                "plugins",
                pluginId,
                "data.json"
            );
            try {
                const raw = await fsPromises.readFile(dataPath, "utf8");
                const parsed = JSON.parse(raw) as {
                    lastSyncedRepoFingerprint?: unknown;
                };
                if (typeof parsed.lastSyncedRepoFingerprint === "string") {
                    return parsed.lastSyncedRepoFingerprint;
                }
            } catch (error) {
                if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    (error as NodeJS.ErrnoException).code !== "ENOENT"
                ) {
                    console.debug(
                        "[Git Vault] Failed to inspect vault fingerprint:",
                        dataPath,
                        error
                    );
                }
            }
        }

        return null;
    }

    private async readObsidianRegistry(): Promise<ObsidianRegistry> {
        const registryPath = PlatformGuard.getObsidianConfigPath();
        if (!registryPath) {
            return {};
        }
        try {
            const raw = await fsPromises.readFile(registryPath, "utf8");
            const parsed = JSON.parse(raw) as ObsidianRegistry;
            return parsed;
        } catch (error) {
            const errorCode =
                error instanceof Error && "code" in error
                    ? (error as NodeJS.ErrnoException).code
                    : undefined;
            if (errorCode === "ENOENT") {
                return {};
            }

            if (error instanceof SyntaxError) {
                console.warn(
                    "[Git Vault] Failed to inspect Obsidian registry:",
                    registryPath,
                    error
                );
                return {};
            }

            if (
                errorCode === "EACCES" ||
                errorCode === "EPERM" ||
                errorCode === "EROFS" ||
                errorCode === "EBUSY"
            ) {
                console.warn(
                    "[Git Vault] Failed to inspect Obsidian registry:",
                    registryPath,
                    error
                );
                return {};
            }

            console.error(
                "[Git Vault] Failed to inspect Obsidian registry:",
                registryPath,
                error
            );
            return {};
        }
    }

    private async openVault(
        vaultPath: string,
        deeplinkVaultName?: string,
        options?: { shouldSyncAfterOpen?: boolean }
    ): Promise<void> {
        // Use vault= (folder basename) to open a registered vault via the
        // obsidian:// URL scheme.  We prefer electron.shell.openExternal()
        // over window.open() because the shell route goes through the OS
        // protocol handler, which forces Obsidian's main process to re-read
        // its vault registry from disk.  This matters when the vault was
        // registered in the current Obsidian session (e.g. after a dedicated-
        // vault import) and Obsidian's in-memory vault list has not yet been
        // refreshed via its file watcher.
        // Derive the vault name for a deeplink without resolving arbitrary filesystem paths.
        // Use a basename of the provided path (no resolution) to avoid dereferencing attacker-controlled paths.
        const normalizedPath = path.normalize(vaultPath);
        const vaultName = deeplinkVaultName || path.basename(normalizedPath);
        const deeplink = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;

        // Try electron.shell.openExternal (renderer-process Electron API).
        // Re-read shell lazily so the import doesn't break in non-Electron
        // environments (e.g. tests or future web builds).
        let openedViaShell = false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const electron = require("electron") as {
                shell?: { openExternal?: (url: string) => Promise<void> };
            };
            if (typeof electron?.shell?.openExternal === "function") {
                await electron.shell.openExternal(deeplink);
                openedViaShell = true;
            }
        } catch (error) {
            console.error(
                "[Git Vault] Failed to open existing vault via electron shell:",
                error
            );
            // electron not available (test environment or mobile); fall through.
        }

        if (!openedViaShell) {
            window.open(deeplink, "_blank");
        }

        this.plugin.makeSyncNotice(
            `Git Vault: opening vault «${vaultName}»${options?.shouldSyncAfterOpen ? " and queueing an update there" : ""}. ` +
                `If Obsidian shows "Vault not found", open it manually from ` +
                `the vault switcher (⌘⇧O / Ctrl+Shift+O). Vault path: ${normalizedPath}`,
            12000
        );
    }
}
