import fs from "fs";
import path from "path";

const BASE_CSS_PATH = path.resolve(__dirname, "../harness/_base.css");

let BASE_CSS: string;
try {
  BASE_CSS = fs.readFileSync(BASE_CSS_PATH, "utf8");
} catch (error) {
  throw new Error(
    `Failed to load screenshot base CSS from ${BASE_CSS_PATH}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(options: {
  title: string;
  targetStyle: string;
  bodyStyle: string;
  content: string;
  extraCss?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(options.title)}</title>
  <style>
${BASE_CSS}
${options.extraCss ?? ""}
  </style>
</head>
<body style="${options.bodyStyle}">
  <div id="screenshot-target" class="screenshot-wrap" style="${options.targetStyle}">
${options.content}
  </div>
</body>
</html>`;
}

function svgIcon(body: string, size = 14): string {
  return `<svg class="svg-icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const ICON = {
  app: svgIcon(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>`),
  file: svgIcon(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`),
  sync: svgIcon(`<path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2"/>`),
  check: svgIcon(`<polyline points="20 6 9 17 4 12"/>`),
  plus: svgIcon(`<line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>`),
  minus: svgIcon(`<line x1="8" y1="12" x2="16" y2="12"/>`),
  push: svgIcon(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`),
  pull: svgIcon(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`),
  layout: svgIcon(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`),
  refresh: svgIcon(`<path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2"/>`),
  history: svgIcon(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
  diff: svgIcon(`<rect x="4" y="4" width="6" height="16" rx="1"/><rect x="14" y="4" width="6" height="16" rx="1"/><path d="M10 8h4"/><path d="M10 12h4"/><path d="M10 16h4"/>`),
  settings: svgIcon(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.8 7.8 0 0 0 0-6l2-1.2-2-3.5-2.2 1a7.7 7.7 0 0 0-5.2-3l-.4-2.3H10l-.4 2.3a7.7 7.7 0 0 0-5.2 3l-2.2-1-2 3.5 2 1.2a7.8 7.8 0 0 0 0 6l-2 1.2 2 3.5 2.2-1a7.7 7.7 0 0 0 5.2 3l.4 2.3h2l.4-2.3a7.7 7.7 0 0 0 5.2-3l2.2 1 2-3.5-2-1.2Z"/>`),
  shield: svgIcon(`<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/>`),
  note: svgIcon(`<path d="M14 2H6a2 2 0 0 0-2 2v16l4-2 4 2 4-2 4 2V8z"/><path d="M14 2v6h6"/>`),
  metadata: svgIcon(`<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>`),
  signs: svgIcon(`<path d="M6 4h10v16H6z"/><path d="M8 8h6"/><path d="M8 12h6"/><path d="M8 16h4"/>`),
};

function toolbarButton(label: string, icon: string, active = false): string {
  return `<button class="toolbar-button${active ? " is-active" : ""}">${icon}<span>${escapeHtml(label)}</span></button>`;
}

function sectionHeading(title: string): string {
  return `<div class="setting-item setting-item-heading"><div class="setting-item-info"><div class="setting-item-name">${escapeHtml(title)}</div></div></div>`;
}

function settingItem(name: string, description: string, control: string): string {
  return `<div class="setting-item"><div class="setting-item-info"><div class="setting-item-name">${escapeHtml(name)}</div><div class="setting-item-description">${description}</div></div><div class="setting-item-control">${control}</div></div>`;
}

function checkbox(enabled: boolean): string {
  return `<div class="checkbox-container${enabled ? " is-enabled" : ""}"></div>`;
}

function select(options: string[], selected: string): string {
  return `<select>${options.map((option) => `<option${option === selected ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
}

function textInput(value: string, type = "text", minWidth?: number): string {
  return `<input type="${type}" value="${escapeHtml(value)}"${minWidth ? ` style="min-width:${minWidth}px;"` : ""}>`;
}

function textArea(value: string, rows = 6): string {
  return `<textarea rows="${rows}">${escapeHtml(value)}</textarea>`;
}

function treeFile(name: string, badge: string, badgeClass: string): string {
  return `<div class="nav-file-title"><span class="nav-file-title-content">${escapeHtml(name)}</span><span class="file-type-badge file-type-${badgeClass}">${escapeHtml(badge)}</span></div>`;
}

function historyRow(author: string, date: string, message: string, refs = ""): string {
  return `<div class="tree-item nav-folder"><div class="tree-item-self is-clickable nav-folder-title"><div class="tree-item-icon nav-folder-collapse-indicator collapse-icon">${ICON.note}</div><div>${refs ? `<div class="git-ref">${escapeHtml(refs)}</div>` : ""}<div class="git-author">${escapeHtml(author)}</div><div class="git-date">${escapeHtml(date)}</div><div class="tree-item-inner nav-folder-title-content">${escapeHtml(message)}</div></div></div></div>`;
}

function diffLine(kind: "add" | "remove" | "neutral", text: string): string {
  const marker = kind === "add" ? "+" : kind === "remove" ? "-" : "";
  return `<div class="diff-line diff-${kind}"><span class="diff-gutter">${marker}</span><span class="diff-code">${escapeHtml(text)}</span></div>`;
}

function diffPane(title: string, lines: Array<["add" | "remove" | "neutral", string]>): string {
  return `<div class="diff-pane"><div class="diff-pane-title">${escapeHtml(title)}</div>${lines.map(([kind, text]) => diffLine(kind, text)).join("")}</div>`;
}

type SimpleModeStatus = "idle" | "syncing" | "conflict" | "offline";

const statusClassMap: Record<SimpleModeStatus, string> = {
  idle: "status-ok",
  syncing: "status-syncing",
  conflict: "status-conflict",
  offline: "status-offline",
};

const statusTextMap: Record<
  SimpleModeStatus,
  string | ((options: { conflictCount?: number }) => string)
> = {
  idle: "All notes are up to date",
  syncing: "Syncing your notes…",
  conflict: (options) => `${options.conflictCount ?? 2} conflict(s) need attention`,
  offline: "Offline – changes will sync when reconnected",
};

export function renderSimpleMode(options: {
  status: SimpleModeStatus;
  provider: string;
  lastSync: string;
  syncCount?: number;
  scope?: string;
  conflictCount?: number;
}): string {
  const statusClass = statusClassMap[options.status] || "status-ok";
  const statusTextValue = statusTextMap[options.status];
  const statusText =
    (typeof statusTextValue === "function"
      ? statusTextValue(options)
      : statusTextValue) || "All notes are up to date";
  const buttonText = options.status === "syncing" ? "Syncing…" : "Sync";
  const conflictButton = options.status === "conflict" ? `<button class="git-vault-conflict-btn">Resolve ${options.conflictCount ?? 2} Conflicts</button>` : "";
  const metaParts = [] as string[];
  if (options.scope) metaParts.push(`Scope: ${escapeHtml(options.scope)}`);
  metaParts.push(`Last sync: ${escapeHtml(options.lastSync)}`);
  if (options.syncCount && options.syncCount > 0) metaParts.push(`${options.syncCount} sync${options.syncCount === 1 ? "" : "s"} this session`);

  return page({
    title: `Simple Mode – ${options.status}`,
    targetStyle: "width:340px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    content: `
    <div class="view-header">
      <span class="view-header-title-icon">${ICON.app}</span>
      <span class="view-header-title">Source Control</span>
    </div>
    <div class="git-vault-simple view-content">
      <div class="git-vault-header">
        <span class="git-vault-title">Obsidian Git Vault</span>
        <span class="git-vault-provider-badge">${escapeHtml(options.provider)}</span>
      </div>
      <div class="git-vault-status ${statusClass}">
        <span class="git-vault-status-dot"></span>
        <span class="git-vault-status-text">${escapeHtml(statusText)}</span>
      </div>
      <button type="button" class="git-vault-sync-btn mod-cta"${options.status === "syncing" ? " disabled" : ""}>${escapeHtml(buttonText)}</button>
      ${conflictButton}
      <div class="git-vault-meta">${metaParts.map((part) => `<span>${part}</span>`).join("<span>·</span>")}</div>
    </div>`,
  });
}

export function renderMobileSimpleMode(syncing: boolean): string {
  return page({
    title: syncing ? "Mobile Simple Mode – Syncing" : "Mobile Simple Mode",
    targetStyle: "width:320px;",
    bodyStyle: "padding:12px;display:flex;justify-content:center;",
    content: `
    <div class="view-header">
      <span class="view-header-title-icon">${ICON.app}</span>
      <span class="view-header-title">Source Control</span>
    </div>
    <div class="git-vault-simple view-content">
      <div class="git-vault-header">
        <span class="git-vault-title">Obsidian Git Vault</span>
        <span class="git-vault-provider-badge">GitHub API</span>
      </div>
      <div class="git-vault-status ${syncing ? "status-syncing" : "status-ok"}">
        <span class="git-vault-status-dot"></span>
        <span class="git-vault-status-text">${syncing ? "Syncing your notes…" : "All notes are up to date"}</span>
      </div>
      <button class="git-vault-sync-btn mod-cta"${syncing ? " disabled" : ""}>${syncing ? "Syncing…" : "Sync"}</button>
      <div class="git-vault-meta">
        <span>Scope: Vault root</span>
        <span>·</span>
        <span>Last sync: 2:41 PM</span>
      </div>
    </div>`,
  });
}

export function renderSourceControl(mode: "unstaged" | "staged" | "commit"): string {
  const staged =
    mode === "unstaged"
      ? `<div class="tree-item staged"><div class="tree-item-self nav-folder-title is-clickable"><div class="tree-item-icon">${ICON.note}</div><div class="tree-item-inner nav-folder-title-content">Staged Changes</div><div class="git-tools"><div class="buttons"><div class="clickable-icon" aria-label="Unstage all">${ICON.minus}</div></div><div class="files-count">0</div></div></div><div class="tree-item-children"><div class="nav-file-title nav-file-title-empty"><span class="nav-file-title-content">No staged files</span></div></div></div>`
      : `<div class="tree-item staged"><div class="tree-item-self nav-folder-title is-clickable"><div class="tree-item-icon">${ICON.note}</div><div class="tree-item-inner nav-folder-title-content">Staged Changes</div><div class="git-tools"><div class="buttons"><div class="clickable-icon" aria-label="Unstage all">${ICON.minus}</div></div><div class="files-count">2</div></div></div><div class="tree-item-children">${treeFile("Projects/Q4-Plan.md", "M", "M")}${treeFile("Meeting Notes/2024-04-08.md", "A", "A")}</div></div>`;

  const changes =
    mode === "unstaged"
      ? `<div class="tree-item"><div class="tree-item-self nav-folder-title is-clickable"><div class="tree-item-icon">${ICON.note}</div><div class="tree-item-inner nav-folder-title-content">Changes</div><div class="git-tools"><div class="buttons"><div class="clickable-icon" aria-label="Stage all">${ICON.plus}</div><div class="clickable-icon" aria-label="Discard all">${ICON.minus}</div></div><div class="files-count">3</div></div></div><div class="tree-item-children">${treeFile("Daily Notes/2024-04-07.md", "M", "M")}${treeFile("Daily Notes/2024-04-08.md", "A", "A")}${treeFile("Archive/old-meeting.md", "D", "D")}</div></div>`
      : `<div class="tree-item"><div class="tree-item-self nav-folder-title is-clickable"><div class="tree-item-icon">${ICON.note}</div><div class="tree-item-inner nav-folder-title-content">Changes</div><div class="git-tools"><div class="buttons"><div class="clickable-icon" aria-label="Stage all">${ICON.plus}</div><div class="clickable-icon" aria-label="Discard all">${ICON.minus}</div></div><div class="files-count">1</div></div></div><div class="tree-item-children">${treeFile("Daily Notes/2024-04-08.md", "M", "M")}</div></div>`;

  const commitMessage = mode === "commit" ? "Prepare release notes" : "Weekly notes update";
  const commitSummary = mode === "commit" ? `<div class="commit-summary"><strong>Ready to commit</strong><span>2 staged files · 1 unstaged file · push queued after commit</span></div>` : "";

  return page({
    title: `Source Control – ${mode}`,
    targetStyle: "width:360px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: `
    .toolbar-button { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 8px; }
    .toolbar-button svg { width: 12px; height: 12px; }
    .source-toolbar { display: flex; gap: 4px; flex-wrap: wrap; padding: 4px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
    .commit-summary { display: flex; flex-direction: column; gap: 4px; padding: 10px 8px 0; color: var(--text-muted); font-size: 0.82em; }
    .commit-summary strong { color: var(--text-normal); font-size: 0.95em; }
    .nav-file-title-empty { padding-left: 28px; color: var(--text-faint); }
    `,
    content: `
    <div class="view-header">
      <span class="view-header-title-icon">${ICON.file}</span>
      <span class="view-header-title">Source Control</span>
    </div>
    <div class="view-content">
      <div class="source-toolbar">
        ${toolbarButton("Commit-and-sync", ICON.sync)}
        ${toolbarButton("Commit", ICON.check, mode === "commit")}
        ${toolbarButton("Stage all", ICON.plus)}
        ${toolbarButton("Unstage all", ICON.minus)}
        ${toolbarButton("Push", ICON.push, mode === "commit")}
        ${toolbarButton("Pull", ICON.pull)}
        ${toolbarButton("Layout", ICON.layout)}
        ${toolbarButton("Refresh", ICON.refresh)}
      </div>
      <div class="git-commit-msg">
        <textarea class="commit-msg-input" rows="2" placeholder="Commit Message">${escapeHtml(commitMessage)}</textarea>
        ${commitSummary}
      </div>
      <div class="nav-files-container">
        <div class="tree-item">${staged}${changes}</div>
      </div>
    </div>`,
  });
}

export function renderDiffView(variant: "split" | "inline"): string {
  const split = `
    <div class="diff-toolbar">
      <button class="toolbar-button is-active">${ICON.diff}<span>Split</span></button>
      <button class="toolbar-button">${ICON.file}<span>Inline</span></button>
      <div class="diff-file-chip">Daily Notes/2024-04-08.md</div>
    </div>
    <div class="diff-split-grid">
      ${diffPane("Local (your version)", [
        ["neutral", "# Daily Notes"],
        ["remove", "- Focus on feature X today"],
        ["neutral", "- Review API sync settings"],
        ["remove", "- Push after lunch"],
        ["neutral", ""],
        ["neutral", "## Notes"],
        ["neutral", "Capture the new release checklist."],
      ])}
      ${diffPane("Remote (incoming)", [
        ["neutral", "# Daily Notes"],
        ["add", "+ Focus on feature Y today"],
        ["neutral", "- Review API sync settings"],
        ["add", "+ Send release summary"],
        ["neutral", ""],
        ["neutral", "## Notes"],
        ["neutral", "Capture the new release checklist."],
      ])}
    </div>`;

  const inline = `
    <div class="diff-toolbar">
      <button class="toolbar-button">${ICON.diff}<span>Split</span></button>
      <button class="toolbar-button is-active">${ICON.file}<span>Inline</span></button>
      <div class="diff-file-chip">Project Plan.md</div>
    </div>
    <div class="diff-inline-panel">
      <div class="diff-pane-title">Project Plan.md</div>
      ${diffLine("remove", "- Outline release milestones")}
      ${diffLine("add", "+ Outline release milestones and owners")}
      ${diffLine("neutral", "  • Week 1: finalize notes migration")}
      ${diffLine("remove", "- Week 2: publish draft")}
      ${diffLine("add", "+ Week 2: publish draft and changelog")}
      ${diffLine("neutral", "  • Week 3: feedback round")}
      ${diffLine("add", "+ Week 4: polish screenshots and docs")}
    </div>`;

  return page({
    title: `Diff Viewer – ${variant}`,
    targetStyle: "width:720px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: `
    .diff-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
    .diff-file-chip { margin-left: auto; font-size: 0.8em; color: var(--text-muted); background: var(--background-primary); border: 1px solid var(--background-modifier-border); padding: 4px 8px; border-radius: 999px; }
    .diff-split-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 14px; }
    .diff-pane { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); overflow: hidden; }
    .diff-pane-title { padding: 8px 10px; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); border-bottom: 1px solid var(--background-modifier-border); }
    .diff-line { display: flex; gap: 8px; align-items: flex-start; padding: 4px 10px; font-family: var(--font-monospace); font-size: 0.82em; line-height: 1.45; white-space: pre-wrap; }
    .diff-gutter { width: 14px; text-align: center; flex-shrink: 0; color: var(--text-faint); }
    .diff-add { background: rgba(76, 175, 80, 0.08); }
    .diff-add .diff-gutter { color: var(--color-green); }
    .diff-remove { background: rgba(227, 93, 93, 0.08); }
    .diff-remove .diff-gutter { color: var(--color-red); }
    .diff-inline-panel { margin: 14px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); overflow: hidden; }
    .diff-inline-panel .diff-line { border-top: 1px solid rgba(255,255,255,0.03); }
    .diff-inline-panel .diff-line:first-of-type { border-top: none; }
    `,
    content: `
    <div class="view-header">
      <span class="view-header-title-icon">${ICON.diff}</span>
      <span class="view-header-title">Diff Viewer</span>
    </div>
    <div class="view-content">${variant === "split" ? split : inline}</div>`,
  });
}

export function renderHistoryView(details: boolean): string {
  const list = `
    <div class="history-toolbar">
      <button class="toolbar-button is-active">${ICON.history}<span>List</span></button>
      <button class="toolbar-button">${ICON.layout}<span>Tree</span></button>
      <button class="toolbar-button">${ICON.refresh}<span>Refresh</span></button>
    </div>
    <div class="nav-files-container history-list">
      ${historyRow("Avery Stone", "Apr 8, 2026 · 14:21", "Update Q4 plan", "main, HEAD")}
      ${historyRow("Avery Stone", "Apr 8, 2026 · 09:14", "Document API sync settings")}
      ${historyRow("Jordan Lee", "Apr 7, 2026 · 18:07", "Resolve merge conflict")}
      ${historyRow("Jordan Lee", "Apr 6, 2026 · 11:33", "Add mobile sync notes")}
    </div>`;

  const detailsPane = `
    <div class="history-detail-card">
      <div class="history-detail-topline">
        <span class="history-badge">9f2c4d1</span>
        <span class="history-badge muted">main</span>
      </div>
      <div class="history-detail-title">Document API sync settings</div>
      <div class="history-detail-meta">Avery Stone · Apr 8, 2026 · 09:14</div>
      <p class="history-detail-body">Selected commit details, with the changed files available below the summary. Clicking a file opens the diff or the note itself.</p>
      <div class="history-detail-actions">
        <button class="mod-cta">View changed files</button>
        <button>Open file history</button>
      </div>
      <div class="history-changed-files">
        <div class="history-changed-files-title">Changed files</div>
        <div class="history-file-row"><span>Settings/Sync.md</span><span class="history-file-status">M</span></div>
        <div class="history-file-row"><span>Notes/Release Plan.md</span><span class="history-file-status">A</span></div>
        <div class="history-file-row"><span>Archive/old-sync-note.md</span><span class="history-file-status">D</span></div>
      </div>
    </div>`;

  return page({
    title: details ? "History View – details" : "History View",
    targetStyle: "width:360px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: `
    .history-toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
    .history-list { padding: 10px 0 4px; }
    .git-ref { font-size: 0.7em; color: var(--text-accent); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
    .git-author { font-size: 0.82em; font-weight: 600; color: var(--text-normal); }
    .git-date { font-size: 0.72em; color: var(--text-faint); margin: 2px 0 4px; }
    .history-detail-card { margin: 12px; padding: 14px; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); background: var(--background-secondary); display: flex; flex-direction: column; gap: 10px; }
    .history-detail-topline { display: flex; gap: 6px; align-items: center; }
    .history-badge { font-size: 0.72em; padding: 3px 8px; border-radius: 999px; background: var(--interactive-accent); color: var(--text-on-accent); }
    .history-badge.muted { background: var(--background-modifier-border); color: var(--text-muted); }
    .history-detail-title { font-size: 1.02em; font-weight: 700; }
    .history-detail-meta { font-size: 0.78em; color: var(--text-muted); }
    .history-detail-body { margin: 0; font-size: 0.86em; color: var(--text-muted); }
    .history-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .history-changed-files { border-top: 1px solid var(--background-modifier-border); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
    .history-changed-files-title { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .history-file-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: var(--radius-s); font-size: 0.86em; }
    .history-file-status { font-size: 0.72em; color: var(--text-muted); }
    `,
    content: `
    <div class="view-header">
      <span class="view-header-title-icon">${ICON.history}</span>
      <span class="view-header-title">History View</span>
    </div>
    <div class="view-content">${details ? detailsPane : list}</div>`,
  });
}

export function renderConflictResolver(mode: "main" | "manual" | "actions"): string {
  const manual = mode === "manual";
  const actionsOnly = mode === "actions";
  const actionButtons = actionsOnly
    ? `<div class="git-vault-conflict-actions conflict-actions-lg"><button class="mod-cta">Keep Local</button><button>Keep Remote</button><button>Edit Manually</button><button class="git-vault-skip-btn">Skip</button></div>`
    : `<div class="git-vault-conflict-actions"><button class="mod-cta">Keep Local</button><button>Keep Remote</button><button>${manual ? "Apply Manual Merge" : "Edit Manually"}</button><button class="git-vault-skip-btn">Skip</button></div>`;

  const manualSection = manual
    ? `<div class="git-vault-manual-section" style="display:block;"><h3>Manual merge</h3>${textArea(`# Meeting Notes – Q4 Planning\n\n## Attendees\n- Alice, Bob, Carol, Dave\n\n## Action Items\n- Review Q4 roadmap\n- Schedule follow-up for Jan 22\n- Send summary email\n\n## Notes\nPrioritise feature X first, then Y. Dave to send summary email.`, 9)}</div>`
    : "";

  const diffHeight = manual || actionsOnly ? "max-height:110px;" : "";

  return page({
    title: `Conflict Resolver – ${mode}`,
    targetStyle: "width:900px;",
    bodyStyle: "padding:32px;display:flex;justify-content:center;align-items:flex-start;background:#111;",
    extraCss: `
    .modal { background: var(--background-primary); border-radius: var(--radius-l); box-shadow: 0 8px 48px rgba(0,0,0,0.7); overflow: hidden; width: 100%; }
    .modal-title { font-size: 1.15em; font-weight: 700; padding: 20px 24px 14px; border-bottom: 1px solid var(--background-modifier-border); display: flex; align-items: center; gap: 12px; }
    .conflict-counter { font-size: 0.8em; font-weight: 500; color: var(--text-muted); background: var(--background-secondary); padding: 2px 10px; border-radius: 999px; border: 1px solid var(--background-modifier-border); }
    .modal-content { padding: 20px 24px 24px; }
    .conflict-progress { margin-bottom: 12px; }
    .conflict-progress-bar { height: 8px; border-radius: 999px; background: var(--background-secondary); overflow: hidden; border: 1px solid var(--background-modifier-border); }
    .conflict-progress-fill { width: 50%; height: 100%; background: var(--interactive-accent); }
    .conflict-progress-label { font-size: 0.78em; color: var(--text-muted); margin-top: 6px; }
    .git-vault-conflict-binary-info { padding: 12px; border-radius: var(--radius-s); background: var(--background-secondary); color: var(--text-muted); margin-bottom: 16px; }
    .conflict-actions-lg button { min-height: 42px; }
    `,
    content: `
    <div class="modal">
      <div class="modal-title">${ICON.shield}<span>Resolve Merge Conflicts</span><span class="conflict-counter">1 / 2</span></div>
      <div class="modal-content">
        <div class="conflict-progress"><div class="conflict-progress-bar"><div class="conflict-progress-fill"></div></div><div class="conflict-progress-label">1 of 2 · 0 resolved</div></div>
        <p class="git-vault-conflict-path">Notes/Meeting Notes.md</p>
        ${actionsOnly ? `<div class="git-vault-conflict-binary-info">Use the buttons below to resolve the current conflict before syncing continues.</div>` : `<div class="git-vault-conflict-grid"><div class="git-vault-conflict-col"><h3>Local — your version</h3><pre class="git-vault-conflict-content" style="${diffHeight}">${escapeHtml(`# Meeting Notes – Q4 Planning\n\n## Attendees\n- Alice, Bob, Carol\n\n## Action Items\n- Review Q4 roadmap\n- Schedule follow-up for Jan 20\n\n## Notes\nDecided to prioritise feature X\nover feature Y for the quarter.`)}</pre></div><div class="git-vault-conflict-col"><h3>Remote — incoming</h3><pre class="git-vault-conflict-content" style="${diffHeight}">${escapeHtml(`# Meeting Notes – Q4 Planning\n\n## Attendees\n- Alice, Bob, Carol, Dave\n\n## Action Items\n- Review Q4 roadmap\n- Schedule follow-up for Jan 22\n- Send summary email\n\n## Notes\nPrioritise feature Y first, then X.`)}</pre></div></div>`}
        ${manualSection}
        ${actionButtons}
        ${!actionsOnly ? `<div class="git-vault-conflict-hints"><kbd>L</kbd> keep local <span>·</span> <kbd>R</kbd> keep remote <span>·</span> <kbd>S</kbd> skip</div>` : ""}
      </div>
    </div>`,
  });
}

export function renderSettingsPage(section: "overview" | "backend" | "triggers" | "conflicts" | "encryption"): string {
  const common = `
    ${sectionHeading("General")}
    ${settingItem("UI mode", "Simple mode shows a single Sync button. Advanced mode gives full Git control.", select(["Simple", "Advanced"], "Advanced"))}
    ${settingItem("Sync backend", "Git uses the local repository. API backends sync directly against GitHub, GitLab, or Gitea/Forgejo without requiring Git on the device.", select(["Git", "GitHub API", "GitLab API", "Gitea / Forgejo API"], section === "backend" ? "GitHub API" : "Git"))}
  `;

  const backend = `
    ${sectionHeading("GitHub API settings")}
    ${settingItem("GitHub personal access token", "Stored in Obsidian secret storage on this device, not in synced plugin settings.", textInput("ghp_xxxxxxxxxxxxxxxxxxxx", "password"))}
    ${settingItem("GitHub owner", "Account or organisation that owns the repository.", textInput("my-username"))}
    ${settingItem("GitHub repository", "Name of the repository to sync with.", textInput("my-obsidian-vault"))}
    ${settingItem("Branch", "Branch to sync against (default: main).", textInput("main", "text", 120))}
  `;

  const triggers = `
    ${sectionHeading("Smart sync triggers")}
    ${settingItem("Sync on file change", "Automatically sync when notes are created, modified, or deleted.", checkbox(true))}
    ${settingItem("File-change debounce (ms)", "Wait this many ms after the last file change before syncing (default: 5000).", textInput("5000", "number", 120))}
    ${settingItem("Sync on app close", "Trigger a sync when Obsidian quits.", checkbox(true))}
    ${settingItem("Sync on network reconnect", "Automatically sync when the device regains internet connectivity.", checkbox(true))}
    ${settingItem("Sync after idle (minutes)", "Sync after this many minutes of inactivity. Set to -1 to disable.", textInput("-1", "number", 120))}
  `;

  const conflicts = `
    ${sectionHeading("Conflict Resolution")}
    ${settingItem("Conflict resolution strategy", "Choose how conflicts are handled when local and remote changes differ. Manual is the safer default and prompts you to review each conflict in the visual resolver before anything is overwritten.", select(["Manual (prompt before resolving)", "Last write wins (may overwrite remote changes)", "Always keep local", "Always keep remote"], "Manual (prompt before resolving)"))}
    ${settingItem("Conflict resolution history", "View a local log of past conflict resolutions without storing note contents.", `<button class="mod-cta">Open history</button>`)}
  `;

  const encryption = `
    ${sectionHeading("API sync scope and transforms")}
    ${settingItem("Tracked directory", "Optional vault-relative folder to sync in API mode. Its contents map to the remote repository root; everything outside stays local.", textInput("Projects/Sync Vault"))}
    ${settingItem("Excluded paths", "One .gitignore-style rule per line. Rules are applied after tracked-directory scoping and only affect API backends.", `<textarea rows="4">Drafts/**\n*.tmp\nExports/private/**</textarea>`)}
    ${settingItem("Encrypt API sync contents", "Automatically encrypts each file's content with AES-256-GCM before uploading it to the remote repository, and decrypts it transparently on download.", checkbox(true))}
    ${settingItem("Encryption passphrase", "Stored in Obsidian secret storage on this device only. Devices that should decrypt the same vault need the same passphrase.", textInput("correct horse battery staple", "password"))}
  `;

  const overview = `
    ${sectionHeading("GitHub Credentials")}
    ${settingItem("GitHub token", "Personal access token with repository read/write scope.", textInput("ghp_xxxxxxxxxxxxxxxxxxxx", "password"))}
    ${settingItem("GitHub owner", "Your GitHub username or organisation name.", textInput("my-username"))}
    ${settingItem("Repository", "Name of the repository that stores your vault.", textInput("my-obsidian-vault"))}
    ${settingItem("Branch", "Branch to sync with. Defaults to main.", textInput("main", "text", 120))}
    ${sectionHeading("Smart sync triggers")}
    ${settingItem("Sync on file change", "Automatically sync shortly after you stop editing.", checkbox(true))}
    ${settingItem("Sync on vault close", "Push any pending changes when Obsidian closes.", checkbox(true))}
    ${settingItem("Sync on network reconnect", "Resume syncing automatically when you come back online.", checkbox(true))}
    ${settingItem("Sync after idle (minutes)", "Sync when you haven't made changes for this many minutes. Set to -1 to disable.", textInput("-1", "number", 120))}
  `;

  const body =
    section === "backend"
      ? common + backend
      : section === "triggers"
        ? common + triggers
        : section === "conflicts"
          ? common + conflicts
          : section === "encryption"
            ? common + encryption
            : common + overview;

  return page({
    title: `Settings – ${section}`,
    targetStyle: "width:780px;",
    bodyStyle: "margin:0;padding:32px;background:#111;display:flex;justify-content:center;align-items:flex-start;",
    extraCss: `
    #screenshot-target { width: 780px; background: var(--background-primary); border-radius: var(--radius-l); box-shadow: 0 8px 48px rgba(0,0,0,0.7); overflow: hidden; }
    .settings-header { display: flex; align-items: center; gap: 10px; padding: 20px 24px 16px; border-bottom: 1px solid var(--background-modifier-border); background: var(--background-secondary); }
    .settings-header-icon { width: 32px; height: 32px; background: var(--interactive-accent); border-radius: var(--radius-m); display: flex; align-items: center; justify-content: center; }
    .settings-title { font-size: 1.1em; font-weight: 700; }
    .settings-version { font-size: 0.75em; color: var(--text-faint); background: var(--background-modifier-border); padding: 2px 8px; border-radius: 999px; margin-left: auto; }
    .vertical-tab-content { padding: 16px 24px; max-width: 740px; background: var(--background-primary); }
    .setting-item-control select, .setting-item-control input[type="text"], .setting-item-control input[type="password"], .setting-item-control input[type="number"], .setting-item-control textarea { min-width: 200px; background: var(--background-modifier-form-field); }
    .setting-item-control input[type="number"] { min-width: 80px; }
    .setting-item-control textarea { min-width: 260px; min-height: 92px; resize: vertical; }
    .setting-item-control button { white-space: nowrap; }
    `,
    content: `
    <div class="settings-header">
      <div class="settings-header-icon">${ICON.settings}</div>
      <span class="settings-title">Obsidian Git Vault</span>
      <span class="settings-version">v1.0.0</span>
    </div>
    <div class="vertical-tab-content">${body}</div>`,
  });
}

export function renderSigns(): string {
  return page({
    title: "Editor Signs",
    targetStyle: "width:540px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: `
    .editor-shell { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); overflow: hidden; width: 100%; }
    .editor-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-muted); font-size: 0.8em; }
    .editor-body { font-family: var(--font-monospace); padding: 12px 0; }
    .editor-row { display: grid; grid-template-columns: 56px 28px 1fr; align-items: center; gap: 8px; padding: 2px 12px; line-height: 1.6; font-size: 0.82em; }
    .editor-line-number { color: var(--text-faint); text-align: right; }
    .editor-sign { width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 0.75em; font-weight: 700; }
    .editor-sign.add { color: var(--color-green); background: rgba(76,175,80,0.14); }
    .editor-sign.remove { color: var(--color-red); background: rgba(227,93,93,0.14); }
    .editor-sign.change { color: var(--color-orange); background: rgba(224,154,90,0.14); }
    .editor-line-number.add { color: var(--color-green); }
    .editor-line-number.remove { color: var(--color-red); }
    .editor-line-number.change { color: var(--color-orange); }
    .editor-code.add { background: rgba(76,175,80,0.06); }
    .editor-code.remove { background: rgba(227,93,93,0.06); }
    .editor-code.change { background: rgba(224,154,90,0.06); }
    `,
    content: `
    <div class="editor-shell">
      <div class="editor-toolbar">${ICON.signs}<span>Editor gutter signs</span></div>
      <div class="editor-body">
        <div class="editor-row"><span class="editor-line-number">12</span><span class="editor-sign change">M</span><span class="editor-code change">- [ ] Update README screenshots</span></div>
        <div class="editor-row"><span class="editor-line-number">13</span><span class="editor-sign add">+</span><span class="editor-code add">+ Add simple-mode-idle.png</span></div>
        <div class="editor-row"><span class="editor-line-number">14</span><span class="editor-sign remove">-</span><span class="editor-code remove">- Remove outdated SVG reference</span></div>
        <div class="editor-row"><span class="editor-line-number">15</span><span class="editor-sign change">M</span><span class="editor-code change">- [ ] Refresh history-view.png</span></div>
        <div class="editor-row"><span class="editor-line-number">16</span><span class="editor-sign add">+</span><span class="editor-code add">+ Capture settings-encryption.png</span></div>
      </div>
    </div>`,
  });
}

export function renderSyncMetadataSidebar(): string {
  return page({
    title: "Sync Metadata Sidebar",
    targetStyle: "width:320px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: `
    .sync-metadata { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
    .sync-metadata h2 { margin: 0; font-size: 1.02em; }
    .sync-metadata-path { font-size: 0.78em; color: var(--text-muted); word-break: break-all; }
    .sync-metadata-row { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: var(--radius-s); font-size: 0.82em; }
    .sync-metadata-row .name { color: var(--text-muted); }
    .sync-metadata-row .value { text-align: right; color: var(--text-normal); }
    .sync-metadata-row.highlight .value { color: var(--text-accent); }
    `,
    content: `
    <div class="sync-metadata">
      <div style="display:flex; align-items:center; gap:8px;">${ICON.metadata}<h2 style="margin:0;">Sync Metadata</h2></div>
      <p class="sync-metadata-path">Notes/Project/Roadmap.md</p>
      ${[
        ["Provider", "GitHub API"],
        ["In scope", "Yes"],
        ["Excluded", "No"],
        ["Remote path", "Roadmap.md"],
        ["Local hash", "b31cfe0e"],
        ["Remote revision", "7f9d1a8"],
        ["Encrypted", "Enabled for API sync"],
        ["Last sync", "Apr 8, 2026, 2:41 PM"],
        ["Last sync result", "Success"],
        ["Remote URL", "https://github.com/redoracle/obsidian-git-vault"],
      ]
        .map(([name, value], index) => `<div class="sync-metadata-row${index === 6 ? " highlight" : ""}"><span class="name">${escapeHtml(name)}</span><span class="value">${escapeHtml(value)}</span></div>`)
        .join("")}
    </div>`,
  });
}

// ══════════════════════════════════════════════════════════════
// Line Author scenarios
// ══════════════════════════════════════════════════════════════

/** Interpolate gutter background color. age ∈ [0,1]: 0 = newest (pink), 1 = oldest (blue). */
function laColor(age: number): string {
  const t = Math.min(Math.max(age, 0), 1);
  const r = Math.round(255 * (1 - t) + 120 * t);
  const g = Math.round(150 * (1 - t) + 160 * t);
  const b = Math.round(150 * (1 - t) + 255 * t);
  return `rgba(${r},${g},${b},0.45)`;
}

type LaGutter = { text: string; color: string; textCss?: string } | "untracked" | null;

/** Render one editor row: [gutter cell | line-number | content]. */
function laRow(lineNo: number, gutter: LaGutter, content: string, gutterWidth = 140): string {
  const cols = `${gutterWidth}px 28px 1fr`;
  let gutterDiv: string;
  if (gutter === null) {
    gutterDiv = `<div class="la-cell la-gutter" style="background:transparent;min-width:${gutterWidth}px;"></div>`;
  } else if (gutter === "untracked") {
    gutterDiv = `<div class="la-cell la-gutter la-untracked" style="min-width:${gutterWidth}px;">+++</div>`;
  } else {
    const colorStyle = gutter.textCss ? `color:${gutter.textCss};` : "";
    gutterDiv = `<div class="la-cell la-gutter" style="background:${gutter.color};${colorStyle}min-width:${gutterWidth}px;">${escapeHtml(gutter.text)}</div>`;
  }
  return `<div class="la-row" style="grid-template-columns:${cols};">${gutterDiv}<div class="la-cell la-num">${lineNo}</div><div class="la-cell la-text">${escapeHtml(content)}</div></div>`;
}

const LA_EDITOR_CSS = `
  .la-wrap { font-family: var(--font-monospace); background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); overflow: hidden; width: 100%; }
  .la-header { display: flex; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
  .la-tab { display: flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: 0.82em; background: var(--background-primary); border-right: 1px solid var(--background-modifier-border); }
  .la-tab-x { color: var(--text-faint); font-size: 10px; }
  .la-row { display: grid; align-items: stretch; }
  .la-cell { display: flex; align-items: center; padding: 1px 8px; font-size: 0.76em; line-height: 1.8; white-space: pre; }
  .la-gutter { color: var(--text-muted); }
  .la-untracked { background: rgba(220,148,78,0.22) !important; color: var(--text-faint); }
  .la-num { color: var(--text-faint); justify-content: flex-end; border-right: 1px solid var(--background-modifier-border); padding: 1px 6px; min-width: 20px; white-space: nowrap; }
  .la-text { font-size: 0.82em; padding: 1px 0 1px 10px; color: var(--text-normal); }
`;

function laEditorPage(
  title: string,
  rows: string[],
  options?: { width?: number; filename?: string; extraCss?: string }
): string {
  const w = options?.width ?? 400;
  const filename = options?.filename ?? "README.md";
  return page({
    title,
    targetStyle: `width:${w}px;`,
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: LA_EDITOR_CSS + (options?.extraCss ?? ""),
    content: `<div class="la-wrap">
      <div class="la-header"><div class="la-tab">${escapeHtml(filename)}<span class="la-tab-x"> ×</span></div></div>
      <div class="la-body">${rows.join("")}</div>
    </div>`,
  });
}

const LA_SETTINGS_CSS = `
  #screenshot-target { background: var(--background-primary); border-radius: var(--radius-l); box-shadow: 0 8px 48px rgba(0,0,0,0.7); overflow: hidden; }
  .la-sh { display: flex; align-items: center; gap: 10px; padding: 18px 24px 14px; border-bottom: 1px solid var(--background-modifier-border); background: var(--background-secondary); }
  .la-sh-title { font-size: 1.05em; font-weight: 700; }
  .la-sh-ver { font-size: 0.72em; color: var(--text-faint); background: var(--background-modifier-border); padding: 2px 8px; border-radius: 999px; margin-left: auto; }
  .la-cp-row { display: flex; align-items: center; gap: 8px; }
  .la-swatch { width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--background-modifier-border); flex-shrink: 0; }
  .vertical-tab-content { padding: 16px 24px; }
  .setting-item-control select, .setting-item-control input[type=text], .setting-item-control input[type=number] { min-width: 180px; background: var(--background-modifier-form-field); }
  .setting-item-control button { white-space: nowrap; }
`;

function laSettingsPage(title: string, items: string): string {
  return page({
    title: `Line Author – ${title}`,
    targetStyle: "width:750px;",
    bodyStyle: "margin:0;padding:32px;background:#111;display:flex;justify-content:center;align-items:flex-start;",
    extraCss: LA_SETTINGS_CSS,
    content: `<div class="la-sh"><span class="la-sh-title">Obsidian Git – Line Author</span><span class="la-sh-ver">v2.x</span></div>
    <div class="vertical-tab-content">${items}</div>`,
  });
}

// ── Settings panel scenarios ───────────────────────────────────

export function renderLineAuthorActivate(): string {
  return laSettingsPage("Activate", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Show commit authoring information",
      `Visualizes the authoring date and author alongside the currently edited file, using the <a href="https://git-scm.com/docs/git-blame" target="_blank">git blame</a> feature.`,
      checkbox(true)
    )}
  `);
}

export function renderLineAuthorFollowConfig(): string {
  return laSettingsPage("Follow movement", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Follow movement and copies",
      "Follows the movement of lines within a file or across different files. This requires more computation and will slow down the plugin.",
      select(
        ["Do not follow (fast)", "Follow within same commit", "Follow within all commits"],
        "Do not follow (fast)"
      )
    )}
  `);
}

export function renderLineAuthorHashNameConfig(): string {
  return laSettingsPage("Commit hash, name, and date", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Show commit hash",
      "Prepend the short commit hash to each line's authoring information.",
      checkbox(true)
    )}
    ${settingItem(
      "Author name display",
      "The format in which the author's name is displayed next to the authoring date.",
      select(
        ["Hide", "Initials (e.g. JD)", "First name", "Last name", "Full name"],
        "Initials (e.g. JD)"
      )
    )}
    ${settingItem(
      "Authoring date display",
      "The format in which the authoring date is displayed.",
      select(
        ["Hide", "Date (YYYY-MM-DD)", "Date and time", "Natural language", "Custom"],
        "Date (YYYY-MM-DD)"
      )
    )}
  `);
}

