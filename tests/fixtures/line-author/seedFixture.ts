/**
 * Deterministic fixture seed scaffold for line-author screenshots and e2e.
 *
 * Planned fixture characteristics:
 * - multiple authors with stable names
 * - commits with distinct timezone offsets
 * - movement/copy history across commits
 * - whitespace-only diff case
 * - tracked and untracked notes
 * - multi-line markdown block for newest-line selection
 *
 * The implementation is intentionally deferred in this first pass.
 */
import * as fs from "fs";
import * as path from "path";

export type SeededLineAuthorFixture = {
    vaultPath: string;
    repoPath: string;
    notes: {
        default: string;
        timezone: string;
        movement: string;
        whitespace: string;
        untracked: string;
    };
};

export function seedLineAuthorFixture(
    vaultPath: string
): SeededLineAuthorFixture {
    const notesDir = path.join(vaultPath, "LineAuthor");
    fs.mkdirSync(notesDir, { recursive: true });

    const seeded: SeededLineAuthorFixture = {
        vaultPath,
        repoPath: vaultPath, // scaffold placeholder: the real git repo root is initialized later during setup, and may differ from the vault path.
        notes: {
            default: path.join(notesDir, "default.md"),
            timezone: path.join(notesDir, "timezone.md"),
            movement: path.join(notesDir, "movement.md"),
            whitespace: path.join(notesDir, "whitespace.md"),
            untracked: path.join(notesDir, "untracked.md"),
        },
    };

    for (const notePath of Object.values(seeded.notes)) {
        if (!fs.existsSync(notePath)) {
            fs.writeFileSync(
                notePath,
                "# Line Author Fixture\n\nTODO: seed deterministic git history for this note.\n",
                "utf8"
            );
        }
    }

    return seeded;
}
