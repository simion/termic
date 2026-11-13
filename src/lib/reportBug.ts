// The Report a bug button and the palette's "open issue": a prefilled GitHub
// issue with the version and OS filled in. When Termic has a crash log, it is
// also selected in the file manager, because ~/Library is hidden in Finder
// and users who were asked for the file could not find it (#429).
import { i18n } from "@/lib/i18n";
import { bugReportInfo, openPath, revealPath } from "@/lib/ipc";

export function issueBody(info: { version: string; os: string; crashLog: string | null }): string {
  const t = i18n.t.bind(i18n);
  const body = `${t("sidebar:bugIssueBody")}${info.version} (${info.os})`;
  return info.crashLog ? `${body}\n\n${t("sidebar:bugIssueCrashLog")}` : body;
}

export async function reportBug(): Promise<void> {
  const info = await bugReportInfo().catch(() => ({ version: "", os: "", crashLog: null }));
  if (info.crashLog) await revealPath(info.crashLog).catch(() => {});
  const q = `title=${encodeURIComponent(i18n.t("sidebar:bugIssueTitle"))}&body=${encodeURIComponent(issueBody(info))}`;
  await openPath(`https://github.com/simion/termic/issues/new?${q}`).catch(() => {});
}
