// Toggles a `termic-mod-held` class on <html> while Cmd/Ctrl is held, so CSS
// can gate modifier-only affordances. Currently used by the terminal link
// styling (index.css): links underline on hover always, but the hand cursor
// only shows while the modifier is held, matching when a Cmd/Ctrl+click would
// actually open the link (see TerminalPane / AuxTerminal WebLinksAddon).
//
// One global listener set, installed once — modifier state is window-wide, so
// there's no reason to track it per terminal.

let initialized = false;

export function initModKeyClass() {
  if (initialized) return;
  initialized = true;

  const html = document.documentElement;
  const set = (held: boolean) => html.classList.toggle("termic-mod-held", held);

  // The modifier's OWN keydown already reports metaKey/ctrlKey true, so a bare
  // Cmd/Ctrl press flips it on. On keyup we only clear once BOTH are released
  // (holding Cmd+Ctrl and lifting one keeps it on). blur clears any stuck
  // state when focus leaves the window mid-hold (e.g. Cmd+Tab away).
  window.addEventListener("keydown", e => { if (e.metaKey || e.ctrlKey) set(true); });
  window.addEventListener("keyup", e => { if (!e.metaKey && !e.ctrlKey) set(false); });
  window.addEventListener("blur", () => set(false));
}
