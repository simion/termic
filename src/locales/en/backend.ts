// User-visible strings that live OUTSIDE components: stores, hooks and lib
// modules (toasts, confirm dialogs, OS notifications, tab titles minted at
// creation, and lib data tables the UI renders). Resolved through i18n.t with
// the "backend:" prefix; transient strings (toasts/banners) do not need to
// re-render on a live language switch.
export default {
  clipboard: {
    copied: "Copied {{label}}",
    failed: "Couldn't copy to clipboard",
  },

  archiveTask: {
    cleanupFailedNamed: "Archived \"{{name}}\", but cleanup failed: {{error}}",
    cleanupFailed: "Archived, but cleanup failed: {{error}}",
    confirmTitle: "Archive \"{{name}}\"?",
    mainMessage:
      "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched, so you can re-open it from the project's + menu any time. Any agent running here will be terminated.",
    mainConfirm: "Remove entry",
    compositionMessage:
      "Easy to get back: the task stays in History and the branches stay in git, so you can recreate it later. This removes the on-disk worktrees (the host + {{members}}) and any member symlinks to live checkouts (those live repos are NOT touched). Any running agent will be terminated.",
    compositionConfirm: "Archive",
    worktreeMessage:
      "Easy to get back: the task stays in History and the branch stays in git, so you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory (build artifacts: node_modules, .venv, untracked files) and terminates any running agent.",
    worktreeConfirm: "Archive",
    deleteBranches: "Delete the git branches",
    deleteBranch: "Delete the git branch:",
    archivedToast: "Archived \"{{name}}\". It's in History.",
    history: "History",
    compositionNone: "none",
  },

  attentionNotify: {
    taskFallback: "task",
    agentBody: "agent {{phrase}}",
    phraseBell: "wants input",
    phraseExit: "exited",
    phraseDone: "finished",
    phraseAttention: "needs your input",
    phraseIdle: "is idle",
  },

  pr: {
    open: "Open",
    commentsToastOne: "{{count}} new comment on {{noun}} {{ref}}. Queued for the agent to address.",
    commentsToastOther: "{{count}} new comments on {{noun}} {{ref}}. Queued for the agent to address.",
    commentsNotifyOne: "{{count}} new comment on {{noun}} {{ref}}, queued for the agent",
    commentsNotifyOther: "{{count}} new comments on {{noun}} {{ref}}, queued for the agent",
    commentsNoAgentOne: "{{count}} new comment on {{provider}} {{ref}}. No running agent to hand them to.",
    commentsNoAgentOther: "{{count}} new comments on {{provider}} {{ref}}. No running agent to hand them to.",
    mergedAutoToast: "{{label}} merged. Archiving \"{{name}}\"",
    mergedAutoNotify: "{{label}} merged, archiving",
    mergedAskToast: "{{label}} merged. Archive \"{{name}}\"?",
    mergedAskNotify: "{{label}} merged. Archive \"{{name}}\"?",
    archiveAction: "Archive",
  },

  closeTab: {
    unsavedTitle: "Close without saving?",
    unsavedMessage: "\"{{name}}\" has unsaved changes. Closing the tab will discard them. ⌘S to save first.",
    unsavedConfirm: "Discard & close",
    scheduledTitle: "Delete scheduled messages?",
    scheduledPhraseOne: "{{count}} scheduled message",
    scheduledPhraseOther: "{{count}} scheduled messages",
    scheduledMessageOne: "This tab has {{phrase}}. Closing the tab deletes it.",
    scheduledMessageOther: "This tab has {{phrase}}. Closing the tab deletes them.",
    closeTabConfirm: "Close tab",
    closeTabsConfirm: "Close tabs",
    thisCommand: "this command",
    agentCloseTitle: "Close {{label}}?",
    stopsProcess: "Stops the running process and closes the tab.",
    stopsProcessResumes: "Stops the running process. The session resumes when you reopen the task.",
    endsSessionPane: "Ends this agent's session. A pane tab isn't kept, so this one can't be resumed.",
    endsSessionResume: "Ends this agent's session. Bring it back any time from the Resume list in the + menu.",
    bulkTitleOne: "Close {{count}} tab?",
    bulkTitleOther: "Close {{count}} tabs?",
    bulkDirtyOne: "termic discards the unsaved changes in {{count}} file.",
    bulkDirtyOther: "termic discards the unsaved changes in {{count}} files.",
    bulkLiveOne: "termic ends {{count}} agent session.",
    bulkLiveOther: "termic ends {{count}} agent sessions.",
    bulkScheduled: "It deletes {{phrase}}.",
    closedToast: "Closed \"{{label}}\".",
    closedSleptToast: "Closed \"{{label}}\". It resumes automatically when you reopen this task.",
    closedResumeToast: "Closed \"{{label}}\". Resume it from the + menu.",
    resume: "Resume",
  },

  sendComments: {
    noAgent: "No running agent in this task to send to.",
    unreachable: "Could not reach {{name}}. Nothing was sent.",
    sent: "Sent {{what}} to {{name}}",
    commentsOne: "{{count}} comment",
    commentsOther: "{{count}} comments",
  },

  agentRace: {
    startedOne: "Race started: {{count}} agent on one prompt.",
    startedOther: "Race started: {{count}} agents on one prompt.",
    untitledPrompt: "Untitled prompt",
  },

  scratchTabs: {
    createFailed: "Couldn't create the scratchpad: {{error}}",
    deleteFailed: "Couldn't delete the scratchpad: {{error}}",
  },

  runPrompt: {
    notRunning: "That agent is no longer running.",
    sentTo: "Sent \"{{title}}\" to {{label}}.",
    startFailed: "Couldn't start the agent to run \"{{title}}\".",
  },

  runTabs: {
    run: "Run",
    setup: "Setup",
    runMember: "Run · {{member}}",
  },

  accountSwitching: {
    signInTab: "Sign in: {{account}}",
    restartTitle: "Restart {{agent}} on {{name}}?",
    restartMessage:
      "The running agent keeps its current login until it restarts. Restarting resumes this conversation on {{name}}; picking Later leaves it staged for the next start.",
    restartNow: "Restart now",
    later: "Later",
  },

  copySuffix: " (copy)",

  lsp: {
    downloadTitle: "Download {{label}}?",
    downloadConfirm: "Download",
    installFailed: "Could not install {{label}}: {{error}}",
    installMessage:
      "Nothing on this machine serves {{language}}, so termic can fetch its own copy{{size}}, verified against a checksum shipped in this release, into termic's own folder. It is never added to your PATH and deleting termic deletes it.",
    installSize: ": {{mb}} MB",
    memoryTsgo: "TypeScript pays at load: about 300 MB for a repo this size, and queries after that are free.",
    memoryTypescript: "TypeScript pays at load: about 300 MB for a repo this size, and queries after that are free.",
    memoryZuban: "zuban holds about 85 MB on a project this size, and keeps it for as long as it runs.",
    memoryTy: "ty holds about 50 MB idle, and around 250 MB once it has answered a find-usages. It never gives that back.",
    memoryBasedpyright: "basedpyright holds a few hundred MB once it has read the project, and keeps it while it runs.",
    memoryRustAnalyzer: "rust-analyzer indexes the whole crate graph: about 3 GB on a repo the size of this one, held for as long as it runs.",
    memoryShortTsgo: "about 300 MB",
    memoryShortTypescript: "about 300 MB",
    memoryShortZuban: "about 85 MB",
    memoryShortTy: "50 MB idle, about 250 MB after a find-usages",
    memoryShortBasedpyright: "a few hundred MB",
    memoryGopls: "gopls holds about 1 GB after opening a file, and up to 7 GB on a large repo. It never gives that back.",
    memoryClangd: "clangd holds a few hundred MB for a project this size, and writes its index to .cache/clangd inside the checkout (worth a line in .gitignore).",
    memorySourcekit: "sourcekit-lsp holds a few hundred MB, and answers best about a package that has been built at least once.",
    memoryRubyLsp: "ruby-lsp holds around 200 MB, and writes a .ruby-lsp directory inside the checkout for its own bundle.",
    memoryTerraformLs: "terraform-ls used about 30 MB on a small Terraform fixture. Memory depends on the project and its provider schemas.",
    memoryShortRustAnalyzer: "about 3 GB on a repo this size",
    memoryShortGopls: "about 1 GB, more on a large repo",
    memoryShortClangd: "a few hundred MB, plus an index in .cache/clangd",
    memoryShortSourcekit: "a few hundred MB",
    memoryShortRubyLsp: "about 200 MB",
    memoryShortTerraformLs: "about 30 MB on a small project",
  },

  dockerRebuild: {
    backgroundStarted: "Rebuilding the Docker sandbox image in the background. The next agent will use it.",
    failedSettings: "Docker sandbox image rebuild failed. Check Settings → Docker Sandbox.",
    beforeLaunch: "Rebuilding the Docker sandbox image before launch...",
    rebuilt: "Docker sandbox image rebuilt.",
    lastBuiltNever: "It has never finished a build.",
    lastBuiltToday: "It was last built earlier today.",
    lastBuiltYesterday: "It was last built yesterday.",
    lastBuiltDaysAgo: "It was last built {{days}} days ago.",
    failedExisting: "Docker sandbox image rebuild failed - launching with the existing image. Check Settings → Docker Sandbox.",
  },

  sandboxPreset: {
    standardLabel: "Standard",
    standardHint: "Just the built-in defaults. Use this to reset the extras you've added.",
    permissiveLabel: "Permissive",
    permissiveHint: "Extra hosts most dev workflows hit: container registries, GCS, helm/k8s, OS package mirrors.",
  },

  editorError: {
    binary: "This looks like a binary file, so the editor can't show it.",
    tooLarge: "This file is too large for the editor to show{{size}}.",
    tooLargeSized: " ({{mb}})",
  },

  portRange: {
    wholeNumbers: "Both ports must be whole numbers.",
    floor: "The lowest port must be {{floor}} or above. Below that is reserved for system services.",
    max65535: "The highest port must be 65535 or below.",
    maxAboveMin: "The highest port must be above the lowest.",
  },

  agentUsage: {
    statusProject: "This project ships its own status line, which takes priority over Termic's.",
    statusProjectLocal: "This project has a local status line, which takes priority over Termic's.",
    statusUser: "You have your own status line, so Termic left it alone.",
    yoloCodex: "Codex refuses to START, rather than downgrade, when a managed policy (an org-managed requirements.toml, MDM, or a work ChatGPT account) disallows danger-full-access. If you see \"requirements do not allow sandbox_mode\", use -a never -s workspace-write here instead: still no approval prompts, Codex's own sandbox instead of none.",
  },

  navHint: {
    on: "{{language}} {{feature}} is on. The compass button shows when the server is ready.",
  },

  dirError: {
    escapesTask: "This folder links outside the task",
    pathNotAllowed: "Path not allowed",
    gone: "This folder no longer exists",
    permissionDenied: "Permission denied",
    notADirectory: "This is not a folder any more",
    symlinkLoop: "Symlink loop",
    tooManyOpenFiles: "Too many open files",
    taskGone: "This task is gone from disk",
    unknown: "Unknown error",
  },

  previewBrowser: {
    systemDefault: "System default",
    chromeProfile: "Chrome, specific profile",
    edgeProfile: "Edge, specific profile",
    chromeIncognito: "Chrome, incognito",
    edgeInPrivate: "Edge, InPrivate",
    firefoxPrivate: "Firefox, private window",
    firefoxNamed: "Firefox, named profile",
    chromeProfileHint: "Find the profile name at chrome://version, under Profile Path. A fresh install has one, called Default.",
    chromeProfileHintShort: "Find the profile name at chrome://version, under Profile Path.",
    edgeProfileHint: "Find the profile name at edge://version, under Profile Path.",
    fallbackFailed: "Could not open your configured browser ({{reason}}). Used the system default instead.",
    openFailed: "Could not open {{url}}: {{error}}",
    unknownError: "unknown error",
  },

  terminalDrop: {
    stageFailed: "Couldn't stage {{path}}: {{error}}",
    allowFailed: "Couldn't allow {{path}}: {{error}}",
    allowedToast: "Path allowed. Restart the agent for the sandbox to pick it up.",
  },

  prompts: {
    review: "Review",
    writeTests: "Write tests",
    securityReview: "Security review",
    explainChanges: "Explain the changes",
    commit: "Commit",
    commitPush: "Commit and push",
    fixMergeConflict: "Fix merge conflicts",
    verify: "Verify end to end",
    fixBug: "Fix the bug",
    workIssue: "Work on the issue",
    simplify: "Simplify",
    status: "What is the state?",
    continue: "Continue from last",
    handoff: "Hand off to another agent",
    updateDocs: "Update the docs",
    research: "Research first",
  },
};
