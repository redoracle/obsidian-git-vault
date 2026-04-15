import { Modal } from "obsidian";
import type ObsidianGit from "../../main";
import type {
    Conflict,
    ConflictResolution,
} from "../../syncProvider/syncProvider";

const DEBUG_LOGS = process.env.NODE_ENV !== "production";

type RuntimeNodeHelpers = Node & {
    createDiv?: Node["createDiv"];
    createEl?: Node["createEl"];
    createSpan?: Node["createSpan"];
    empty?: Node["empty"];
};

// Small helper type for optional, loosely-typed extras on DomElementInfo.
type ElementOptsExtras = {
    attr?: unknown;
    attrs?: unknown;
    dataset?: unknown;
    disabled?: unknown;
};

// Use the global `DomElementInfo` from the environment (Obsidian typings).
// Avoid declaring a local `DomElementInfo` here to prevent type collisions
// with the global declaration provided by the host environment.

function applyElementOptions(
    el: HTMLElement,
    opts?: DomElementInfo | string
): void {
    if (typeof opts === "string") {
        el.className = opts;
        return;
    }
    if (!opts) return;

    // Treat opts as the environment's DomElementInfo
    const o = opts;

    // Class handling
    if (o.cls != null) {
        if (Array.isArray(o.cls)) el.className = o.cls.join(" ");
        else if (typeof o.cls === "string") el.className = o.cls;
    }

    // Text or Node content
    const text = o.text;
    if (typeof text === "string") {
        el.textContent = text;
    } else if (text instanceof Node) {
        el.appendChild(text);
    } else if (text != null) {
        // Fallback for other truthy values
        el.textContent = String(text);
    }

    // Additional common DOM element attributes support
    const safeToAttrString = (v: unknown): string => {
        if (typeof v === "string") return v;
        if (
            typeof v === "number" ||
            typeof v === "boolean" ||
            typeof v === "bigint"
        )
            return String(v);
        if (typeof v === "symbol" || typeof v === "function")
            return v.toString();
        try {
            return JSON.stringify(v);
        } catch {
            return "[object]";
        }
    };

    const extraAttrs =
        (o as unknown as ElementOptsExtras).attr ??
        (o as unknown as ElementOptsExtras).attrs;
    if (extraAttrs != null) {
        const applyAttr = (key: string, value: unknown) => {
            if (value === true) {
                el.setAttribute(key, "");
                return;
            }
            if (value === false || value == null) {
                el.removeAttribute(key);
                return;
            }

            if (typeof value === "object") {
                try {
                    el.setAttribute(key, JSON.stringify(value));
                } catch {
                    // If we can't stringify, set a safe placeholder rather than
                    // invoking the object's default stringifier.
                    el.setAttribute(key, "[object]");
                }
                return;
            }

            // Primitive coercion: safe to stringify primitives.
            el.setAttribute(key, safeToAttrString(value));
        };

        if (Array.isArray(extraAttrs)) {
            for (const a of extraAttrs) {
                if (a && typeof a === "object") {
                    const obj = a as Record<string, unknown>;
                    for (const k of Object.keys(obj)) {
                        applyAttr(k, obj[k]);
                    }
                }
            }
        } else if (typeof extraAttrs === "object") {
            const obj = extraAttrs as Record<string, unknown>;
            for (const k of Object.keys(obj)) {
                applyAttr(k, obj[k]);
            }
        }
    }

    // Common singular properties
    if (o.title != null) el.title = String(o.title);
    if (o.placeholder != null && "placeholder" in el)
        (el as HTMLInputElement).placeholder = String(o.placeholder);
    if (o.value != null && "value" in el)
        (el as HTMLInputElement).value = String(o.value);
    if (o.href != null && "href" in el)
        (el as HTMLAnchorElement).href = String(o.href);

    // Dataset support: robustly map arbitrary keys to `data-*` attributes.
    const ds = (o as unknown as ElementOptsExtras).dataset;
    if (ds && typeof ds === "object") {
        const dsObj = ds as Record<string, unknown>;
        for (const [k, v] of Object.entries(dsObj)) {
            // Normalize the attribute name: if caller supplied a full
            // `data-` prefixed key, use it as-is; otherwise prepend
            // `data-` and convert camelCase to kebab-case for consistency.
            const attrName = k.startsWith("data-")
                ? k
                : `data-${k.replace(/([A-Z])/g, "-$1").toLowerCase()}`;

            if (v === undefined || v === null) {
                el.removeAttribute(attrName);
                continue;
            }

            if (typeof v === "object") {
                try {
                    el.setAttribute(attrName, JSON.stringify(v));
                } catch {
                    el.setAttribute(attrName, "[object]");
                }
                continue;
            }

            el.setAttribute(attrName, safeToAttrString(v));
        }
    }

    // Boolean attributes (e.g., disabled)
    if ((o as unknown as ElementOptsExtras).disabled !== undefined) {
        const isDisabled = Boolean(
            (o as unknown as ElementOptsExtras).disabled
        );
        // Use the empty-string form for boolean attributes (or toggle)
        // so they are present/absent rather than carrying a literal string value.
        el.toggleAttribute("disabled", isDisabled);
    }
}

