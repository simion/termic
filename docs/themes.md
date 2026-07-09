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

One JSON file per theme. The picker's "Open themes folder" row opens this
directory (and creates it if needed). Themes are read at startup and
re-read every time the picker opens, so the edit loop is: save the file,
hover the picker, done. No restart, no watcher.

## Picking a theme

Two ways, same as the built-ins:

- Hover the theme icon (sun/moon) in the title bar. Custom themes list
  below the built-ins, with an "Open themes folder" row at the bottom.
- ⌘K, then "Change theme…". Arrow keys live-preview each theme; Enter
  commits, Escape rolls back to what you had.

The keyboard theme-cycle shortcut only cycles System / Light / Dark, so a
custom theme sticks until you explicitly pick something else.

The theme's id is its file name (a file named `rose-pine-moon.json` becomes
`custom:rose-pine-moon` internally), so a file named `claude.json` can
never shadow the built-in Claude theme.

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
    "ok": "#9ccfd8", "warn": "#f6c177", "err": "#eb6f92"
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

The `--color-cli-*` agent tint variables are not themeable in v1; they keep
their defaults.

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
