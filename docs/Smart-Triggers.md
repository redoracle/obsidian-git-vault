# Smart Sync Triggers

Smart Triggers allow the plugin to sync automatically in response to activity in your vault — so you never have to remember to press Sync manually.

All triggers are **optional** and **independently configurable** in **Settings → Obsidian Git Vault → Smart sync triggers**.

---

## Available Triggers

### 1. Sync on File Change

Syncs whenever any file in your vault is modified, created, renamed, or deleted.

A debounce delay is applied to batch rapid edits into a single sync. The default is 5 seconds; adjust it in Settings.

| Setting             | Default | Description                                         |
| ------------------- | ------- | --------------------------------------------------- |
| Sync on file change | Off     | Enable/disable the trigger                          |
| Debounce delay      | 5000 ms | Wait this long after the last change before syncing |

**Recommended for:** users who want real-time background sync without thinking about it.

**Caution:** on large vaults with **Gitless Mode** (the GitHub API-based backend that syncs without a local Git installation — see [Gitless-Mode.md](Gitless-Mode.md)), enabling this trigger with a short debounce can approach GitHub API rate limits. Use a debounce of at least 10–30 seconds for large vaults.

---

### 2. Sync on Close

Syncs immediately before Obsidian closes, ensuring no unsaved work is lost.

| Setting       | Default |
| ------------- | ------- |
| Sync on close | Off     |

This trigger responds to Obsidian's `quit` event. On mobile it fires when the app is backgrounded.

**Recommended for:** anyone — this is a safe, low-frequency trigger with no rate-limit risk.

---

### 3. Sync on Network Reconnect

Polls for network connectivity every 30 seconds. When the device comes back online after being offline, a sync is triggered automatically.

| Setting                   | Default |
| ------------------------- | ------- |
| Sync on network reconnect | Off     |

Uses `navigator.onLine` for detection. The poll interval is fixed at 30 seconds and cannot currently be configured.

**Recommended for:** mobile users who frequently move between Wi-Fi and offline environments.

---

### 4. Sync After Idle

Triggers a sync after you have been inactive for a configurable number of minutes. Inactivity is detected by monitoring keyboard, mouse, and touch events.

| Setting         | Default    | Description                                   |
| --------------- | ---------- | --------------------------------------------- |
| Sync after idle | Off (`-1`) | Set to a positive number of minutes to enable |

Set the value to `-1` to disable idle sync. A value of `0` is treated as "no idle wait" and will trigger sync immediately on any input event, which is functionally different from disabling the feature — use `-1` (not `0`) when you want to turn idle sync off entirely.

**Recommended for:** desktop users who prefer to have sync run in the background during natural pauses.

---

## Interaction Between Triggers

Multiple triggers can be active simultaneously. Each uses a shared `PromiseQueue` to prevent concurrent syncs — if a sync is already running when a trigger fires, the new sync is queued and runs immediately after the current one finishes.

---

## Configuration Reference

All settings are in **Settings → Obsidian Git Vault → Smart sync triggers**:

```text
☐ Sync on file change
    Debounce delay: [5000] ms

☐ Sync on close

☐ Sync on network reconnect

Sync after idle: [-1] minutes  (−1 = disabled)
```

---

## Troubleshooting

**Sync fires too frequently**
→ Increase the file-change debounce delay. Start with 15–30 seconds.

**Sync on close doesn't fire on mobile**
→ Mobile OS may kill the app before the quit event fires. Combine with "sync on file change" to ensure changes are saved.

**Idle sync never fires**
→ Confirm the value is a positive integer greater than 0. Check that Obsidian is not receiving periodic background events that reset the idle timer.
