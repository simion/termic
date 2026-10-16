/** OpenCode binds Ctrl+J (LF) to input.newline. Other agents keep the
 *  existing backslash-return continuation convention. */
export function terminalNewlineBytes(baseAgentId: string): number[] {
  return baseAgentId === "opencode" ? [0x0a] : [0x5c, 0x0d];
}
