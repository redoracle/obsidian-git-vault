import type { ExtraButtonComponent } from "obsidian";

export function styleSettingsRefreshButton(button: ExtraButtonComponent): void {
    button.extraSettingsEl.classList.add("git-vault-settings-refresh-btn");
}
