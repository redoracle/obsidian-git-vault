import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TFile } from "obsidian";
import type ObsidianGit from "src/main";

// Use dynamic import so module picks up the test DOM and mocked obsidian
async function loadModule() {
    return await import("src/ui/explorer/encryptionIndicator");
}

// Lightweight typed fake DOM used only in these unit tests
type FakeClassList = {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
};

interface FakeElement {
    tagName: string;
    classList: FakeClassList;
    attributes: Map<string, string>;
    children: FakeElement[];
    appendChild(child: FakeElement): void;
    setAttribute(name: string, val: string): void;
    getAttribute(name: string): string | null;
    remove(): void;
    textContent?: string | null;
    querySelector?(sel: string): FakeElement | null;
    querySelectorAll?(sel: string): FakeElement[];
}

interface FakeDocument {
    __elements: FakeElement[];
    createElement(tag: string): FakeElement;
    querySelectorAll(sel: string): FakeElement[];
    querySelector(sel: string): FakeElement | null;
    body: { appendChild(el: FakeElement): void; innerHTML: string };
}

describe("registerExplorerEncryptionIndicator", () => {
    beforeEach(() => {
        // Ensure a minimal fake DOM exists in the node test environment
        if (typeof globalThis.document === "undefined") {
            const elements: FakeElement[] = [];

            const makeClassList = (): FakeClassList => {
                const set = new Set<string>();
                return {
                    add: (...names: string[]) =>
                        names.forEach((n) => set.add(n)),
                    remove: (...names: string[]) =>
                        names.forEach((n) => set.delete(n)),
                    contains: (n: string) => set.has(n),
                };
            };

            const createElement = (tag: string): FakeElement => {
                const el: FakeElement = {
                    tagName: tag.toUpperCase(),
                    classList: makeClassList(),
                    attributes: new Map<string, string>(),
                    children: [],
                    appendChild(this: FakeElement, child: FakeElement) {
                        this.children.push(child);
                    },
                    setAttribute(this: FakeElement, name: string, val: string) {
                        this.attributes.set(name, String(val));
                    },
                    getAttribute(this: FakeElement, name: string) {
                        return this.attributes.get(name) ?? null;
                    },
                    remove(this: FakeElement) {},
                    textContent: null,
                    querySelector(this: FakeElement, sel: string) {
                        if (sel.startsWith(".")) {
                            const cls = sel.slice(1);
                            if (this.classList.contains(cls)) return this;
                            const found = findAll(this.children, (e) =>
                                e.classList.contains(cls)
                            );
                            return found[0] ?? null;
                        }
                        const attrMatch = sel.match(/\[([^\]]+)\]/);
                        if (attrMatch) {
                            const attr = attrMatch[1];
                            if (this.getAttribute(attr) != null) return this;
                            const found = findAll(
                                this.children,
                                (e) => e.getAttribute(attr) != null
                            );
                            return found[0] ?? null;
                        }
                        return null;
                    },
                    querySelectorAll(this: FakeElement, sel: string) {
                        if (sel.startsWith(".")) {
                            const cls = sel.slice(1);
                            return findAll([this], (e) =>
                                e.classList.contains(cls)
                            );
                        }
                        const attrMatch = sel.match(/\[([^\]]+)\]/);
                        if (attrMatch) {
                            const attr = attrMatch[1];
                            return findAll(
                                [this],
                                (e) => e.getAttribute(attr) != null
                            );
                        }
                        return [] as FakeElement[];
                    },
                };
                return el;
            };

            const findAll = (
                list: FakeElement[],
                predicate: (el: FakeElement) => boolean
            ): FakeElement[] => {
                const out: FakeElement[] = [];
                for (const el of list) {
                    if (predicate(el)) out.push(el);
                    if (el.children.length)
                        out.push(...findAll(el.children, predicate));
                }
                return out;
            };

            const doc: FakeDocument = {
                __elements: elements,
                createElement,
                querySelectorAll: (_sel: string) =>
                    findAll(
                        elements,
                        (e) => e.getAttribute("data-path") != null
                    ),
                querySelector: (sel: string) => {
                    if (sel.startsWith(".")) {
                        const cls = sel.slice(1);
                        return (
                            findAll(elements, (e) =>
                                e.classList.contains(cls)
                            )[0] ?? null
                        );
                    }
                    return null;
                },
                body: {
                    appendChild: (el: FakeElement) => elements.push(el),
                    innerHTML: "",
                },
            };

            class MutationObserverShim {
                cb: (mutations: unknown[]) => void;
                constructor(cb: (mutations: unknown[]) => void) {
                    this.cb = cb;
                }
                observe() {}
                disconnect() {}
            }

            // Attach to global scope so the module under test can use them
            (
                globalThis as unknown as { MutationObserver?: unknown }
            ).MutationObserver =
                MutationObserverShim as unknown as typeof MutationObserver;
            (globalThis as unknown as { document?: Document }).document =
                doc as unknown as Document;
        } else {
            const fd = globalThis.document as unknown as FakeDocument;
            fd.body.innerHTML = "";
            fd.__elements = [];
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows a local encrypted indicator when file content is an encrypted envelope", async () => {
        const fakeDoc = document as unknown as FakeDocument;

        // Create a minimal tree-item DOM node in the fake document
        const el = fakeDoc.createElement("div");
        el.classList.add("tree-item-self");
        el.classList.add("nav-file-title");
        el.setAttribute("data-path", "Encrypted.md");
        const span = fakeDoc.createElement("span");
        span.textContent = "Encrypted.md";
        el.appendChild(span);
        fakeDoc.body.appendChild(el);

        const fakeFile = {
            path: "Encrypted.md",
            name: "Encrypted.md",
        } as unknown as TFile;
        // Make the object appear as a TFile instance for `instanceof` checks
        const tfileProto = (TFile as unknown as { prototype: object })
            .prototype;
        Object.setPrototypeOf(fakeFile, tfileProto);

        const pluginMock = {
            app: {
                vault: {
                    getAbstractFileByPath: (_p: string) => fakeFile,
                    read: (_f: TFile) =>
                        Promise.resolve(
                            'obsidian-git-vault:encrypted:v1\n{"version":1,"algorithm":"AES-GCM","kdf":"PBKDF2","iterations":10000,"salt":"","iv":"","ciphertext":"","isBinary":false}'
                        ),
                },
                workspace: {
                    on: (
                        _n: string,
                        _cb: (..._args: unknown[]) => void
                    ) => ({}),
                },
            },
            registerEvent: (_ref: unknown) => {},
            register: (_fn: () => void) => {},
            syncManager: {
                getCapabilities: () => ({ supportsPerFileMetadata: false }),
            },
            settings: { showExplorerEncryptionIndicator: true },
        } as unknown as Partial<ObsidianGit>;

        const mod = await loadModule();
        (
            mod as unknown as {
                registerExplorerEncryptionIndicator: (
                    p: Partial<ObsidianGit>
                ) => void;
            }
        ).registerExplorerEncryptionIndicator(pluginMock);

        // Wait for debounce to run
        await new Promise((r) => setTimeout(r, 350));

        const elResult = (document as unknown as FakeDocument).querySelector(
            ".git-vault-encryption-indicator"
        );
        expect(elResult).not.toBeNull();
        expect(elResult?.getAttribute("data-remote-encrypted")).toBeNull();
    });

    it("shows a remote-encrypted indicator when local file is plain but remote metadata marks it encrypted", async () => {
        const fakeDoc = document as unknown as FakeDocument;

        // Create a minimal tree-item DOM node in the fake document
        const el = fakeDoc.createElement("div");
        el.classList.add("tree-item-self");
        el.classList.add("nav-file-title");
        el.setAttribute("data-path", "RemoteOnly.md");
        const span = fakeDoc.createElement("span");
        span.textContent = "RemoteOnly.md";
        el.appendChild(span);
        fakeDoc.body.appendChild(el);

        const fakeFile = {
            path: "RemoteOnly.md",
            name: "RemoteOnly.md",
        } as unknown as TFile;
        // Make the object appear as a TFile instance for `instanceof` checks
        const tfileProto2 = (TFile as unknown as { prototype: object })
            .prototype;
        Object.setPrototypeOf(fakeFile, tfileProto2);

        const pluginMock = {
            app: {
                vault: {
                    getAbstractFileByPath: (_p: string) => fakeFile,
                    read: (_f: TFile) => Promise.resolve("plain content"),
                },
                workspace: {
                    on: (
                        _n: string,
                        _cb: (..._args: unknown[]) => void
                    ) => ({}),
                },
            },
            registerEvent: (_ref: unknown) => {},
            register: (_fn: () => void) => {},
            syncManager: {
                getCapabilities: () => ({ supportsPerFileMetadata: true }),
                getFileMetadata: (_p: string) =>
                    Promise.resolve({
                        path: "RemoteOnly.md",
                        encrypted: true,
                    } as const),
            },
            settings: { showExplorerEncryptionIndicator: true },
        } as unknown as Partial<ObsidianGit>;

        const mod = await loadModule();
        (
            mod as unknown as {
                registerExplorerEncryptionIndicator: (
                    p: Partial<ObsidianGit>
                ) => void;
            }
        ).registerExplorerEncryptionIndicator(pluginMock);

        // Wait for debounce and remote lookup
        await new Promise((r) => setTimeout(r, 500));

        const elResult = (document as unknown as FakeDocument).querySelector(
            ".git-vault-encryption-indicator"
        );
        expect(elResult).not.toBeNull();
        expect(elResult?.getAttribute("data-remote-encrypted")).toBe("true");
        expect(
            elResult?.classList.contains(
                "git-vault-encryption-indicator--remote"
            )
        ).toBe(true);
    });
});