export function renderLineAuthorCustomDatesConfig(): string {
  return laSettingsPage("Custom date format", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Authoring date display",
      "The format in which the authoring date is displayed.",
      select(
        ["Hide", "Date (YYYY-MM-DD)", "Date and time", "Natural language", "Custom"],
        "Custom"
      )
    )}
    ${settingItem(
      "Custom authoring date format",
      `Moment.js format string for the authoring date. See the <a href="https://momentjs.com/docs/#/displaying/format/" target="_blank">Moment.js documentation</a> for possible format strings.`,
      textInput("DD.MM.YY", "text", 180)
    )}
  `);
}

export function renderLineAuthorTzConfig(): string {
  return laSettingsPage("Timezone", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Authoring date display timezone",
      "The timezone in which the authoring date is displayed. Author local shows the timezone offset of the commit author at the time of authoring.",
      select(
        ["My local (viewer local)", "Author local", "UTC+0000/Z"],
        "My local (viewer local)"
      )
    )}
  `);
}

export function renderLineAuthorColorConfig(): string {
  return laSettingsPage("Colors", `
    ${sectionHeading("Git blame coloring")}
    ${settingItem(
      "Oldest age in coloring",
      "Anything older than this age will receive the oldest color. The unit is: years (y), months (m), weeks (w), days (d), hours (h). Minimum is 1d.",
      textInput("1y", "text", 80)
    )}
    ${settingItem(
      "Color for newest commits",
      "The color of the newest commits in the gutter. Anything newer than the oldest age will receive an interpolated color between the newest and oldest colors.",
      `<div class="la-cp-row"><div class="la-swatch" style="background:rgb(255,150,150);"></div>${textInput("rgb(255,150,150)", "text", 160)}</div>`
    )}
    ${settingItem(
      "Color for oldest commits",
      "The color of the oldest commits (i.e. older than the oldest age) in the gutter.",
      `<div class="la-cp-row"><div class="la-swatch" style="background:rgb(120,160,255);"></div>${textInput("rgb(120,160,255)", "text", 160)}</div>`
    )}
  `);
}

