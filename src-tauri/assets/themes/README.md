# termic themes

Copy `example.json.sample` to `my-theme.json` and edit it. It shows up at
the bottom of the theme picker. Save the file, reopen the picker, done.

Four things the sample cannot show you:

- **Every key is optional.** The sample sets all of them, but a theme with
  only `bg` and `accent` works; the rest fall back to the built-in palette
  matching `colorScheme`.
- **`accent-fg` is the ink on a solid `accent` fill** (count badges, filled
  buttons), not body text. It defaults to white, so a light accent needs a
  dark value here or that text is unreadable. Same for `ok-fg` and `ok`.
- **Named colors are rejected.** Hex and `rgb()` / `rgba()` / `hsl()` /
  `hsla()` only. `"red"` is silently dropped.
- **Errors are silent in the UI.** If a theme does not appear, launch
  termic from a terminal and look for `[themes] skipping ...`.

Full key reference:
https://github.com/simion/termic/blob/main/docs/themes.md
