import type { App, TFile } from "obsidian";
import type { IFileHistoryModalHost } from "src/ui/modals/fileHistoryModal";
import type {
    IRuntimeInteractionService,
    ITextPromptOptions,
} from "./runtimeServices";

export interface IRuntimeInteractionServiceHost extends IFileHistoryModalHost {
    app: App;
}

export class RuntimeInteractionService implements IRuntimeInteractionService {
    constructor(private readonly host: IRuntimeInteractionServiceHost) {}

    async chooseBranch(branches: string[]): Promise<string | undefined> {
        const { BranchModal } = await import("src/ui/modals/branchModal");
        return new BranchModal(
            { app: this.host.app },
            branches
        ).openAndGetResult();
    }

    async promptText(options: ITextPromptOptions): Promise<string | undefined> {
        const { GeneralModal } = await import("src/ui/modals/generalModal");
        return new GeneralModal(
            { app: this.host.app },
            options
        ).openAndGetResult();
    }

    openFileHistory(file: TFile): void {
        void import("src/ui/modals/fileHistoryModal")
            .then(({ FileHistoryModal }) => {
                new FileHistoryModal(this.host, file).open();
            })
            .catch((err: unknown) => {
                console.error("openFileHistory failed for", file, err);
            });
    }
}