export function renderLineAuthorTextColor(): string {
  return laSettingsPage("Text color", `
    ${sectionHeading("Git blame information")}
    ${settingItem(
      "Text color",
      "The CSS color of the gutter text. Supports all CSS color formats as well as CSS variables like <code>var(--text-muted)</code> and <code>var(--text-normal)</code>.",
      textInput("var(--text-muted)", "text", 200)
    )}
  `);
}

// ── Editor gutter scenarios ────────────────────────────────────

export function renderLineAuthorDefault(): string {
  const gw = 130;
  const rows = [
    laRow(1, { text: "G  2022-08-20", color: laColor(0) },    "lorem ipsum 1", gw),
    laRow(2, { text: "G  2022-08-20", color: laColor(0) },    "lorem ipsum 2", gw),
    laRow(3, { text: "G  2022-08-20", color: laColor(0) },    "lorem ipsum 3", gw),
    laRow(4, { text: "G* 2022-04-11", color: laColor(0.20) }, "lorem ipsum 4", gw),
    laRow(5, { text: "G* 2022-03-11", color: laColor(0.35) }, "lorem ipsum 5", gw),
    laRow(6, { text: "G* 2022-02-11", color: laColor(0.50) }, "lorem ipsum 6", gw),
    laRow(7, { text: "G* 2022-01-11", color: laColor(0.65) }, "lorem ipsum 7", gw),
    laRow(8, { text: "G* 2021-09-11", color: laColor(1.0) },  "lorem ipsum 8", gw),
  ];
  return laEditorPage("Default gutter – initials and date", rows);
}

