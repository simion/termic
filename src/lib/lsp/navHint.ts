// What ⌘-click does when there is no server to answer it (GH #174).
//
// The gesture is the same one everywhere else in the editor, and until now it
// did NOTHING unless the checkout happened to be armed: no jump, no message,
// no cursor change. A reader who has used any IDE tries ⌘-click first, gets
// silence, and concludes the editor is broken rather than that a feature is
// off. Silence is the worst answer available, because it is the only one that
// teaches nothing.
//
// So the click always answers, in one of two ways:
//
//   - **We can serve this language.** Say so, and offer to turn it on right
//     there. This is the same act as the compass chip, at the moment the
//     person actually wanted it, which is the moment they will agree to the
//     memory it costs.
//   - **Nothing serves this language.** Say that instead, and say it once,
//     quietly. A Makefile is never going to have go-to-definition and the
//     honest thing is to stop the reader trying.
//
// Deliberately main-chunk safe: no `@codemirror/lsp-client`, no `lib/lsp/host`
// (mainChunkGuard.test.ts). The affordance is cheap; the machinery is only
// fetched once someone says yes.

import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { currentCodeIntelName } from "./featureName";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useCodeIntel, checkoutRoot, grantKey } from "@/store/codeIntel";
import { useUI } from "@/store/ui";
import { lspServerFor } from "./languages";
import { i18n } from "@/lib/i18n";

/** Show the hint at `pos`, or dismiss it with null. */
const setHint = StateEffect.define<{ pos: number; language: string; server: string | null } | null>();

/** The word under `pos`, so the hint anchors to a SYMBOL rather than to
 *  whitespace. Clicking empty space is not a question about a name. */
function wordAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let i = pos - line.from;
  const isWord = (c: string) => /[\w$]/.test(c);
  if (i > 0 && !isWord(text[i] ?? "") && isWord(text[i - 1] ?? "")) i -= 1;
  if (!isWord(text[i] ?? "")) return null;
  let from = i;
  let to = i;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return { from: line.from + from, to: line.from + to };
}

interface HintState { pos: number; language: string; server: string | null }

function tooltipFor(
  state: HintState,
  taskId: string,
  dismiss: (view: EditorView) => void,
): Tooltip {
  return {
    pos: state.pos,
    above: false,
    arrow: true,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-navhint";
      if (!state.server) {
        // Nothing can serve it. One line, no offer, no button to press.
        dom.textContent = `No code navigation for ${state.language}.`;
        return { dom };
      }
      const text = dom.appendChild(document.createElement("span"));
      text.textContent = `${currentCodeIntelName()} is off for this project.`;
      const button = dom.appendChild(document.createElement("button"));
      button.className = "cm-lsp-navhint-action";
      button.textContent = `Turn on for ${state.language}`;
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const app = useApp.getState();
        const task = app.tasks.find(t => t.id === taskId);
        const project = task ? app.projects.find(p => p.id === task.project_id) : undefined;
        if (!task) return;
        // The app-wide switch may also be off, in which case turning the
        // feature on here is what the person just asked for.
        usePrefs.getState().setCodeIntelligence(true);
        useCodeIntel.getState().arm(grantKey(checkoutRoot(task, project), state.server!), task.id);
        // Get out of the way. The popup said "off"; leaving it on screen after
        // the server has started says the button did nothing, which is the one
        // thing it definitely did not do.
        dismiss(view);
        // Where the answer moved to. The chip is what knows whether the server
        // is starting, indexing or ready, and a cold server can take a while
        // to be useful, so point at it rather than leaving the reader to
        // wonder whether the click took.
        useUI.getState().pushToast(
          i18n.t("backend:navHint.on", { language: state.language, feature: currentCodeIntelName().toLowerCase() }),
          "success",
        );
      });
      return { dom };
    },
  };
}

/**
 * @param taskId  which task's checkout gets armed if they say yes.
 * @param language  reads the registry's name for this buffer ("Python",
 *   "Makefile") AT CLICK TIME, so a hand-picked syntax is honoured.
 */
export function navHint(taskId: string, language: () => string, path?: string): Extension {
  // The click handler needs the field declared beside it; a box breaks the
  // cycle without hoisting either out of this factory, so each editor still
  // gets its own pair.
  const fieldRef: { current: StateField<HintState | null> | null } = { current: null };
  const field = StateField.define<HintState | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setHint)) return e.value;
      // Any edit, or moving the cursor elsewhere, ends it. A hint that
      // outlives the question is just clutter.
      if (tr.docChanged || tr.selection) return null;
      return value;
    },
    provide: f => showTooltip.from(f, s => (
      s ? tooltipFor(s, taskId, v => v.dispatch({ effects: setHint.of(null) })) : null
    )),
  });

  fieldRef.current = field;

  return [
    field,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const mod = event.metaKey || (navigator.platform.startsWith("Mac") ? false : event.ctrlKey);
        if (!mod || event.button !== 0 || event.altKey || event.shiftKey) return false;
        // Read at CLICK time. Baked in at view creation, a file whose syntax
        // was picked by hand ("Set syntax → Python" on an extensionless file)
        // kept answering for whatever it was at mount: the one affordance that
        // exists to stop a reader concluding the editor is broken told them
        // "No code navigation for Plain Text" while the real extension would
        // have served Python.
        const lang = language();
        const server = lspServerFor(lang, path);
        const app = useApp.getState();
        const task = app.tasks.find(t => t.id === taskId);
        const project = task ? app.projects.find(p => p.id === task.project_id) : undefined;
        // Already armed: the real navigation extension owns this click and
        // this one must not eat it.
        if (task && server) {
          const armed = (useCodeIntel.getState().grants[grantKey(checkoutRoot(task, project), server)] ?? []).length > 0;
          if (armed) {
            // Armed since this hint opened (from the chip, or another editor
            // on the same checkout). Clear the stale "it is off" and let the
            // real navigation extension have the click.
            if (fieldRef.current && view.state.field(fieldRef.current, false)) {
              view.dispatch({ effects: setHint.of(null) });
            }
            return false;
          }
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const word = wordAt(view, pos);
        if (!word) return false;
        // Offered for any language something can serve. The project's list
        // governs auto start, not whether a reader may turn this on here.
        const offerable = !!server;
        event.preventDefault();
        view.dispatch({
          effects: setHint.of({
            pos: word.from,
            language: lang,
            server: offerable ? server : null,
          }),
        });
        return true;
      },
      keydown(event, view) {
        if (event.key !== "Escape") return false;
        if (!view.state.field(field, false)) return false;
        view.dispatch({ effects: setHint.of(null) });
        return true;
      },
    }),
    EditorView.theme({
      ".cm-tooltip.cm-tooltip-below .cm-lsp-navhint, .cm-lsp-navhint": {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        fontSize: "12.5px",
        color: "var(--color-fg-dim)",
      },
      ".cm-lsp-navhint-action": {
        border: "1px solid var(--color-border)",
        borderRadius: "4px",
        padding: "1px 8px",
        fontSize: "12px",
        color: "var(--color-fg)",
        backgroundColor: "var(--color-bg-2)",
        cursor: "pointer",
      },
      ".cm-lsp-navhint-action:hover": { backgroundColor: "var(--color-hover)" },
    }),
  ];
}
