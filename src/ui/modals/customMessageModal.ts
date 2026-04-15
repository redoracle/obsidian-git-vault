import type { App } from "obsidian";
import { moment, SuggestModal } from "obsidian";
import type { ObsidianGitSettings } from "src/types";

export interface CustomMessageModalHost {
    app: App;
    settings: Pick<ObsidianGitSettings, "commitDateFormat">;
}

export class CustomMessageModal extends SuggestModal<string> {
    resolve:
        | ((value: string | PromiseLike<string> | undefined) => void)
        | null = null;
    constructor(private readonly host: CustomMessageModalHost) {
        super(host.app);
        this.setPlaceholder(
            "Type your message and select optional the version with the added date."
        );
    }

    openAndGetResult(): Promise<string | undefined> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onClose() {
        // onClose gets called before onChooseItem
        void new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
            if (this.resolve) this.resolve(undefined);
        });
    }

    getSuggestions(query: string): string[] {
        const date = moment
            .utc()
            .local()
            .format(this.host.settings.commitDateFormat);
        if (query == "") query = "...";
        return [query, `${date}: ${query}`, `${query}: ${date}`];
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.innerText = value;
    }

    onChooseSuggestion(value: string, __: MouseEvent | KeyboardEvent) {
        if (this.resolve) this.resolve(value);
    }
}