export function renderLineAuthorHashFullName(): string {
  const gw = 195;
  const rows = [
    laRow(1, { text: "59d790 G  2022-08-20", color: laColor(0) },    "lorem ipsum 1", gw),
    laRow(2, { text: "59d790 G  2022-08-20", color: laColor(0) },    "lorem ipsum 2", gw),
    laRow(3, { text: "59d790 G  2022-08-20", color: laColor(0) },    "lorem ipsum 3", gw),
    laRow(4, { text: "8276bc G* 2022-04-11", color: laColor(0.20) }, "lorem ipsum 4", gw),
    laRow(5, { text: "d4e5f6 G* 2022-03-11", color: laColor(0.35) }, "lorem ipsum 5", gw),
    laRow(6, { text: "7f3c12 G* 2022-02-11", color: laColor(0.50) }, "lorem ipsum 6", gw),
    laRow(7, { text: "e9f012 G* 2022-01-11", color: laColor(0.65) }, "lorem ipsum 7", gw),
    laRow(8, { text: "a7b8c9 G* 2021-09-11", color: laColor(1.0) },  "lorem ipsum 8", gw),
  ];
  return laEditorPage("Gutter with commit hash and full name", rows, { width: 460 });
}

export function renderLineAuthorNaturalLanguageDates(): string {
  const gw = 158;
  const rows = [
    laRow(1, { text: "G  2 years ago",   color: laColor(0) },    "lorem ipsum 1", gw),
    laRow(2, { text: "G  2 years ago",   color: laColor(0) },    "lorem ipsum 2", gw),
    laRow(3, { text: "G  2 years ago",   color: laColor(0) },    "lorem ipsum 3", gw),
    laRow(4, { text: "G* a year ago",    color: laColor(0.20) }, "lorem ipsum 4", gw),
    laRow(5, { text: "G* 10 months ago", color: laColor(0.35) }, "lorem ipsum 5", gw),
    laRow(6, { text: "G* 9 months ago",  color: laColor(0.50) }, "lorem ipsum 6", gw),
    laRow(7, { text: "G* 8 months ago",  color: laColor(0.65) }, "lorem ipsum 7", gw),
    laRow(8, { text: "G* a year ago",    color: laColor(1.0) },  "lorem ipsum 8", gw),
  ];
  return laEditorPage("Natural language dates", rows, { width: 415 });
}