function ensureCreateHelpers(el: Node | null): void {
    if (!el) return;
    const target = el as RuntimeNodeHelpers;

    if (typeof target.createDiv !== "function") {
        // Overload compatible with Obsidian's Node helpers: two-argument form
        target.createDiv = function (
            this: Node,
            o?: string | DomElementInfo,
            callback?: (el: HTMLDivElement) => void
        ): HTMLDivElement {
            const div = document.createElement("div");
            applyElementOptions(div, o);
            this.appendChild(div);
            ensureCreateHelpers(div);
            if (callback) callback(div);
            return div;
        };
    }

    if (typeof target.createEl !== "function") {
        target.createEl = function <K extends keyof HTMLElementTagNameMap>(
            this: Node,
            tag: K,
            o?: string | DomElementInfo,
            callback?: (el: HTMLElementTagNameMap[K]) => void
        ): HTMLElementTagNameMap[K] {
            const child = document.createElement(tag);
            applyElementOptions(child, o);
            this.appendChild(child);
            ensureCreateHelpers(child);
            if (callback) callback(child);
            return child;
        };
    }

    if (typeof target.createSpan !== "function") {
        target.createSpan = function (
            this: Node,
            o?: string | DomElementInfo,
            callback?: (el: HTMLSpanElement) => void
        ): HTMLSpanElement {
            const span = document.createElement("span");
            applyElementOptions(span, o);
            this.appendChild(span);
            ensureCreateHelpers(span);
            if (callback) callback(span);
            return span;
        };
    }

    if (typeof target.empty !== "function") {
        target.empty = function (this: Node): void {
            while (this.firstChild) this.removeChild(this.firstChild);
        };
    }
}

/**
 * ConflictModal
 *
 * Visual merge conflict resolver.  For each conflicted file it shows:
 *   – A progress bar (resolved / total)
 *   – File path badge
 *   – Side-by-side local vs remote content (text files) or a binary notice
 *   – "Keep Local" / "Keep Remote" / "Edit Manually" buttons
 *   – Keyboard shortcuts: L · R · E · S · A
 *
 * After all conflicts are reviewed the caller's `onResolved` callback is
 * invoked with the array of {@link ConflictResolution} objects.
 */
export class ConflictModal extends Modal {
    private resolutions: Map<string, ConflictResolution> = new Map();
    private currentIndex = 0;

    // Current-conflict button refs for the persistent keyboard handler.
    private btnLocalRef: HTMLButtonElement | null = null;
    private btnRemoteRef: HTMLButtonElement | null = null;
    private btnManualRef: HTMLButtonElement | null = null;
    private btnSkipRef: HTMLButtonElement | null = null;
    private btnApplyRef: HTMLButtonElement | null = null;

