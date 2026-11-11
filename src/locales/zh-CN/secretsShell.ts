// 密钥，终端侧：以角色启动的终端（docs/sandbox.md "Shells"）。
export default {
  restartWith: "使用密钥重启",
  noSecrets: "无密钥",
  confirmTitle: "以 {{role}} 身份重启此终端？",
  confirmTitleNone: "不使用密钥重启此终端？",
  confirmBody: "角色在终端启动时设定，因此切换会结束此终端并打开一个新的。仍在运行：{{procs}}。",
  confirm: "重启终端",
  badgeTip: "此终端以 {{role}} 身份运行",
  badgeForeignTip: "此终端以 {{role}} 身份运行，但 gh 发送了自己的令牌",
  badgeSuspiciousTip: "此终端以 {{role}} 身份运行。发生了可疑情况",
  rcBanner: "gh 发送了自己的令牌，而不是此终端的占位符，因此此终端正在使用一个 Termic 不管理的令牌。你的 shell 启动脚本（通常是 ~/.zshrc）在 Termic 之后设置了 GH_TOKEN。",
  rcCopy: "复制修复方法",
  rcFixLabel: "rc 文件修复方法",
  rcDismiss: "关闭",
  pausedBanner: "已暂停。在你恢复之前，此终端的每个代理请求都会被拒绝。",
  pauseTip: "在你恢复之前，拒绝此终端的每个代理请求。立即生效，无需重启。",
  tmuxPeer: "tmux 在自己的会话中运行其服务器，因此 Termic 无法判断请求来自此终端，已拒绝。请在 tmux 之外运行 gh，或为每个窗口打开一个 Termic 标签页。",
};
