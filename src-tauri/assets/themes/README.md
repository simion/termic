# termic themes

Every `.json` file in this folder becomes a theme in termic's picker.

## Start here

1. Copy the sample to a real theme file:

   ```sh
   cp example.json.sample my-theme.json
   ```

2. Edit the colors in `my-theme.json`.
3. Hover the theme icon in termic's title bar. Your theme is at the bottom
   of the list, named by the file's `name` field.

That is the whole loop: save the file, hover the picker, done. No restart,
no watcher. The folder is re-read every time the picker opens.

## Rules of thumb

- The file name is the theme's id, so `my-theme.json` can never collide
  with a built-in theme.
- Every color key is optional. Missing keys fall back to the built-in
  palette matching your `colorScheme`, so a theme that sets only `bg` and
  `accent` still looks coherent. Set `colorScheme` to `"light"` or
  `"dark"`; it drives form controls, the editor's syntax theme, and the
  `COLORFGBG` variable agent CLIs read to pick their own theme.
- Colors accept hex (`#abc`, `#aabbcc`, `#aabbccdd`) and `rgb()`, `rgba()`,
  `hsl()`, `hsla()`. Named colors like `red` are rejected.
- Nothing here can break termic. A file that fails to parse is skipped, and
  a bad color value is dropped so that key falls back to its default. Run
  termic from a terminal to see `[themes] skipping ...` lines.
- `accent-fg` is the ink painted on top of a solid `accent` fill (count
  badges, filled buttons). It defaults to white, so set a dark value if
  your accent is light, or the text on those controls will be unreadable.
  `ok-fg` does the same for the `ok` color.

## Full reference

`example.json.sample` lists every supported key. The complete format
reference, including what each `ui` key paints, lives at:

https://github.com/simion/termic/blob/main/docs/themes.md

## Housekeeping

These two files (`README.md` and `example.json.sample`) are not themes and
are ignored by the picker. Delete them once you have your own theme. They
are only recreated if this folder is completely empty.