    // document-level keydown handler, registered on open and removed on close.
    private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

    constructor(
        private readonly plugin: ObsidianGit,
        private readonly conflicts: Conflict[],
        private readonly onResolved: (resolutions: ConflictResolution[]) => void
    ) {
        super(plugin.app);
        // Class on modalEl persists across contentEl redraws.
        this.modalEl.addClass("git-vault-conflict-modal");
        this.titleEl.textContent = "Resolve Merge Conflicts";
    }

    onOpen(): void {
        // Attach at document level so keyboard events are captured regardless
        // of which element inside the modal has focus.
        this.keydownHandler = (e: KeyboardEvent) => {
            // In `keydownHandler`: ignore events when focused in a textarea
            // (`HTMLTextAreaElement`) so keyboard shortcuts are not handled
            // while the user is typing.
            if (e.target instanceof HTMLTextAreaElement) return;
            if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            const key = (e.key || "").toLowerCase();
            if (key === "l") {
                e.preventDefault();
                this.btnLocalRef?.click();
            } else if (key === "r") {
                e.preventDefault();
                this.btnRemoteRef?.click();
            } else if (key === "e") {
                e.preventDefault();
                this.btnManualRef?.click();
            } else if (key === "s") {
                e.preventDefault();
                this.btnSkipRef?.click();
            } else if (key === "a") {
                e.preventDefault();
                this.btnApplyRef?.click();
            }
        };
        if (typeof document !== "undefined") {
            document.addEventListener("keydown", this.keydownHandler);
        }
        this.render();
    }

