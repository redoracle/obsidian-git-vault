# Getting Started

> **New to Obsidian Git Vault?** Choose your path:
>
> - **Mobile or no Git experience** → see [Mobile-Setup.md](Mobile-Setup.md) and [Simple-Mode.md](Simple-Mode.md)
> - **Desktop with GitHub API (no Git install)** → see [Gitless-Mode.md](Gitless-Mode.md)
> - **Desktop with full Git power** → continue reading below

> [!info] If you use encrypted API sync
> Dedicated-vault clone/import is supported, but the device performing the export must already have the correct encryption passphrase stored locally. The newly cloned vault does not inherit secrets automatically and must be configured on first launch.

---

## Desktop (Git Mode)

Use Git Mode when your desktop has a local Git installation and you want the full Git workflow. You can either [clone an existing remote repository](#for-existing-remote-repository) or [create a new local repository](#create-new-local-repository) and optionally push it to a remote.

## Create new local repository

1. Follow the [Installation](Installation.md) instructions for your operating system.
2. Call the `Initialize a new repo` command
3. Create your first commit by creating some files and calling the `Commit all changes with specific message` command
4. If you want to Setup to push it to a remote repository like to GitHub:
    1. Setup [Authentication](Authentication.md).
    2. Ensure that the remote repository is empty. Otherwise delete the repository and instead proceed to clone the remote repository as described in the [next section](#for-existing-remote-repository).
    3. Call the `Push` command. It should ask you for a name and URL of the remote repository. Just enter `origin` for the remote name and copy the URL to push to somewhere from your remote git service.

## For existing remote repository

To clone, you have to use a remote URL. This can be one of two protocols: either `https` or `ssh`. This depends on your chosen [Authentication](Authentication.md) method.
`https`: `https://github.com/<username>/<repo>.git`
`ssh`: `git@github.com:<username>/<repo>.git`

1. Follow the [Installation](Installation.md) instructions for your operating system.
2. Setup [Authentication](Authentication.md).
3. Git can only clone a remote repo in a new folder. Thus you have two options
    - Use the "Clone an exising remote repository" command to clone your repo into a subfolder of your vault. You then have again two choices
        - Move all your files from the new folder (including `.git` !) into your vault root.
        - Open your new subfolder as a new vault. You may have to install the plugin again.
    - Run `git clone <your-remote-url>` in the command line wherever you want your vault to be located.
4. Read on how to best configure your [`.gitignore`](Tips-and-Tricks.md#gitignore).

> [!info] iCloud and Git
> When syncing your vault with iCloud and using Git on your desktop device the whole `.git` directory gets synced to your mobile device as well. This may slow down the Obsidian startup time.
>
> - One solution is to put the git repository above your Obsidian vault. So that your vault is a sub directory of your git repository.
> - Another solution is to move the `.git` directory to another location and create a `.git` file in your vault with only the following line: `gitdir: <path-to-your-actual-git-directory>`

## Mobile

Use [Mobile Setup](Mobile-Setup.md) for the current recommended mobile path. The plugin defaults mobile devices to Gitless Mode, which uses provider APIs instead of a native Git binary.

Native Git on mobile is not recommended. If you intentionally want an external Git client, alternatives include [GitSync](https://github.com/ViscousPot/GitSync) and [Working Copy](https://workingcopy.app/), but those apps are separate from this plugin.

## Restrictions

I am using [isomorphic-git](https://isomorphic-git.org/), which is a re-implementation of Git in JavaScript, because you cannot use native Git on Android or iOS.

- SSH authentication is not supported ([isomorphic-git issue](https://github.com/isomorphic-git/isomorphic-git/issues/231))
- Repo size is limited, because of memory restrictions
- Rebase merge strategy is not supported
- Submodules are not supported

## Performance on mobile

> [!danger] Warning
> Depending on your device and available free RAM, Obsidian may
>
> - crash on clone/pull
> - create buffer overflow errors
> - run indefinitely.
>
> It's caused by the underlying git implementation on mobile, which is not efficient. I don't know how to fix this. If that's the case for you, I have to admit this plugin won't work for you. So commenting on any issue or creating a new one won't help. I am sorry.

## Start with existing remote repository

### Clone via plugin

Follow these instructions for setting up an Obsidian Vault on a mobile device that is already backed up in a remote git repository.

The instructions assume you are using [GitHub](https://github.com), but can be extrapolated to other providers.

1. Make sure any outstanding changes on all devices are pushed and reconciled with the remote repo.
2. Install Obsidian for Android or iOS.
3. Create a new vault (or point Obsidian to an empty directory). Do NOT select `Store in iCloud` if you are on iOS.
4. If your repo is hosted on GitHub, [authentication must be done with a personal access token](https://github.blog/2020-12-15-token-authentication-requirements-for-git-operations/). Detailed instructions can be found [in the GitHub documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token).
    - Minimal permissions required are
        - "Read access to metadata"
        - "Read and Write access to contents and commit status"
5. In Obsidian settings, enable community plugins. Browse plugins to install Git.
6. Enable Git (on the same screen)
7. Go to Options for the Git plugin (bottom of main settings page, under Community Plugins section)
8. Under the "Authentication/Commit Author" section, fill in the username on your git server and your password/personal access token.
9. Don't touch any settings under "Advanced"
10. Exit plugin settings, open command palette, choose "Git: Clone existing remote repo".
11. Fill in repo URL in the text field and press the repo URL button below it. The repo URL is NOT the URL in the browser. You have to append `.git`. - `https://github.com/<username>/<repo>.git`
    - E.g. `https://github.com/denolehov/obsidian-git.git`
12. Follow instructions to determine the folder to place repo in and whether an `.obsidian` directory already exits.
13. Clone should start. Popup notifications (if not disabled) will display the progress. Do not exit until a popup appears requesting that you "Restart Obsidian".

### Clone via Working Copy on iOS

Depending on the size of your repository and your device, Obsidian may crash during clone via the plugin. Alternatively, the initial clone can be done via [Working Copy](https://workingcopy.app/). None that this a paid app. The usual commit-and-sync can then be done via the plugin. The following guide assumes you don't commit your `.obsidian` directory.

1. Make sure any outstanding changes on all devices are pushed and reconciled with the remote repo.
2. Install Obsidian for Android or iOS.
3. Create a new vault (or point Obsidian to an empty directory). Do NOT select `Store in iCloud` if you are on iOS.
4. If your repo is hosted on GitHub, [authentication must be done with a personal access token](https://github.blog/2020-12-15-token-authentication-requirements-for-git-operations/). Detailed instructions can be found [in the GitHub documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token).
    - Minimal permissions required are
        - "Read access to metadata"
        - "Read and Write access to contents and commit status"
5. Swipe up and away Obsidian to fully close it. Open Working Copy app.
6. Clone the repo using Working Copy. Instead of logging in to GitHub through the Working Copy interface, enter the clone URL directly. Then enter your username, and for the password your Personal Access Token.
7. Open Files app.
8. Copy the repo from Working Copy. Delete the vault from Obsidian and paste the repo there (repo has the same name as the vault).
9. Open Obsidian.
10. All your cloned files should be visible.
11. Install and enable the Git plugin.
12. Add your name/email to the "Authentication/Commit Author" section in the plugin settings.
13. Use the command palette to call the "Pull" command.

## Start with new repo

Similar steps as [Start with existing remote repository](#start-with-existing-remote-repository), except use the `Initialize a new repo` command, followed by `Edit remotes` to add the remote repo to track. This remote repo will need to exist and be empty. Also make sure to read on how to best configure your [`.gitignore`](Tips-and-Tricks.md#gitignore).
