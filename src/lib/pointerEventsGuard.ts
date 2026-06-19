// Safety net against Radix's "stuck `pointer-events: none` on <body>" bug.
//
// Radix modal layers (Dialog, ContextMenu, DropdownMenu, Popover, Tooltip)
// lock <body> with an inline `pointer-events: none` while open and restore it
// on close. When two layers' open/close lifecycles overlap (e.g. a right-click
// ContextMenu item that opens a confirm Dialog — GH #43) the restore can run in
// the wrong order and the lock is never lifted, leaving an invisible sheet over
// the entire UI that swallows every click.
//
// `askConfirm` already defers dialog mount to dodge the common race, but this
// guard is the deterministic backstop: whenever <body> carries the lock yet NO
// Radix overlay is actually open in the DOM, the lock is bogus, so we clear it.
// It can never fight a legitimately-open layer because it checks for one first.

// True while any Radix modal layer is genuinely mounted and open. Menus,
// dropdowns, popovers and tooltips render inside a popper wrapper; dialogs
// render their content with role=dialog/alertdialog and data-state=open.
function hasOpenRadixOverlay(): boolean {
  return !!document.querySelector(
    '[data-radix-popper-content-wrapper], ' +
    '[role="dialog"][data-state="open"], ' +
    '[role="alertdialog"][data-state="open"], ' +
    '[role="menu"][data-state="open"]',
  );
}

function clearBogusLock() {
  const body = document.body;
  if (!body) return;
  if (body.style.pointerEvents !== "none") return;
  if (hasOpenRadixOverlay()) return; // a real layer owns the lock — leave it
  body.style.pointerEvents = "";
}

let installed = false;

/** Install once, app-wide. Watches <body>'s inline style and reaps any
 *  orphaned `pointer-events: none` lock left behind by a Radix layer. */
export function installPointerEventsGuard() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  const obs = new MutationObserver(() => {
    if (document.body.style.pointerEvents !== "none") return;
    // Defer one macrotask so Radix's own (correct) cleanup wins the normal
    // case; we only step in when the lock is still orphaned afterward.
    setTimeout(clearBogusLock, 0);
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["style"] });
}