export function renderLineAuthorCustomDates(): string {
  const gw = 110;
  const rows = [
    laRow(1, { text: "G  20.08.22", color: laColor(0) },    "lorem ipsum 1", gw),
    laRow(2, { text: "G  20.08.22", color: laColor(0) },    "lorem ipsum 2", gw),
    laRow(3, { text: "G  20.08.22", color: laColor(0) },    "lorem ipsum 3", gw),
    laRow(4, { text: "G* 11.04.22", color: laColor(0.20) }, "lorem ipsum 4", gw),
    laRow(5, { text: "G* 11.03.22", color: laColor(0.35) }, "lorem ipsum 5", gw),
    laRow(6, { text: "G* 11.02.22", color: laColor(0.50) }, "lorem ipsum 6", gw),
    laRow(7, { text: "G* 11.01.22", color: laColor(0.65) }, "lorem ipsum 7", gw),
    laRow(8, { text: "G* 11.09.21", color: laColor(1.0) },  "lorem ipsum 8", gw),
  ];
  return laEditorPage("Custom date format (DD.MM.YY)", rows);
}

export function renderLineAuthorTzUtc(): string {
  const gw = 180;
  const cMid = laColor(0.4);
  const cOld = laColor(0.8);
  const rows = [
    laRow(1, { text: "2020-01-01 10:00Z", color: cMid }, "committed at 2020-01-01T10:00+00:00", gw),
    laRow(2, { text: "2020-01-01 10:00Z", color: cMid }, "committed at 2020-01-01T14:00+04:00", gw),
    laRow(3, { text: "2020-01-01 06:00Z", color: cOld }, "committed at 2020-01-01T10:00+04:00", gw),
  ];
  return laEditorPage("Timezone: UTC+0000/Z", rows, { width: 470, filename: "example.md" });
}

