// Boot for the needs-you panel (GH #468). Tiny on purpose, like activity.tsx:
// a second webview whose job is a few cards. Importing the prefs store paints
// it in the user's theme.
import "@/lib/lsMigration";
import { createRoot } from "react-dom/client";
import "./index.css";
import "@/lib/i18n";
import "@/store/prefs";
import { AttentionWindow } from "@/components/attention/AttentionWindow";

window.addEventListener("contextmenu", e => e.preventDefault());

createRoot(document.getElementById("root")!).render(<AttentionWindow />);
