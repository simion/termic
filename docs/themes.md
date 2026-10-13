# Custom themes

Drop a JSON file in termic's themes folder and it shows up in the theme
picker as a first-class theme: chrome and terminal, coupled, exactly like
the built-ins. There is no theme editor UI. The files are the interface,
which makes themes trivially shareable and stowable from dotfiles.

## Where

```
~/.config/termic/themes/
```

(`$XDG_CONFIG_HOME/termic/themes/` if you set that variable. Same path on
every platform; release and dev builds share it.)

Themes are hand-authored, shareable config, so they live under `.config`
like other terminal tools (wezterm, starship, kitty), not in the app-owned
Application Support data dir, which makes them trivially stowable from
dotfiles.

When the folder is empty, termic seeds it with a `README.md` and an
`example.json.sample` (a complete theme, ready to `cp` to `my-theme.json`).
Neither ends in `.json`, so the picker ignores both. Delete them once you
have your own theme; they only come back if the folder is emptied. The
sources live in `src-tauri/assets/themes/`.

One JSON file per theme. The picker's "Open themes folder" row opens this
directory (and creates it if needed). Themes are read at startup and
re-read every time the theme list opens, so the edit loop is: save the
file, reopen the list, done. No restart, no watcher.

## Picking a theme

One list holds every theme: the built-ins, your theme files and the
Ghostty / Warp imports. Three ways in: click the theme icon (sun/moon) in
the sidebar footer, press ⌥⌘T, or ⇧⌘P then "Change theme…".

- Sections: System, then Dark, then Light, each sorted by name. Each row is
  tagged with where it came from (Custom, Ghostty, Warp; built-ins carry
  none), and typing the tag filters to it.
- A Dark / Light / All toggle beside the search box (Tab cycles it). It
  opens on your saved choice, or on the current theme's scheme, so
  arrowing through dark themes never flashes a light one. A saved choice
  that would hide the current theme is skipped for that opening.
- The three themes you last committed are pinned at the top.
- The theme you have is named beside the search box, whatever the list
  is showing, and the list opens scrolled to its row. Clicking the name
  clears the search, widens a filter that hides it and jumps back to it
  (which also ends any preview).
- Arrow keys live-preview each theme; Enter commits, Escape rolls back to
  what you had. The footer opens the themes folder.

The keyboard theme-cycle shortcut only cycles System / Light / Dark, so a
custom theme sticks until you explicitly pick something else.

The theme's id is its file name (a file named `rose-pine-moon.json` becomes
`custom:rose-pine-moon` internally), so a file named `claude.json` can
never shadow the built-in Claude theme. A file name containing `:` is
skipped: that character is reserved for import ids (below).

## Ghostty and Warp themes

Themes you already have for Ghostty or Warp show up in the theme list
beside your own, tagged Ghostty / Warp. A Ghostty install alone is ~460
themes, which is why the list has a filter, sections and search.

Where termic looks (read only, nothing is ever written there):

- Ghostty: `$XDG_CONFIG_HOME/ghostty/themes` (default `~/.config/...`),
  `~/Library/Application Support/com.mitchellh.ghostty/themes`, then the
  bundled catalog, from the first of `$GHOSTTY_RESOURCES_DIR/themes`,
  `/Applications/Ghostty.app/...`, `~/Applications/Ghostty.app/...`,
  `/usr/local/share/ghostty/themes`, `/usr/share/ghostty/themes` that
  exists. A user theme shadows a bundled one of the same name, as in
  Ghostty. Ghostty's config (`theme =`) is not read: every name it can
  select is already listed from these dirs.
- Warp: `~/.warp/themes` and `$XDG_DATA_HOME/warp-terminal/themes`, three
  folders deep (a cloned `warpdotdev/themes` repo works). No Windows path
  yet.

Both formats are only a terminal palette (Warp adds an accent), so the
chrome is derived from it: surfaces step from the background toward the
foreground, status colors come from the ANSI slots, and anything used as
text on the chrome is pushed to 3:1 contrast. Light or dark is read off
the background.

Previewing any theme in the palette changes nothing on disk or in the
saved preference (`previewThemeMode`): quitting mid-preview reopens on the
theme you had. Committing an import
(Enter) saves it as an ordinary theme file in this folder, named
`<ghostty|warp>-<name>.json`, and switches to that. From then on it is a
normal custom theme: it syncs, you can edit it, and it stays put if the
Ghostty / Warp file goes away. The palette hides an import once its copy
exists; delete the copy to re-import a theme whose source changed. A copy
that exists but fails to parse (a hand edit gone wrong) is never
overwritten: picking the import again reports the clash instead. A file
name with no ASCII letters or digits has nothing to name the copy after,
so it does not list.

Caps, since those dirs are writable by other apps and cloned repos: 256 KB
per file, 512 files per source dir, 128 characters per name, and colors
must be hex.

## File format

