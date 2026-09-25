// backend 命名空间的简体中文翻译。与 en/backend.ts 一一对应；
// parity.test.ts 保证两侧键与插值占位符完全一致。
export default {
  clipboard: {
    copied: "已复制{{label}}",
    failed: "无法复制到剪贴板",
  },

  archiveTask: {
    cleanupFailedNamed: "已归档「{{name}}」，但清理失败：{{error}}",
    cleanupFailed: "已归档，但清理失败：{{error}}",
    confirmTitle: "归档「{{name}}」？",
    mainMessage:
      "这将移除 Termic 中项目主检出的条目。磁盘上的仓库不会被改动，之后随时可以从项目的 + 菜单重新打开。在此运行的智能体将被终止。",
    mainConfirm: "移除条目",
    compositionMessage:
      "很容易恢复：任务会保留在历史记录中，分支也会保留在 git 里，之后可以重新创建。此操作会删除磁盘上的工作树（宿主目录 + {{members}}）以及指向实时检出的成员符号链接（那些实时仓库不会被改动）。任何正在运行的智能体都将被终止。",
    compositionConfirm: "归档",
    worktreeMessage:
      "很容易恢复：任务会保留在历史记录中，分支也会保留在 git 里，之后可以在它上面新建工作树。此操作只删除磁盘上的工作树目录（构建产物：node_modules、.venv、未跟踪文件），并终止任何正在运行的智能体。",
    worktreeConfirm: "归档",
    deleteBranches: "删除 git 分支",
    deleteBranch: "删除 git 分支：",
    archivedToast: "已归档「{{name}}」。可在历史记录中找到。",
    history: "历史记录",
    compositionNone: "无",
  },

  attentionNotify: {
    taskFallback: "任务",
    agentBody: "智能体{{phrase}}",
    phraseBell: "需要输入",
    phraseExit: "已退出",
    phraseDone: "已完成",
    phraseAttention: "等待你的输入",
    phraseIdle: "处于空闲",
  },

  pr: {
    open: "打开",
    commentsToastOne: "{{noun}} {{ref}} 上有 {{count}} 条新评论。已排入队列，等待智能体处理。",
    commentsToastOther: "{{noun}} {{ref}} 上有 {{count}} 条新评论。已排入队列，等待智能体处理。",
    commentsNotifyOne: "{{noun}} {{ref}} 上有 {{count}} 条新评论，已排入队列等待智能体",
    commentsNotifyOther: "{{noun}} {{ref}} 上有 {{count}} 条新评论，已排入队列等待智能体",
    commentsNoAgentOne: "{{provider}} {{ref}} 上有 {{count}} 条新评论。没有正在运行的智能体可以接手。",
    commentsNoAgentOther: "{{provider}} {{ref}} 上有 {{count}} 条新评论。没有正在运行的智能体可以接手。",
    mergedAutoToast: "{{label}} 已合并。正在归档「{{name}}」",
    mergedAutoNotify: "{{label}} 已合并，正在归档",
    mergedAskToast: "{{label}} 已合并。归档「{{name}}」？",
    mergedAskNotify: "{{label}} 已合并。归档「{{name}}」？",
    archiveAction: "归档",
  },

  closeTab: {
    unsavedTitle: "不保存直接关闭？",
    unsavedMessage: "「{{name}}」有未保存的更改。关闭标签页将丢弃这些更改。按 ⌘S 可先保存。",
    unsavedConfirm: "丢弃并关闭",
    scheduledTitle: "删除定时消息？",
    scheduledPhraseOne: "{{count}} 条定时消息",
    scheduledPhraseOther: "{{count}} 条定时消息",
    scheduledMessageOne: "此标签页有{{phrase}}。关闭标签页会将其删除。",
    scheduledMessageOther: "此标签页有{{phrase}}。关闭标签页会将它们删除。",
    closeTabConfirm: "关闭标签页",
    closeTabsConfirm: "关闭标签页",
    thisCommand: "此命令",
    agentCloseTitle: "关闭 {{label}}？",
    stopsProcess: "停止正在运行的进程并关闭标签页。",
    stopsProcessResumes: "停止正在运行的进程。重新打开该任务时会话会自动恢复。",
    endsSessionPane: "结束此智能体的会话。面板标签页不会被保留，因此无法恢复。",
    endsSessionResume: "结束此智能体的会话。之后随时可以从 + 菜单的恢复列表中找回。",
    bulkTitleOne: "关闭 {{count}} 个标签页？",
    bulkTitleOther: "关闭 {{count}} 个标签页？",
    bulkDirtyOne: "termic 将丢弃 {{count}} 个文件中未保存的更改。",
    bulkDirtyOther: "termic 将丢弃 {{count}} 个文件中未保存的更改。",
    bulkLiveOne: "termic 将结束 {{count}} 个智能体会话。",
    bulkLiveOther: "termic 将结束 {{count}} 个智能体会话。",
    bulkScheduled: "同时会删除{{phrase}}。",
    closedToast: "已关闭「{{label}}」。",
    closedSleptToast: "已关闭「{{label}}」。重新打开此任务时会自动恢复。",
    closedResumeToast: "已关闭「{{label}}」。可从 + 菜单中恢复。",
    resume: "恢复",
  },

  sendComments: {
    noAgent: "此任务中没有正在运行的智能体可以发送。",
    unreachable: "无法连接到 {{name}}，未发送任何内容。",
    sent: "已将{{what}}发送给 {{name}}",
    commentsOne: "{{count}} 条评论",
    commentsOther: "{{count}} 条评论",
  },

  agentRace: {
    startedOne: "竞赛已开始：{{count}} 个智能体运行同一个提示词。",
    startedOther: "竞赛已开始：{{count}} 个智能体运行同一个提示词。",
    untitledPrompt: "未命名提示词",
  },

  scratchTabs: {
    createFailed: "无法创建暂存本：{{error}}",
    deleteFailed: "无法删除暂存本：{{error}}",
  },

  runPrompt: {
    notRunning: "该智能体已不再运行。",
    sentTo: "已将「{{title}}」发送给 {{label}}。",
    startFailed: "无法启动智能体来运行「{{title}}」。",
  },

  runTabs: {
    run: "运行",
    setup: "安装环境",
    runMember: "运行 · {{member}}",
  },

  accountSwitching: {
    signInTab: "登录：{{account}}",
    restartTitle: "在 {{name}} 上重启 {{agent}}？",
    restartMessage:
      "正在运行的智能体在重启前会保持当前登录。重启会在 {{name}} 上恢复此对话；选择「稍后」则会将其暂存到下次启动时生效。",
    restartNow: "立即重启",
    later: "稍后",
  },

  copySuffix: "（副本）",

  lsp: {
    downloadTitle: "下载 {{label}}？",
    downloadConfirm: "下载",
    installFailed: "无法安装 {{label}}：{{error}}",
    installMessage:
      "本机上没有能服务 {{language}} 的语言服务器，termic 可以获取自己的一份副本{{size}}，并使用本版本内置的校验和验证，安装到 termic 自己的目录中。它绝不会加入你的 PATH，删除 termic 时也会一并删除。",
    installSize: "（约 {{mb}} MB）",
    memoryTsgo: "TypeScript 的开销在加载时产生：这个规模的仓库约 300 MB，之后的查询不再增加。",
    memoryTypescript: "TypeScript 的开销在加载时产生：这个规模的仓库约 300 MB，之后的查询不再增加。",
    memoryZuban: "zuban 在这个规模的项目上占用约 85 MB，并在运行期间一直保持。",
    memoryTy: "ty 空闲时占用约 50 MB，在完成一次 find-usages 后约 250 MB，且不会释放。",
    memoryBasedpyright: "basedpyright 在读取项目后会占用数百 MB，并在运行期间保持。",
    memoryRustAnalyzer: "rust-analyzer 会索引整个 crate 图：在这个规模的仓库上约 3 GB，并在运行期间一直保持。",
    memoryShortTsgo: "约 300 MB",
    memoryShortTypescript: "约 300 MB",
    memoryShortZuban: "约 85 MB",
    memoryShortTy: "空闲 50 MB，find-usages 后约 250 MB",
    memoryShortBasedpyright: "数百 MB",
    memoryGopls: "gopls 在打开文件后占用约 1 GB，大型仓库上可达 7 GB，且不会释放。",
    memoryClangd: "clangd 在这个规模的项目上占用数百 MB，并把索引写到检出内的 .cache/clangd（值得在 .gitignore 里加一行）。",
    memorySourcekit: "sourcekit-lsp 占用数百 MB，对至少构建过一次的包回答得最好。",
    memoryRubyLsp: "ruby-lsp 占用约 200 MB，并在检出内写入自己的 bundle 所需的 .ruby-lsp 目录。",
    memoryTerraformLs: "terraform-ls 在一个小型 Terraform 示例上占用约 30 MB。内存取决于项目及其 provider schema。",
    memoryShortRustAnalyzer: "这个规模的仓库约 3 GB",
    memoryShortGopls: "约 1 GB，大型仓库更多",
    memoryShortClangd: "数百 MB，另有 .cache/clangd 索引",
    memoryShortSourcekit: "数百 MB",
    memoryShortRubyLsp: "约 200 MB",
    memoryShortTerraformLs: "小型项目约 30 MB",
  },

  dockerRebuild: {
    backgroundStarted: "正在后台重建 Docker 沙箱镜像，下一个智能体将使用新镜像。",
    failedSettings: "Docker 沙箱镜像重建失败。请检查设置中的 Docker 沙箱。",
    beforeLaunch: "正在启动前重建 Docker 沙箱镜像…",
    rebuilt: "Docker 沙箱镜像已重建。",
    lastBuiltNever: "它还从未完成过一次构建。",
    lastBuiltToday: "它今天刚构建过。",
    lastBuiltYesterday: "它上次构建是昨天。",
    lastBuiltDaysAgo: "它上次构建是 {{days}} 天前。",
    failedExisting: "Docker 沙箱镜像重建失败，将使用现有镜像启动。请检查设置中的 Docker 沙箱。",
  },

  sandboxPreset: {
    standardLabel: "标准",
    standardHint: "仅保留内置默认项。可用它清除你添加的额外条目。",
    permissiveLabel: "宽松",
    permissiveHint: "大多数开发工作流会用到的额外主机：容器镜像仓库、GCS、helm/k8s、系统包镜像源。",
  },

  editorError: {
    binary: "这看起来是二进制文件，编辑器无法显示。",
    tooLarge: "此文件过大，编辑器无法显示{{size}}。",
    tooLargeSized: "（{{mb}}）",
  },

  portRange: {
    wholeNumbers: "两个端口都必须是整数。",
    floor: "最低端口不能低于 {{floor}}，更小的端口已预留给系统服务。",
    max65535: "最高端口不能超过 65535。",
    maxAboveMin: "最高端口必须大于最低端口。",
  },

  agentUsage: {
    statusProject: "此项目自带状态栏，它的优先级高于 Termic。",
    statusProjectLocal: "此项目有本地状态栏，它的优先级高于 Termic。",
    statusUser: "你已有自己的状态栏，Termic 不会改动它。",
    yoloCodex: "当托管策略（组织统一管理的 requirements.toml、MDM，或工作 ChatGPT 账号）不允许 danger-full-access 时，Codex 会拒绝启动而不是降级。如果你看到 \"requirements do not allow sandbox_mode\"，请在这里改用 -a never -s workspace-write：依然不会有审批提示，用的是 Codex 自己的沙箱而非无沙箱。",
  },

  navHint: {
    on: "{{language}} {{feature}} 已开启。指南针按钮会显示服务器何时就绪。",
  },

  dirError: {
    escapesTask: "此文件夹链接到了任务之外",
    pathNotAllowed: "路径不被允许",
    gone: "此文件夹已不存在",
    permissionDenied: "没有权限",
    notADirectory: "这已经不是一个文件夹了",
    symlinkLoop: "符号链接循环",
    tooManyOpenFiles: "打开的文件过多",
    taskGone: "此任务已从磁盘消失",
    unknown: "未知错误",
  },

  previewBrowser: {
    systemDefault: "系统默认",
    chromeProfile: "Chrome，指定配置文件",
    edgeProfile: "Edge，指定配置文件",
    chromeIncognito: "Chrome，无痕窗口",
    edgeInPrivate: "Edge，InPrivate 窗口",
    firefoxPrivate: "Firefox，隐私窗口",
    firefoxNamed: "Firefox，指定配置文件",
    chromeProfileHint: "在 chrome://version 的 Profile Path 下可以找到配置文件名。全新安装会有一个名为 Default 的配置文件。",
    chromeProfileHintShort: "在 chrome://version 的 Profile Path 下可以找到配置文件名。",
    edgeProfileHint: "在 edge://version 的 Profile Path 下可以找到配置文件名。",
    fallbackFailed: "无法打开你配置的浏览器（{{reason}}）。已改用系统默认浏览器。",
    openFailed: "无法打开 {{url}}：{{error}}",
    unknownError: "未知错误",
  },

  terminalDrop: {
    stageFailed: "无法暂存 {{path}}：{{error}}",
    allowFailed: "无法放行 {{path}}：{{error}}",
    allowedToast: "路径已放行。重启智能体后沙箱才会生效。",
  },

  prompts: {
    review: "代码审查",
    writeTests: "编写测试",
    securityReview: "安全审查",
    explainChanges: "解释更改",
    commit: "提交",
    commitPush: "提交并推送",
    fixMergeConflict: "修复合并冲突",
    verify: "端到端验证",
    fixBug: "修复缺陷",
    workIssue: "处理 issue",
    simplify: "简化代码",
    status: "当前状态如何？",
    continue: "从上次继续",
    handoff: "移交给另一个智能体",
    updateDocs: "更新文档",
    research: "先做调研",
  },
};
