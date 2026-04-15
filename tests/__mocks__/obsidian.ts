/**
 * Minimal mock of the Obsidian API surface used by src/ modules under test.
 * Only implements what the tested units actually call.
 */

// Re-export the real moment.js through the Obsidian mock so that utilities
// that import `moment` from "obsidian" work correctly in unit tests.
export { default as moment } from "moment";

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
}

export class Menu {
    lastShownAt?: { x: number; y: number };

    showAtPosition(position: { x: number; y: number }): void {
        this.lastShownAt = position;
    }
}

export class TFile {
    constructor(public path = "") {}
}

export class Keymap {
    static isModEvent(_event: MouseEvent): boolean {
        return false;
    }
}

export function debounce<T extends unknown[], R>(
    fn: (...args: T) => R,
    _wait: number,
    _immediate?: boolean
): (...args: T) => R {
    return (...args: T) => fn(...args);
}

export function requireApiVersion(_version: string): boolean {
    return true;
}

type MockClassName = string | string[];
type MockElementOptions =
    | string
    | {
          cls?: MockClassName;
          text?: string | Node;
      };

type MockElementHelpers = {
    createDiv(opts?: MockElementOptions): HTMLDivElement & MockElementHelpers;
    createEl<K extends keyof HTMLElementTagNameMap>(
        tag: K,
        opts?: MockElementOptions
    ): HTMLElementTagNameMap[K] & MockElementHelpers;
    createSpan(opts?: MockElementOptions): HTMLSpanElement & MockElementHelpers;
    empty(): void;
};

function createFallbackElement<K extends keyof HTMLElementTagNameMap>(
    _tag: K
): HTMLElementTagNameMap[K] & MockElementHelpers {
    // Provide a minimal DOM-like stub so code that expects basic
    // HTMLElement behavior works in tests without a real DOM.
    type FallbackElement = {
        className: string;
        textContent: string | null;
        classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
        childNodes: unknown[];
        children: unknown[];
        appendChild<T extends Node>(child: T): T;
        removeChild<T extends Node>(child: T): T;
        querySelector(_: string): HTMLElement | null;
        setAttribute(_: string, _v: string): void;
        remove(): void;
        [k: string]: unknown;
    };

    const el = {} as FallbackElement;
    el.className = "";
    el.textContent = "";

    el.classList = {
        add: (...classes: string[]) => {
            const parts = String(el.className).split(/\s+/).filter(Boolean);
            for (const c of classes) {
                if (!parts.includes(c)) parts.push(c);
            }
            el.className = parts.join(" ");
        },
        remove: (...classes: string[]) => {
            let parts = String(el.className).split(/\s+/).filter(Boolean);
            parts = parts.filter((p) => !classes.includes(p));
            el.className = parts.join(" ");
        },
        contains: (c: string) => {
            return (String(el.className).split(/\s+/).filter(Boolean)).includes(c);
        },
    };

    el.childNodes = [];
    el.children = [];

    el.appendChild = function <T extends Node>(child: T): T {
        el.childNodes.push(child);
        el.children.push(child as unknown as Element);
        return child;
    };

    el.removeChild = function <T extends Node>(child: T): T {
        el.childNodes = el.childNodes.filter((c) => c !== child);
        el.children = el.children.filter((c) => c !== (child as unknown));
        return child;
    };

    el.querySelector = () => null;
    el.setAttribute = () => {};
    el.remove = () => {};

    return enhanceElement(el as unknown as HTMLElementTagNameMap[K]);
}

type MockElement = HTMLElement & MockElementHelpers;

function applyElementOptions(el: HTMLElement, opts?: MockElementOptions | string): void {
    if (!opts) return;
    if (typeof opts === "string") {
        el.className = opts;
        return;
    }

    const o = opts as { cls?: MockClassName; text?: string | Node };
    if (o.cls != null) {
        if (Array.isArray(o.cls)) el.className = o.cls.join(" ");
        else if (typeof o.cls === "string") el.className = o.cls;
    }

    if (o.text != null) {
        if (typeof o.text === "string") el.textContent = o.text;
        else if (o.text instanceof Node) el.appendChild(o.text);
        else el.textContent = String(o.text);
    }
}

function appendClassName(el: HTMLElement, className: string) {
    const target = el as unknown as { classList?: { add(...c: string[]): void } };
    if (target.classList && typeof target.classList.add === "function") {
        target.classList.add(className);
        return;
    }
    const parts = String(el.className).split(/\s+/).filter(Boolean);
    if (!parts.includes(className)) parts.push(className);
    el.className = parts.join(" ");
}

function createDivImpl(this: HTMLElement, opts?: MockElementOptions) {
    if (typeof document === "undefined") return createFallbackElement("div");
    const div = document.createElement("div");
    applyElementOptions(div, opts);
    this.appendChild(div);
    return enhanceElement(div);
}