export function renderLineAuthorTzAuthorLocal(): string {
  const gw = 210;
  const cMid = laColor(0.4);
  const cOld = laColor(0.8);
  const rows = [
    laRow(1, { text: "2020-01-01 10:00 +00:00", color: cMid }, "committed at 2020-01-01T10:00+00:00", gw),
    laRow(2, { text: "2020-01-01 14:00 +04:00", color: cMid }, "committed at 2020-01-01T14:00+04:00", gw),
    laRow(3, { text: "2020-01-01 10:00 +04:00", color: cOld }, "committed at 2020-01-01T10:00+04:00", gw),
  ];
  return laEditorPage("Timezone: Author local", rows, { width: 495, filename: "example.md" });
}

export function renderLineAuthorTzViewerPlus0100(): string {
  const gw = 168;
  const cMid = laColor(0.4);
  const cOld = laColor(0.8);
  const rows = [
    laRow(1, { text: "2020-01-01 11:00", color: cMid }, "committed at 2020-01-01T10:00+00:00", gw),
    laRow(2, { text: "2020-01-01 11:00", color: cMid }, "committed at 2020-01-01T14:00+04:00", gw),
    laRow(3, { text: "2020-01-01 07:00", color: cOld }, "committed at 2020-01-01T10:00+04:00", gw),
  ];
  return laEditorPage("Timezone: Viewer local (+01:00)", rows, { width: 450, filename: "example.md" });
}