    onClose(): void {
        if (this.keydownHandler) {
            if (typeof document !== "undefined") {
                document.removeEventListener("keydown", this.keydownHandler);
            }
            this.keydownHandler = null;
        }
        this.contentEl.empty();
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.btnLocalRef = null;
        this.btnRemoteRef = null;
        this.btnManualRef = null;
        this.btnSkipRef = null;
        this.btnApplyRef = null;

        const conflict = this.conflicts[this.currentIndex];
        if (DEBUG_LOGS) {
            console.debug("[ObsidianGit] Conflict shown:", conflict);
        }

        if (!conflict) {
            this.renderFinished();
            return;
        }

        const total = this.conflicts.length;
        const resolved = this.resolutions.size;

        // ── Progress bar ─────────────────────────────────────────────────
        const progressEl = contentEl.createDiv("git-vault-conflict-progress");
        ensureCreateHelpers(progressEl);
        const barEl = progressEl.createDiv("git-vault-conflict-progress-bar");
        ensureCreateHelpers(barEl);
        const fill = barEl.createDiv("git-vault-conflict-progress-fill");
        fill.style.width = `${Math.round((resolved / total) * 100)}%`;
        progressEl.createSpan({
            cls: "git-vault-conflict-progress-label",
            text: `${this.currentIndex + 1} of ${total}${resolved ? ` · ${resolved} resolved` : ""}`,
        });

        // ── File path badge ──────────────────────────────────────────────
        contentEl.createDiv({
            cls: "git-vault-conflict-path",
            text: conflict.path,
        });

        // ── Diff view ────────────────────────────────────────────────────
        const isBinary = !!conflict.isBinary;
        const isDeleteConflict = !!(
            conflict.deletedLocal || conflict.deletedRemote
        );

        if (!isBinary && !isDeleteConflict) {
            const localDisplay = this.getDisplayContent(
                conflict.localContent,
                conflict
            );
            const remoteDisplay = this.getDisplayContent(
                conflict.remoteContent,
                conflict
            );

            const grid = contentEl.createDiv("git-vault-conflict-grid");
            ensureCreateHelpers(grid);

            const localCol = grid.createDiv("git-vault-conflict-col");
            ensureCreateHelpers(localCol);
            localCol.createDiv({
                cls: "git-vault-conflict-col-header",
                text: "Local — your version",
            });
            localCol
                .createEl("pre", { cls: "git-vault-conflict-content" })
                .createEl("code", { text: localDisplay });

            const remoteCol = grid.createDiv("git-vault-conflict-col");
            remoteCol.createDiv({
                cls: "git-vault-conflict-col-header",
                text: "Remote — incoming",
            });
            remoteCol
                .createEl("pre", { cls: "git-vault-conflict-content" })
                .createEl("code", { text: remoteDisplay });
        } else {
            const msg = isBinary
                ? "Binary file — choose which version to keep."
                : this.getDisplayContent(conflict.localContent, conflict);
            contentEl.createDiv({
                cls: "git-vault-conflict-binary-info",
                text: msg,
            });
        }

        // ── Manual edit area (hidden until requested) ────────────────────
        const canManualEdit =
            typeof conflict.localContent === "string" &&
            typeof conflict.remoteContent === "string" &&
            !isBinary;

        const manualSection = contentEl.createDiv("git-vault-manual-section");
        ensureCreateHelpers(manualSection);
        manualSection.style.display = "none";
        manualSection.createDiv({
            cls: "git-vault-conflict-col-header",
            text: "Manual edit",
        });
        const textarea = manualSection.createEl("textarea", {
            cls: "git-vault-manual-textarea",
        });
        textarea.value =
            typeof conflict.localContent === "string"
                ? conflict.localContent
                : "";
        const initialManualContent = textarea.value;
        textarea.rows = 12;

        // ── Action buttons ───────────────────────────────────────────────
        const actions = contentEl.createDiv("git-vault-conflict-actions");
        ensureCreateHelpers(actions);

        this.btnLocalRef = actions.createEl("button", {
            text: "Keep Local",
            cls: "mod-cta git-vault-btn-resolve",
        });
        this.btnLocalRef.setAttribute("title", "Keep your local version (L)");
        this.btnLocalRef.addEventListener("click", () => {
            this.recordResolution(conflict.path, "always-local");
            this.advance();
        });

        this.btnRemoteRef = actions.createEl("button", {
            text: "Keep Remote",
            cls: "git-vault-btn-resolve",
        });
        this.btnRemoteRef.setAttribute(
            "title",
            "Accept the incoming remote version (R)"
        );
        this.btnRemoteRef.addEventListener("click", () => {
            this.recordResolution(conflict.path, "always-remote");
            this.advance();
        });

        if (canManualEdit) {
            let isManualOpen = false;
            this.btnManualRef = actions.createEl("button", {
                text: "Edit Manually",
                cls: "git-vault-btn-secondary",
            });
            this.btnManualRef.setAttribute(
                "title",
                "Edit the merged content before applying (E)"
            );
            this.btnManualRef.addEventListener("click", () => {
                if (!isManualOpen) {
                    isManualOpen = true;
                    manualSection.style.display = "block";
                    this.btnManualRef!.textContent = "Apply Edit";
                    textarea.focus();
                } else {
                    void this.resolveManualEdit(
                        conflict.path,
                        textarea,
                        initialManualContent
                    );
                }
            });
        }

        // Flex spacer pushes Skip to the trailing edge.
        actions.createDiv("git-vault-btn-sep");

        this.btnSkipRef = actions.createEl("button", {
            text: "Skip",
            cls: "git-vault-btn-skip",
        });
        this.btnSkipRef.setAttribute(
            "title",
            "Leave this conflict unresolved for now (S)"
        );
        this.btnSkipRef.addEventListener("click", () => this.advance());

        // ── Keyboard-shortcut hints ──────────────────────────────────────
        const hints = contentEl.createDiv("git-vault-conflict-hints");
        this.addHint(hints, "L", "keep local");
        hints.createSpan({ text: " · " });
        this.addHint(hints, "R", "keep remote");
        hints.createSpan({ text: " · " });
        this.addHint(hints, "S", "skip");
        if (this.btnManualRef) {
            hints.createSpan({ text: " · " });
            this.addHint(hints, "E", "edit manually");
        }
    }