function createElImpl<K extends keyof HTMLElementTagNameMap>(
    this: HTMLElement,
    tag: K,
    opts?: MockElementOptions
): HTMLElementTagNameMap[K] & MockElementHelpers {
    if (typeof document === "undefined") return createFallbackElement(tag);
    const el = document.createElement(tag);
    applyElementOptions(el, opts);
    this.appendChild(el);
    return enhanceElement(el);
}

function createSpanImpl(this: HTMLElement, opts?: MockElementOptions) {
    if (typeof document === "undefined") return createFallbackElement("span");
    const span = document.createElement("span");
    applyElementOptions(span, opts);
    this.appendChild(span);
    return enhanceElement(span);
}

function emptyImpl(this: HTMLElement): void {
    while (this.firstChild) this.removeChild(this.firstChild);
}

function enhanceElement<T extends HTMLElement>(el: T): T & MockElementHelpers {
    const target = el as T & Partial<MockElementHelpers>;
    if (typeof target.createDiv !== "function")
        target.createDiv = createDivImpl;
    if (typeof target.createEl !== "function") target.createEl = createElImpl;
    if (typeof target.createSpan !== "function") {
        target.createSpan = createSpanImpl;
    }
    if (typeof target.empty !== "function") target.empty = emptyImpl;
    return target as T & MockElementHelpers;
}

export class Modal {
    app: unknown;
    // Minimal DOM helpers used by our modals in tests.
    modalEl: MockElement;
    titleEl: HTMLElement;
    contentEl: MockElement;

    constructor(app: unknown) {
        this.app = app;
        this.modalEl =
            typeof document !== "undefined"
                ? enhanceElement(document.createElement("div"))
                : createFallbackElement("div");
        // addClass helper used across code - be defensive when DOM is not
        // available or when the element has no classList (test environments).
        this.modalEl.addClass = (...classes: string[]) =>
            classes.forEach((className) =>
                appendClassName(this.modalEl, className)
            );

        this.titleEl =
            typeof document !== "undefined"
                ? enhanceElement(document.createElement("div"))
                : createFallbackElement("div");
        this.contentEl = createContentEl();
    }
    open() {}
    close() {}
}

function createContentEl(): MockElement {
    return typeof document !== "undefined"
        ? enhanceElement(document.createElement("div"))
        : createFallbackElement("div");
}

// For extra robustness in test environments, add helpers to the
// Element prototype so any DOM element (including ones created by
// application code) supports the minimal `createDiv/createEl/createSpan/empty`
// helpers used throughout the UI code.
if (typeof document !== "undefined") {
    const proto = HTMLElement.prototype as HTMLElement &
        Partial<MockElementHelpers>;

    // Attach to the prototype so any element gains the helpers via
    // inheritance; also ensure the helpers enhance created children so
    // nested helper calls work.
    if (typeof proto.createDiv !== "function") proto.createDiv = createDivImpl;
    if (typeof proto.createEl !== "function") proto.createEl = createElImpl;
    if (typeof proto.createSpan !== "function") {
        proto.createSpan = createSpanImpl;
    }
    if (typeof proto.empty !== "function") proto.empty = emptyImpl;
}

export class Notice {
    noticeEl: HTMLElement;
    constructor(message: string, _timeout?: number) {
        this.noticeEl =
            typeof document !== "undefined"
                ? document.createElement("div")
                : ({} as HTMLElement);
        if (this.noticeEl && "textContent" in this.noticeEl) {
            this.noticeEl.textContent = message;
        }
    }
    hide() {
        if (typeof this.noticeEl?.remove === "function") {
            this.noticeEl.remove();
        }
    }
    setMessage(message: string) {
        if (this.noticeEl && "textContent" in this.noticeEl) {
            this.noticeEl.textContent = message;
        }
    }
}

export class Platform {
    static isMobileApp = false;
    static isDesktopApp = true;
}

export class Plugin {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) {
        this.app = app;
        this.manifest = manifest;
    }
}

export abstract class SuggestModal<T> {
    app: unknown;
    inputEl: HTMLInputElement = {} as HTMLInputElement;
    constructor(app: unknown) {
        this.app = app;
    }
    open() {}
    close() {}
    abstract getSuggestions(query: string): T[] | Promise<T[]>;
    abstract renderSuggestion(value: T, el: HTMLElement): void;
    abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

/** Minimal stub — tests that need real HTTP behaviour should vi.mock this. */
export function requestUrl(_params: unknown): Promise<{
    status: number;
    json: unknown;
    headers: Record<string, string>;
}> {
    return Promise.resolve({ status: 200, json: [], headers: {} });
}
