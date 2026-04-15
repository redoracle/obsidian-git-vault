import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type ObsidianGit from "../../src/main";
import type {
    Conflict,
    ConflictResolution,
} from "../../src/syncProvider/syncProvider";
import { ConflictModal } from "../../src/ui/modals/conflictModal";

type FakeListener = (event: FakeKeyboardEvent) => void | Promise<void>;

class FakeElement {
    className = "";
    textContent = "";
    style: Record<string, string> = {};
    childNodes: FakeElement[] = [];
    value = "";
    rows = 0;
    private listeners = new Map<string, FakeListener[]>();

    get firstChild(): FakeElement | null {
        return this.childNodes[0] ?? null;
    }

    appendChild(child: FakeElement): FakeElement {
        this.childNodes.push(child);
        return child;
    }

    removeChild(child: FakeElement): FakeElement {
        this.childNodes = this.childNodes.filter(
            (candidate) => candidate !== child
        );
        return child;
    }

    setAttribute(): void {}

    addEventListener(type: string, listener: FakeListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    click(): void {
        for (const listener of this.listeners.get("click") ?? []) {
            void listener(new FakeKeyboardEvent("click", { key: "" }));
        }
    }

    removeEventListener(type: string, listener: FakeListener): void {
        const list = this.listeners.get(type) ?? [];
        const next = list.filter((l) => l !== listener);
        this.listeners.set(type, next);
    }

    focus(): void {}
}

class FakeTextAreaElement extends FakeElement {}

class FakeDocument {
    private listeners = new Map<string, FakeListener[]>();

    createElement(tag: string): FakeElement {
        return tag === "textarea"
            ? new FakeTextAreaElement()
            : new FakeElement();
    }

    addEventListener(type: string, listener: FakeListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: FakeListener): void {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter(
                (candidate) => candidate !== listener
            )
        );
    }

    dispatchEvent(event: FakeKeyboardEvent): void {
        for (const listener of this.listeners.get(event.type) ?? []) {
            void listener(event);
        }
    }
}

class FakeKeyboardEvent {
    defaultPrevented = false;
    target: FakeElement | null = null;
    ctrlKey = false;
    metaKey = false;
    altKey = false;
    shiftKey = false;

    constructor(
        readonly type: string,
        init: {
            key: string;
            ctrlKey?: boolean;
            metaKey?: boolean;
            altKey?: boolean;
            shiftKey?: boolean;
        }
    ) {
        this.key = init.key;
        this.ctrlKey = init.ctrlKey ?? false;
        this.metaKey = init.metaKey ?? false;
        this.altKey = init.altKey ?? false;
        this.shiftKey = init.shiftKey ?? false;
    }

    readonly key: string;

    preventDefault(): void {
        this.defaultPrevented = true;
    }
}

function makePluginStub(currentFileContent = "local content"): ObsidianGit {
    const file = { path: "note.md" };
    return {
        app: {
            vault: {
                getFileByPath: vi.fn((path: string) =>
                    path === file.path ? file : null
                ),
                read: vi.fn(() => Promise.resolve(currentFileContent)),
            },
        },
    } as unknown as ObsidianGit;
}

// Helper to wait for pending microtasks/macrotasks in tests.
function flushPromises(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConflictModal keyboard shortcuts", () => {
    beforeEach(() => {
        vi.stubGlobal("document", new FakeDocument());
        vi.stubGlobal("HTMLElement", FakeElement);
        vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
        vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("applies resolutions with 'A' after resolving conflicts via 'L'", () => {
        const plugin = makePluginStub();
        const onResolved = vi.fn(
            (_resolutions: ConflictResolution[]): void => undefined
        );
        const conflicts: Conflict[] = [
            {
                path: "note.md",
                localContent: "local content",
                remoteContent: "remote content",
            },
        ];

        const modal = new ConflictModal(plugin, conflicts, onResolved);
        // Open registers the document-level keyboard handler and renders.
        modal.onOpen();

        // Press 'l' to keep local (resolves the single conflict).
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }));

        // Now the finished UI should be shown. Press 'a' to apply.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

        expect(onResolved).toHaveBeenCalledTimes(1);
        const arg = onResolved.mock.calls[0][0];
        expect(Array.isArray(arg)).toBe(true);
        expect(arg[0]).toMatchObject({
            path: "note.md",
            strategy: "always-local",
        });

        modal.onClose();
    });

    it("uses the current vault text when manual edit content is unchanged", async () => {
        const plugin = makePluginStub("resolved from editor");
        const onResolved = vi.fn(
            (_resolutions: ConflictResolution[]): void => undefined
        );
        const conflicts: Conflict[] = [
            {
                path: "note.md",
                localContent: "<<<<<<< local\nold\n=======",
                remoteContent: "incoming content",
            },
        ];

        const modal = new ConflictModal(plugin, conflicts, onResolved);
        modal.onOpen();

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
        await flushPromises();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

        expect(onResolved).toHaveBeenCalledTimes(1);
        expect(onResolved.mock.calls[0][0][0]).toMatchObject({
            path: "note.md",
            strategy: "manual",
            manualContent: "resolved from editor",
        });

        modal.onClose();
    });

    it("pressing 'r' resolves to keep remote version", () => {
        const plugin = makePluginStub();
        const onResolved = vi.fn(
            (_resolutions: ConflictResolution[]): void => undefined
        );
        const conflicts: Conflict[] = [
            {
                path: "note.md",
                localContent: "local content",
                remoteContent: "remote content",
            },
        ];

        const modal = new ConflictModal(plugin, conflicts, onResolved);
        modal.onOpen();

        // Press 'r' to keep remote
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

        expect(onResolved).toHaveBeenCalledTimes(1);
        const arg = onResolved.mock.calls[0][0];
        expect(Array.isArray(arg)).toBe(true);
        expect(arg[0]).toMatchObject({
            path: "note.md",
            strategy: "always-remote",
        });

        modal.onClose();
    });

    it("pressing 'a' before resolving any conflicts does not call onResolved", () => {
        const plugin = makePluginStub();
        const onResolved = vi.fn(
            (_resolutions: ConflictResolution[]): void => undefined
        );
        const conflicts: Conflict[] = [
            {
                path: "note.md",
                localContent: "local content",
                remoteContent: "remote content",
            },
        ];

        const modal = new ConflictModal(plugin, conflicts, onResolved);
        modal.onOpen();

        // Press 'a' immediately should not resolve since none are resolved yet
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

        expect(onResolved).not.toHaveBeenCalled();

        modal.onClose();
    });

    it("modifier key combos do not trigger resolution (e.g., Ctrl+L)", () => {
        const plugin = makePluginStub();
        const onResolved = vi.fn(
            (_resolutions: ConflictResolution[]): void => undefined
        );
        const conflicts: Conflict[] = [
            {
                path: "note.md",
                localContent: "local content",
                remoteContent: "remote content",
            },
        ];

        const modal = new ConflictModal(plugin, conflicts, onResolved);
        modal.onOpen();

        // Press Ctrl+L which should be ignored by the handler
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "l", ctrlKey: true })
        );

        expect(onResolved).not.toHaveBeenCalled();

        modal.onClose();
    });
});