export function renderLineAuthorTextColorMuted(): string {
  const gw = 130;
  const muted = "var(--text-muted)";
  const rows = [
    laRow(1, { text: "G  2022-08-20", color: laColor(0),    textCss: muted }, "lorem ipsum 1", gw),
    laRow(2, { text: "G  2022-08-20", color: laColor(0),    textCss: muted }, "lorem ipsum 2", gw),
    laRow(3, { text: "G  2022-08-20", color: laColor(0),    textCss: muted }, "lorem ipsum 3", gw),
    laRow(4, { text: "G* 2022-04-11", color: laColor(0.20), textCss: muted }, "lorem ipsum 4", gw),
    laRow(5, { text: "G* 2022-03-11", color: laColor(0.35), textCss: muted }, "lorem ipsum 5", gw),
    laRow(6, { text: "G* 2022-02-11", color: laColor(0.50), textCss: muted }, "lorem ipsum 6", gw),
    laRow(7, { text: "G* 2022-01-11", color: laColor(0.65), textCss: muted }, "lorem ipsum 7", gw),
    laRow(8, { text: "G* 2021-09-11", color: laColor(1.0),  textCss: muted }, "lorem ipsum 8", gw),
  ];
  return laEditorPage("Text color: var(--text-muted)", rows);
}

