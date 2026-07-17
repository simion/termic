// Matching a file-path fragment from terminal output against the workspace
// file list, on segment boundaries (not raw string suffix).

export function normalizePath(p: string): string {
  // Strip every leading "./" and "/" (but not "../", which is meaningful).
  return p.replace(/^(?:\.?\/)+/, "");
}

export function matchesSuffix(candidate: string, clicked: string): boolean {
  const c = normalizePath(candidate);
  const q = normalizePath(clicked);
  return c === q || c.endsWith("/" + q);
}

export function resolvePathClick(files: string[], clicked: string): string[] {
  return files.filter(f => matchesSuffix(f, clicked));
}
