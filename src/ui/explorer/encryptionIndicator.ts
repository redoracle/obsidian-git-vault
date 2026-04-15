import { debounce, setIcon, TFile } from "obsidian";
import type ObsidianGit from "src/main";
import { isEncryptedEnvelope } from "src/syncProvider/apiEncryption";

// Reusable selectors used to locate file-title elements and explorer containers.
// Centralise them here to avoid duplicated literals and make maintenance easier.
const SAMPLE_SELECTOR =
    "div.tree-item-self.nav-file-title[data-path], div.nav-file-title[data-path]";
const CANDIDATE_SELECTOR =
    '[data-type="file-explorer"], .nav-folder-children, .nav-folders, .workspace-split, .workspace-left, .workspace-left-split';
const FALLBACK_SELECTOR =
    '.nav-folder-children, [data-type="file-explorer"], .nav-folders';

const INDICATOR_CLASS = "git-vault-encryption-indicator";
const REMOTE_CLASS = `${INDICATOR_CLASS}--remote`;
const WARNING_CLASS = `${INDICATOR_CLASS}--warning`;
const ERROR_CLASS = `${INDICATOR_CLASS}--error`;
const FAINT_CLASS = `${INDICATOR_CLASS}--faint`;
const STATE_CLASSES = [WARNING_CLASS, ERROR_CLASS, FAINT_CLASS];
const REMOTE_CACHE_TTL = 60 * 1000; // 1 minute caching to avoid repeated remote calls

function findFileTitleElements(): HTMLElement[] {
    // Support both Obsidian explorer and plugin tree items that use data-path
    const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(SAMPLE_SELECTOR)
    );
    return nodes;
}