```json
{
  "name": "Rosé Pine Moon",
  "colorScheme": "dark",
  "ui": {
    "bg": "#232136", "bg-1": "#2a273f", "bg-2": "#393552", "bg-3": "#44415a",
    "fg": "#e0def4", "fg-dim": "#908caa", "fg-faint": "#6e6a86",
    "border": "#56526e", "border-soft": "#393552",
    "hover": "rgba(224,222,244,0.05)", "sel": "rgba(196,167,231,0.22)",
    "accent": "#c4a7e7", "accent-soft": "rgba(196,167,231,0.22)", "accent-deep": "#6f5b9e",
    "accent-fg": "#232136",
    "ok": "#9ccfd8", "ok-fg": "#232136", "warn": "#f6c177", "err": "#eb6f92",
    "palette-red": "#eb6f92", "palette-orange": "#e89f6f", "palette-yellow": "#f6c177",
    "palette-green": "#97c9a3", "palette-teal": "#9ccfd8", "palette-blue": "#3e8fb0",
    "palette-purple": "#c4a7e7", "palette-pink": "#d8a0c9"
  },
  "terminal": {
    "background": "#232136", "foreground": "#e0def4",
    "cursor": "#c4a7e7", "selectionBackground": "#44415a",
    "black": "#393552", "red": "#eb6f92", "green": "#3e8fb0", "yellow": "#f6c177",
    "blue": "#9ccfd8", "magenta": "#c4a7e7", "cyan": "#ea9a97", "white": "#e0def4",
    "brightBlack": "#6e6a86", "brightRed": "#eb6f92", "brightGreen": "#3e8fb0",
    "brightYellow": "#f6c177", "brightBlue": "#9ccfd8", "brightMagenta": "#c4a7e7",
    "brightCyan": "#ea9a97", "brightWhite": "#e0def4"
  }
}
```

### Top-level fields

| Field | Required | Values | Notes |
| --- | --- | --- | --- |
| `name` | yes | string | Picker label. Falls back to the file name if empty. |
| `colorScheme` | yes | `"dark"` or `"light"` | Drives form controls, the editor's auto syntax theme, and the `COLORFGBG` env var agents use to pick their TUI theme. Anything other than `"light"` is treated as `"dark"`. |
| `ui` | no | object | Chrome colors, see below. |
| `terminal` | no | object | xterm palette, see below. |

Unknown top-level fields are ignored (forward compatibility).

### `ui` keys

Every key is optional and maps to the `--color-<key>` CSS variable. Missing
keys fall back to the built-in palette matching your `colorScheme` (Dark+
for dark themes, Light for light ones), so a minimal theme can override
just `bg` and `accent` and still look coherent.

| Key | What it paints |
| --- | --- |
| `bg` | main content area |
| `bg-1` | chrome: sidebar, title bar, tabs |
| `bg-2` | nested cards, badges |
| `bg-3` | hover and active surfaces |
| `fg` | primary text |
| `fg-dim` | muted text |
| `fg-faint` | faint icons, secondary text |
| `border` | standard borders |
| `border-soft` | hairline borders |
| `hover` | hover overlay (usually a low-alpha rgba) |
| `sel` | selection tint |
| `accent` | brand accent (buttons, active states) |
| `accent-soft` | accent-tinted backgrounds (usually low-alpha rgba) |
| `accent-deep` | accent for filled buttons |
| `accent-fg` | ink on a solid `accent` fill (count badges, filled CTAs). Defaults to white; set a dark ink if your accent is light |
| `ok` | success green |
| `ok-fg` | ink on a solid `ok` fill (toggle knobs). Defaults to white |
| `warn` | warning yellow |
| `err` | error red |
| `palette-red` … `palette-pink` | hue-named accent ramp for user-assigned marks (today: project-group folder colors). 8 keys: `palette-red`, `palette-orange`, `palette-yellow`, `palette-green`, `palette-teal`, `palette-blue`, `palette-purple`, `palette-pink`. Tune shades to your theme, but keep each hue recognizable: users pick colors by name and expect "red" to stay red across themes |

The `--color-cli-*` agent tint variables are not themeable in v1; they keep
their defaults. So do `--color-pr-merged` / `--color-pr-open`, the pull-request
state tints on the sidebar and dashboard task rows: like the agent tints they
are matched to somebody else's palette (GitHub's), so a theme re-shading them
would make the glyph stop reading as the state it names. Both flip with
`colorScheme`, so a light theme gets the darker pair automatically.

### `terminal` keys

Standard xterm.js `ITheme` keys, all optional: `background`, `foreground`,
`cursor`, `cursorAccent`, `selectionBackground`, `selectionForeground`,
`selectionInactiveBackground`, the ANSI 8 (`black` through `white`), and
the bright ANSI 8 (`brightBlack` through `brightWhite`).

Missing keys fall back to the built-in palette matching your `colorScheme`
(Dark+ for dark themes, Light for light ones), so a partial block still
yields a complete, readable ANSI 16.

### Color values

Hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and `rgb()` / `rgba()` /
`hsl()` / `hsla()` notation. Named CSS colors are not accepted.

## Error handling

Nothing about a theme file can break the app:

- A file that fails to parse is skipped (the rest still list). Check the
  dev console / stderr for a `[themes] skipping ...` line.
- An unknown key or a malformed color value is dropped; the key falls back
  to its default.
- Deleting the active theme's file falls back to the Claude theme on the
  next picker open or launch.

## Notes

- Two files with the same `name` both list (their ids differ). The picker
  shows whatever the files say.
- The active custom theme's payload is cached in localStorage so the first
  paint after launch uses it directly. The folder is re-read right after
  startup and reconciled (edits re-apply, deletions fall back).
