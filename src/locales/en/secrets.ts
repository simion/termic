// Secrets + roles (credential broker). Split by surface so the settings
// screens and the task-side surfaces (dialogs, footer, sidebar) can grow
// independently: `manage` = Settings -> Secrets and project defaults,
// `task` = New Task / sandbox dialogs, footer chip, popover, sidebar.
import manage from "./secretsManage";
import task from "./secretsTask";

export default { manage, task };