    private addHint(parent: HTMLElement, key: string, label: string): void {
        parent.createEl("kbd", { text: key });
        parent.createSpan({ text: ` ${label}` });
    }

    private renderFinished(): void {
        const { contentEl } = this;
        contentEl.empty();

        const resolved = this.resolutions.size;
        const total = this.conflicts.length;
        const skipped = total - resolved;

        contentEl.createDiv({
            cls: "git-vault-conflict-finished-icon",
            text: resolved > 0 ? "✓" : "○",
        });
        contentEl.createEl("h3", {
            text:
                resolved === total
                    ? "All conflicts resolved"
                    : `${resolved} of ${total} conflict${total !== 1 ? "s" : ""} resolved`,
        });
        if (skipped > 0) {
            contentEl.createDiv({
                cls: "git-vault-conflict-finished-skipped",
                text: `${skipped} conflict${skipped !== 1 ? "s" : ""} skipped — they remain unresolved in the vault.`,
            });
        }

        const actions = contentEl.createDiv(
            "git-vault-conflict-actions git-vault-conflict-finished-actions"
        );
        if (resolved > 0) {
            this.btnApplyRef = actions.createEl("button", {
                text: "Apply Resolutions",
                cls: "mod-cta",
            });
            this.btnApplyRef.setAttribute(
                "title",
                "Apply resolutions and finish sync (A)"
            );
            this.btnApplyRef.addEventListener("click", () => {
                this.onResolved([...this.resolutions.values()]);
                this.close();
            });
        }
        const btnClose = actions.createEl("button", {
            text: skipped > 0 ? "Close (leave skipped)" : "Close",
        });
        btnClose.addEventListener("click", () => {
            if (this.resolutions.size > 0) {
                this.onResolved([...this.resolutions.values()]);
            }
            this.close();
        });

        if (resolved > 0) {
            const hints = contentEl.createDiv("git-vault-conflict-hints");
            this.addHint(hints, "A", "apply resolutions");
        }
    }

    // ── Resolution helpers ─────────────────────────────────────────────────

    private recordResolution(
        path: string,
        strategy: Exclude<ConflictResolution["strategy"], "manual">
    ): void {
        this.resolutions.set(path, { path, strategy });
    }

    private recordResolutionManual(path: string, content: string): void {
        this.resolutions.set(path, {
            path,
            strategy: "manual",
            manualContent: content,
        });
    }

    private async resolveManualEdit(
        path: string,
        textarea: HTMLTextAreaElement,
        initialContent: string
    ): Promise<void> {
        const btn = this.btnManualRef;
        const content = await this.getManualResolutionContent(
            path,
            textarea.value,
            initialContent
        );
        this.recordResolutionManual(path, content);
        if (btn) {
            btn.textContent = "Edit Manually";
        }
        this.advance();
    }

    private async getManualResolutionContent(
        path: string,
        editedContent: string,
        initialContent: string
    ): Promise<string> {
        if (editedContent !== initialContent) {
            return editedContent;
        }

        const currentFile = this.plugin.app.vault.getFileByPath(path);
        if (!currentFile) {
            return editedContent;
        }

        try {
            const currentContent =
                await this.plugin.app.vault.read(currentFile);
            return currentContent !== initialContent
                ? currentContent
                : editedContent;
        } catch (error) {
            console.debug(
                "[ObsidianGit] Failed to read current manual conflict file; using editor content.",
                error
            );
            return editedContent;
        }
    }

    private getDisplayContent(
        content: Conflict["localContent"],
        conflict: Conflict
    ): string {
        if (content === undefined) {
            if (conflict.deletedLocal || conflict.deletedRemote) {
                return "[File deleted on this side]";
            }
            return "[No content available]";
        }
        if (typeof content === "string") {
            return content;
        }
        return `[Binary content: ${content.byteLength} bytes]`;
    }

    private advance(): void {
        this.currentIndex++;
        this.render();
    }
}