export function registerExplorerEncryptionIndicator(plugin: ObsidianGit) {
    if (typeof document === "undefined") return;

    // Simple in-memory cache for remote metadata lookups
    const remoteCache = new Map<
        string,
        { remoteEncrypted: boolean; expires: number }
    >();
    // Cache for local file encryption checks to avoid re-reading file contents
    // on every debounced update. Keyed by file.path and stores a mtime to
    // detect changes.
    const localCache = new Map<
        string,
        { encryptedLocal: boolean; mtime: number }
    >();

    function ensureIndicator(el: HTMLElement, remote = false) {
        let span = el.querySelector<HTMLSpanElement>(`.${INDICATOR_CLASS}`);
        if (!span) {
            span = document.createElement("span");
            span.classList.add(INDICATOR_CLASS);
            // Use Obsidian's setIcon when available; fall back to an emoji
            try {
                if (typeof setIcon === "function") {
                    setIcon(span, "lock");
                } else {
                    span.textContent = "🔒";
                }
            } catch {
                span.textContent = "🔒";
            }
            // Prefer to place indicators inside any existing right-hand tools
            // container (.git-tools) so they align with other action icons.
            const rightHost =
                (el.querySelector(".git-tools") as HTMLElement) ?? el;
            rightHost.appendChild(span);
        }
        // Ensure any previous state modifier classes are cleared when (re)creating
        for (const c of STATE_CLASSES) span.classList.remove(c);
        // Remote state styling/flag
        if (remote) {
            span.classList.add(REMOTE_CLASS);
            span.setAttribute("data-remote-encrypted", "true");
            span.setAttribute("title", "Encrypted (remote)");
            span.setAttribute("aria-label", "Encrypted (remote)");
        } else {
            span.classList.remove(REMOTE_CLASS);
            span.removeAttribute("data-remote-encrypted");
            span.setAttribute("title", "Encrypted file");
            span.setAttribute("aria-label", "Encrypted file");
        }
    }

    async function checkAndUpdate(
        el: HTMLElement,
        path: string,
        signal?: AbortSignal
    ) {
        try {
            if (signal?.aborted) return;
            // Honor user setting: if disabled, remove any indicator and skip
            if (
                plugin.settings &&
                plugin.settings.showExplorerEncryptionIndicator === false
            ) {
                const ex = el.querySelector(`.${INDICATOR_CLASS}`);
                ex?.remove();
                return;
            }

            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!file || !(file instanceof TFile)) {
                // Remove any existing indicator if the target is not a file
                const ex = el.querySelector(`.${INDICATOR_CLASS}`);
                ex?.remove();
                return;
            }

            // Consult local cache to avoid reading file contents repeatedly.
            // If the file.stat is missing, treat it as a cache-miss to avoid
            // serving stale results for files that lack mtime metadata.
            const stat = file.stat;
            const mtime = stat?.mtime;
            const cachedLocal = localCache.get(path);
            let encryptedLocal: boolean;
            if (stat && cachedLocal && cachedLocal.mtime === mtime) {
                encryptedLocal = cachedLocal.encryptedLocal;
            } else {
                // If we don't have stat information, invalidate any cached entry
                // so we don't accidentally reuse stale data.
                if (!stat) {
                    localCache.delete(path);
                }
                // Read the file (only for visible explorer items)
                const content = await plugin.app.vault.read(file);
                if (signal?.aborted) return;
                encryptedLocal = isEncryptedEnvelope(content);
                // Store a numeric mtime; when stat is missing, use a sentinel
                // timestamp to avoid accidental equality matches later.
                const storedMtime = stat?.mtime ?? Date.now();
                localCache.set(path, { encryptedLocal, mtime: storedMtime });
            }

            if (encryptedLocal) {
                ensureIndicator(el, false);
                return;
            }

            // Not locally encrypted — consult remote metadata when available
            const capabilities = plugin.syncManager?.getCapabilities?.() ?? {
                supportsPerFileMetadata: false,
                supportsEncryptedSync: false,
            };

            const supportsRemoteCheck = Boolean(
                plugin.syncManager &&
                    (capabilities.supportsPerFileMetadata ||
                        capabilities.supportsEncryptedSync)
            );

            if (!supportsRemoteCheck) {
                // Provider doesn't support per-file metadata — make sure indicator is removed
                const ex = el.querySelector(`.${INDICATOR_CLASS}`);
                ex?.remove();
                return;
            }

            const now = Date.now();
            const cached = remoteCache.get(path);
            if (cached && cached.expires > now) {
                if (cached.remoteEncrypted) ensureIndicator(el, true);
                else el.querySelector(`.${INDICATOR_CLASS}`)?.remove();
                return;
            }

            // Fire remote metadata lookup
            let remoteEncrypted = false;
            let encryptionProblem: string | null = null;
            try {
                const meta = await plugin.syncManager.getFileMetadata(path);
                if (signal?.aborted) return;
                if (meta) {
                    // `meta` is `SyncFileMetadata | null` — use properties safely
                    remoteEncrypted = Boolean(meta.encrypted);
                    encryptionProblem = meta.encryptionProblem ?? null;
                } else {
                    remoteEncrypted = false;
                    encryptionProblem = null;
                }
            } catch (_err) {
                if (signal?.aborted) return;
                // Non-fatal; fall through and don't render a remote indicator
                remoteEncrypted = false;
                encryptionProblem = null;
            }

            // Cache the outcome briefly
            remoteCache.set(path, {
                remoteEncrypted,
                expires: now + REMOTE_CACHE_TTL,
            });

            if (signal?.aborted) return;
            if (remoteEncrypted) {
                ensureIndicator(el, true);
                const span = el.querySelector<HTMLSpanElement>(
                    `.${INDICATOR_CLASS}`
                );
                if (span) {
                    if (encryptionProblem) {
                        span.setAttribute(
                            "data-remote-encryption-issue",
                            encryptionProblem
                        );
                        // Remove any previous modifier classes then add the
                        // appropriate state modifier so the UI doesn't rely
                        // on color alone.
                        for (const c of STATE_CLASSES) span.classList.remove(c);
                        if (encryptionProblem === "passphrase-required") {
                            span.classList.add(WARNING_CLASS);
                            span.setAttribute(
                                "title",
                                "Encrypted (passphrase required)"
                            );
                            span.setAttribute(
                                "aria-label",
                                "Encrypted (passphrase required)"
                            );
                        } else if (
                            encryptionProblem === "passphrase-mismatched"
                        ) {
                            span.classList.add(ERROR_CLASS);
                            span.setAttribute(
                                "title",
                                "Encrypted (passphrase mismatch)"
                            );
                            span.setAttribute(
                                "aria-label",
                                "Encrypted (passphrase mismatch)"
                            );
                        } else {
                            span.classList.add(FAINT_CLASS);
                            span.setAttribute("title", "Encrypted (remote)");
                            span.setAttribute(
                                "aria-label",
                                "Encrypted (remote)"
                            );
                        }
                    } else {
                        span.removeAttribute("data-remote-encryption-issue");
                        for (const c of STATE_CLASSES) span.classList.remove(c);
                        span.setAttribute("title", "Encrypted (remote)");
                        span.setAttribute("aria-label", "Encrypted (remote)");
                    }
                }
            } else el.querySelector(`.${INDICATOR_CLASS}`)?.remove();
        } catch (err) {
            // If this run was aborted, don't log or touch the UI.
            if (signal && signal.aborted) return;
            // Ignore read errors; don't block explorer rendering
            // Keep debug-level logging for devs.
            // Use console.debug directly; tests and linters may ignore it.
            console.debug("Failed to check encryption for", path, err);
        }
    }

    // Per-cycle abort controller: abort any previous pending checks when a new
    // process cycle starts so older async work cannot overwrite newer UI state.
    let currentController: AbortController | null = null;
    const process = debounce(() => {
        // Cancel any prior in-flight checks
        try {
            if (currentController) currentController.abort();
        } catch {
            /* ignore */
        }
        currentController = new AbortController();
        const signal = currentController.signal;

        const nodes = findFileTitleElements();
        for (const el of nodes) {
            const path = el.getAttribute("data-path");
            if (!path) continue;
            // Fire-and-forget per-element checks; pass the signal so they can
            // early-return if aborted.
            void checkAndUpdate(el, path, signal);
        }
    }, 300);

    // Run initial pass
    process();

    // Observe DOM changes so newly-visible files get checked.
    // Prefer attaching to the file-explorer container to avoid excessive
    // callbacks across the whole document. If we cannot find the explorer
    // root, fall back to observing `document.body`.
    let explorerRoot: HTMLElement | null = null;
    const explorerObserver = new MutationObserver(() => {
        process();
    });

    const findExplorerRoot = (): HTMLElement | null => {
        // Use a sample file title element to locate the closest explorer container.
        const sample = document.querySelector<HTMLElement>(SAMPLE_SELECTOR);
        if (sample) {
            // Common explorer container candidates
            const candidate = sample.closest(CANDIDATE_SELECTOR);
            if (candidate && candidate instanceof HTMLElement) return candidate;
        }
        // Try a general fallback selector, in case the DOM is structured differently
        return document.querySelector<HTMLElement>(FALLBACK_SELECTOR) ?? null;
    };

    const attachToExplorer = () => {
        const candidate = findExplorerRoot();
        // If nothing useful found, observe the whole body as a last resort
        const rootToObserve = candidate ?? document.body;
        if (rootToObserve === explorerRoot) return; // already observing the correct root
        explorerObserver.disconnect();
        explorerRoot = rootToObserve;
        explorerObserver.observe(explorerRoot, {
            childList: true,
            subtree: true,
        });
    };

    // Lightweight watcher on body (direct children) to detect when the explorer
    // container is recreated by workspace layout changes so we can reattach.
    const rootWatcher = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== "childList") continue;
            if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
                // Re-evaluate the explorer root; attachToExplorer will no-op if
                // nothing changed.
                attachToExplorer();
                // No need to process mutations here; the explorerObserver will
                // call `process()` for relevant changes.
                return;
            }
        }
    });

    // Initial attach
    attachToExplorer();
    // Watch top-level body children for layout swaps that recreate explorer
    rootWatcher.observe(document.body, { childList: true });

    // Also refresh when the plugin triggers a refresh event
    plugin.registerEvent(
        plugin.app.workspace.on("obsidian-git:refreshed", () => {
            process();
        })
    );

    // Periodic pruning for the remote metadata cache to avoid unbounded growth
    const pruneInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, value] of remoteCache) {
            if (value.expires <= now) {
                remoteCache.delete(key);
            }
        }
        // Also trim stale local cache entries where the file no longer exists
        for (const key of Array.from(localCache.keys())) {
            const f = plugin.app.vault.getAbstractFileByPath(key);
            if (!f || !(f instanceof TFile)) {
                localCache.delete(key);
            }
        }
    }, REMOTE_CACHE_TTL);

    // Invalidate local cache entries when files change in the vault so we
    // don't rely on stale content. Use vault events for modify/create/delete/rename.
    // Vault event listeners: some unit tests provide a minimal `vault` mock
    // without an `on` method. Guard the calls so tests don't throw.
    const vaultOn = (plugin.app?.vault as unknown as { on?: unknown })?.on;
    if (typeof vaultOn === "function") {
        plugin.registerEvent(
            plugin.app.vault.on("modify", (file) => {
                if (file instanceof TFile) localCache.delete(file.path);
            })
        );
        plugin.registerEvent(
            plugin.app.vault.on("create", (file) => {
                if (file instanceof TFile) localCache.delete(file.path);
            })
        );
        plugin.registerEvent(
            plugin.app.vault.on("delete", (file) => {
                if (file instanceof TFile) localCache.delete(file.path);
            })
        );
        plugin.registerEvent(
            plugin.app.vault.on("rename", (file, oldPath) => {
                if (typeof oldPath === "string") localCache.delete(oldPath);
                if (file instanceof TFile) localCache.delete(file.path);
            })
        );
    }

    // Clean up on unload
    plugin.register(() => {
        try {
            if (currentController) currentController.abort();
        } catch {
            /* ignore */
        }
        explorerObserver.disconnect();
        rootWatcher.disconnect();
        clearInterval(pruneInterval);
        remoteCache.clear();
        localCache.clear();
    });
}

export default registerExplorerEncryptionIndicator;
