import { Setting } from "obsidian";

export type ProviderSectionBlock = {
    name: string;
    desc?: string;
    render: (containerEl: HTMLElement) => void | (() => void);
};

const cleanupByContainer = new WeakMap<HTMLElement, () => void>();

export function renderProviderSectionFrame(
    containerEl: HTMLElement,
    providerName: string,
    sections: ProviderSectionBlock[]
): void {
    cleanupByContainer.get(containerEl)?.();
    cleanupByContainer.delete(containerEl);

    new Setting(containerEl).setName(providerName).setHeading();

    const cleanups: Array<() => void> = [];
    for (const section of sections) {
        const setting = new Setting(containerEl).setName(section.name);
        if (section.desc) {
            setting.setDesc(section.desc);
        }
        setting.setHeading();
        const cleanup = section.render(containerEl);
        if (typeof cleanup === "function") {
            cleanups.push(cleanup);
        }
    }

    cleanupByContainer.set(containerEl, () => {
        for (const cleanup of cleanups.reverse()) {
            cleanup();
        }
    });
}
