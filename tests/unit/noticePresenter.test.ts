import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomCenterNoticePresenter } from "../../src/notification/noticePresenter";

class FakeElement {
    className = "";
    textContent = "";
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    isConnected = false;

    appendChild(child: FakeElement): FakeElement {
        child.parentElement?.removeChild(child);
        child.parentElement = this;
        child.isConnected = true;
        this.children.push(child);
        return child;
    }

    remove(): void {
        this.parentElement?.removeChild(this);
        this.parentElement = null;
        this.isConnected = false;
    }

    removeChild(child: FakeElement): void {
        this.children = this.children.filter((candidate) => candidate !== child);
        child.parentElement = null;
        child.isConnected = false;
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector === ".git-vault-notice-host") {
            return this.findAllByClass("git-vault-notice-host");
        }
        if (selector === ".git-vault-notice-host > *") {
            const host = this.findAllByClass("git-vault-notice-host")[0];
            return host?.children ?? [];
        }
        return [];
    }

    get childElementCount(): number {
        return this.children.length;
    }

    private findAllByClass(className: string): FakeElement[] {
        const matches: FakeElement[] = [];
        for (const child of this.children) {
            if (child.className.split(" ").includes(className)) {
                matches.push(child);
            }
            matches.push(...child.findAllByClass(className));
        }
        return matches;
    }
}

class FakeDocument {
    body = new FakeElement();

    createElement(): FakeElement {
        return new FakeElement();
    }
}

class FakeMutationObserver {
    constructor(_callback: MutationCallback) {}

    observe(): void {}

    disconnect(): void {}
}

describe("BottomCenterNoticePresenter", () => {
    beforeEach(() => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal("document", fakeDocument);
        vi.stubGlobal("HTMLElement", FakeElement);
        vi.stubGlobal("MutationObserver", FakeMutationObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("creates a singleton host and reparents native notices into it", () => {
        const containerEl = new FakeElement();
        document.body.appendChild(containerEl as unknown as HTMLElement);

        const presenter = new BottomCenterNoticePresenter({
            workspace: { containerEl },
        } as never);

        const first = presenter.show("first", 4000);
        const second = presenter.show("second", 4000);

        const host = containerEl.querySelector(".git-vault-notice-host");
        expect(host).not.toBeNull();
        expect(containerEl.querySelectorAll(".git-vault-notice-host")).toHaveLength(
            1
        );
        expect(host?.children).toHaveLength(2);

        first.hide();
        second.hide();
        presenter.dispose();
    });

    it("updates message text through the returned handle", () => {
        const containerEl = new FakeElement();
        document.body.appendChild(containerEl as unknown as HTMLElement);

        const presenter = new BottomCenterNoticePresenter({
            workspace: { containerEl },
        } as never);

        const notice = presenter.show("before", 0);
        notice.setMessage("after");

        const noticeEl = containerEl.querySelector(".git-vault-notice-host > *");
        expect(noticeEl?.textContent).toBe("after");

        presenter.dispose();
    });

    it("deduplicates identical messages within the short window", () => {
        const containerEl = new FakeElement();
        document.body.appendChild(containerEl as unknown as HTMLElement);

        const presenter = new BottomCenterNoticePresenter({
            workspace: { containerEl },
        } as never);

        presenter.show("same", 4000);
        presenter.show("same", 4000);

        const host = containerEl.querySelector(".git-vault-notice-host");
        expect(host?.children).toHaveLength(1);

        presenter.dispose();
    });

    it("removes the host on dispose", () => {
        const containerEl = new FakeElement();
        document.body.appendChild(containerEl as unknown as HTMLElement);

        const presenter = new BottomCenterNoticePresenter({
            workspace: { containerEl },
        } as never);

        presenter.show("hello", 4000);
        presenter.dispose();

        expect(containerEl.querySelector(".git-vault-notice-host")).toBeNull();
    });
});