export function renderLineAuthorTextColorNormal(): string {
  const gw = 130;
  const normal = "var(--text-normal)";
  const rows = [
    laRow(1, { text: "G  2022-08-20", color: laColor(0),    textCss: normal }, "lorem ipsum 1", gw),
    laRow(2, { text: "G  2022-08-20", color: laColor(0),    textCss: normal }, "lorem ipsum 2", gw),
    laRow(3, { text: "G  2022-08-20", color: laColor(0),    textCss: normal }, "lorem ipsum 3", gw),
    laRow(4, { text: "G* 2022-04-11", color: laColor(0.20), textCss: normal }, "lorem ipsum 4", gw),
    laRow(5, { text: "G* 2022-03-11", color: laColor(0.35), textCss: normal }, "lorem ipsum 5", gw),
    laRow(6, { text: "G* 2022-02-11", color: laColor(0.50), textCss: normal }, "lorem ipsum 6", gw),
    laRow(7, { text: "G* 2022-01-11", color: laColor(0.65), textCss: normal }, "lorem ipsum 7", gw),
    laRow(8, { text: "G* 2021-09-11", color: laColor(1.0),  textCss: normal }, "lorem ipsum 8", gw),
  ];
  return laEditorPage("Text color: var(--text-normal)", rows);
}

export function renderLineAuthorIgnoreWhitespaceBefore(): string {
  const gw = 130;
  const c = { text: "G  2022-10-21", color: laColor(0.1) };
  const rows = [
    laRow(1, c, "line 1", gw),
    laRow(2, c, "line 2", gw),
    laRow(3, c, "line 3", gw),
    laRow(4, c, "line 4", gw),
    laRow(5, c, "line 5", gw),
    laRow(6, c, "line 6", gw),
  ];
  return laEditorPage("Whitespace: before changes", rows, { filename: "example.md" });
}

export function renderLineAuthorIgnoreWhitespacePreserved(): string {
  const gw = 130;
  const c = { text: "G  2022-10-21", color: laColor(0.1) };
  const rows = [
    laRow(1, c, "line 1", gw),
    laRow(2, c, "line 2", gw),
    laRow(3, "untracked", "    line 3", gw),
    laRow(4, "untracked", "    line 4", gw),
    laRow(5, c, "line 5", gw),
    laRow(6, c, "line 6", gw),
    laRow(7, "untracked", "a new line", gw),
  ];
  return laEditorPage("Whitespace: preserved (default) – indentation counts as change", rows, { filename: "example.md" });
}

export function renderLineAuthorIgnoreWhitespaceIgnored(): string {
  const gw = 130;
  const c = { text: "G  2022-10-21", color: laColor(0.1) };
  const rows = [
    laRow(1, c, "line 1", gw),
    laRow(2, c, "line 2", gw),
    laRow(3, c, "    line 3", gw),
    laRow(4, c, "    line 4", gw),
    laRow(5, c, "line 5", gw),
    laRow(6, c, "line 6", gw),
    laRow(7, "untracked", "a new line", gw),
  ];
  return laEditorPage("Whitespace: ignored – indentation not counted as change", rows, { filename: "example.md" });
}

export function renderLineAuthorUntracked(): string {
  const gw = 130;
  const cOld = { text: "G* 2022-01-11", color: laColor(0.65) };
  const cMid = { text: "G* 2022-02-11", color: laColor(0.50) };
  const rows = [
    laRow(1,  cOld, "lorem ipsum 1", gw),
    laRow(2,  cOld, "lorem ipsum 2", gw),
    laRow(3,  cOld, "lorem ipsum 3", gw),
    laRow(4,  cOld, "lorem ipsum 4", gw),
    laRow(5,  cOld, "lorem ipsum 5", gw),
    laRow(6,  cOld, "lorem ipsum 6", gw),
    laRow(7,  cOld, "lorem ipsum 7", gw),
    laRow(8,  cOld, "lorem ipsum 8", gw),
    laRow(9,  "untracked", "an uncommitted new line", gw),
    laRow(10, cMid, "lorem ipsum 10", gw),
    laRow(11, cMid, "lorem ipsum 11", gw),
  ];
  return laEditorPage("Untracked (uncommitted) line shows +++", rows, { width: 430 });
}

export function renderLineAuthorFollowNoFollow(): string {
  const gw = 78;
  const cCtx  = { text: "8276bc", color: laColor(0.75) };
  const cPast = { text: "6a9170", color: laColor(0.1) };
  const rows = [
    laRow(1,  cCtx,  "context line 1", gw),
    laRow(2,  cCtx,  "context line 2", gw),
    laRow(3,  cCtx,  "context line 3", gw),
    laRow(4,  cCtx,  "v content pasted from another file", gw),
    laRow(5,  cCtx,  "v (do not follow): shows paste commit", gw),
    laRow(6,  cCtx,  "context line 6", gw),
    laRow(7,  cPast, "55555555555555555", gw),
    laRow(8,  cPast, "55555555555555555", gw),
    laRow(9,  cPast, "55555555555555555", gw),
    laRow(10, cPast, "55555555555555555", gw),
    laRow(11, cPast, "55555555555555555", gw),
  ];
  return laEditorPage("Follow movement: do not follow", rows, { width: 370 });
}

export function renderLineAuthorFollowAllCommits(): string {
  const gw = 78;
  const cCtx  = { text: "8276bc", color: laColor(0.75) };
  const cOrig = { text: "cdf96d", color: laColor(1.0) };
  const rows = [
    laRow(1,  cCtx,  "context line 1", gw),
    laRow(2,  cCtx,  "context line 2", gw),
    laRow(3,  cCtx,  "context line 3", gw),
    laRow(4,  cCtx,  "v same block (all-commits follow)", gw),
    laRow(5,  cCtx,  "v tracks back to original authoring", gw),
    laRow(6,  cCtx,  "context line 6", gw),
    laRow(7,  cOrig, "55555555555555555", gw),
    laRow(8,  cOrig, "55555555555555555", gw),
    laRow(9,  cOrig, "55555555555555555", gw),
    laRow(10, cOrig, "55555555555555555", gw),
    laRow(11, cOrig, "55555555555555555", gw),
  ];
  return laEditorPage("Follow movement: all commits", rows, { width: 370 });
}

// ── Context menu scenario ──────────────────────────────────────

export function renderLineAuthorCopyHash(): string {
  const gw = 130;
  const cNew = { text: "G  2022-08-20", color: laColor(0) };
  const cMid = { text: "G* 2022-04-11", color: laColor(0.25) };
  const editorRows = [
    laRow(1, cNew, "lorem ipsum 1", gw),
    laRow(2, cNew, "lorem ipsum 2", gw),
    laRow(3, cNew, "lorem ipsum 3", gw),
    laRow(4, cMid, "lorem ipsum 4", gw),
    laRow(5, cMid, "lorem ipsum 5", gw),
  ].join("");

  return page({
    title: "Context menu – Copy commit hash",
    targetStyle: "width:420px;",
    bodyStyle: "padding:24px;display:flex;justify-content:center;",
    extraCss: LA_EDITOR_CSS + `
      .la-ctx-wrap { position: relative; width: 100%; }
      .la-ctx-menu { position: absolute; top: 52px; left: 90px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); box-shadow: 0 6px 24px rgba(0,0,0,0.45); min-width: 192px; overflow: hidden; z-index: 10; }
      .la-ctx-item { padding: 7px 14px; font-size: 0.84em; color: var(--text-normal); cursor: default; }
      .la-ctx-item.is-active { background: var(--interactive-accent); color: var(--text-on-accent); }
      .la-ctx-sep { height: 1px; background: var(--background-modifier-border); margin: 3px 0; }
    `,
    content: `<div class="la-ctx-wrap">
      <div class="la-wrap">
        <div class="la-header"><div class="la-tab">README.md<span class="la-tab-x"> ×</span></div></div>
        <div class="la-body">${editorRows}</div>
      </div>
      <div class="la-ctx-menu">
        <div class="la-ctx-item is-active">Copy commit hash</div>
        <div class="la-ctx-sep"></div>
        <div class="la-ctx-item">Open in GitHub</div>
        <div class="la-ctx-item">Show commit in history</div>
      </div>
    </div>`,
  });
}
