//! Read Ghostty and Warp themes as termic custom themes.
//!
//! Both formats only describe a terminal palette (Warp adds an accent), so
//! this module fills `terminal` and leaves `ui` to the frontend, which
//! derives the chrome from the palette (see `sanitizeImport` in
//! src/lib/customTheme.ts). Nothing here writes into those dirs: the files
//! stay owned by Ghostty / Warp and are re-read when the command palette's
//! theme list opens.
//!
//! An import is never the active theme. Picking one copies it into the
//! termic themes dir as a native file (`themes_save_import` in lib.rs, named
//! by `copy_stem`), so the pick syncs like any other and cannot vanish when
//! the Ghostty / Warp file does.
//!
//! Those dirs are writable by other apps, sandboxed agents and cloned repos,
//! so everything read is bounded here, before it crosses IPC: file size,
//! file count, entries listed, name length, and colors (`#hex` only).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::CustomThemeFile;

/// Ghostty `palette = N=...` index → xterm ITheme key.
const ANSI: [&str; 16] = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/// Biggest theme / config file read. Real ones are a few KB; the cap is what
/// keeps a stray `*.yaml` log or a symlink to `/dev/zero` from eating memory.
const MAX_BYTES: u64 = 256 * 1024;

/// Most files one import source may contribute. A cloned warpdotdev/themes
/// repo is a few hundred; past this the walk stops.
const MAX_FILES: usize = 512;

/// Most entries read from one directory listing before sorting. Bounds the
/// cost of a dir with a million entries on every scan.
// ponytail: past this the kept subset follows readdir order, not name order,
// so which themes list in a dir that size is not stable. Nobody has one.
const MAX_ENTRIES: usize = MAX_FILES * 4;

/// Longest display name kept. File names and Warp `name:` are both input.
const MAX_NAME: usize = 128;

/// Read a regular UTF-8 file of at most `MAX_BYTES`. `None` for anything
/// else: a FIFO would block `open` forever and a device file never ends,
/// and both can sit in a themes dir under a theme-looking name. The checks
/// run on the open handle (`read_capped_file`), so swapping the file for
/// one of those between a check and the open does not get past them.
pub(crate) fn read_capped(p: &Path) -> Option<String> {
    String::from_utf8(crate::read_capped_file(p, MAX_BYTES).ok()?).ok()
}

type CacheEntry = ((SystemTime, u64), Option<CustomThemeFile>);

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Parse `p` once per (mtime, len), so reopening the picker over a cloned
/// Warp repo is a stat per file rather than a few hundred YAML parses.
/// `prune_cache` drops entries a scan no longer sees.
fn parse_cached(p: &Path, parse: impl FnOnce(&str) -> Option<CustomThemeFile>) -> Option<CustomThemeFile> {
    let m = fs::metadata(p).ok()?;
    let key = (m.modified().ok()?, m.len());
    if let Some((k, v)) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(p) {
        if *k == key {
            return v.clone();
        }
    }
    let v = read_capped(p).and_then(|raw| parse(&raw));
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(p.to_path_buf(), (key, v.clone()));
    v
}

/// Forget cached files under `dirs` that the last scan did not visit.
/// Without it, something that keeps renaming files in a themes dir grows the
/// cache for the life of the app. Paths outside `dirs` are left alone
/// (another scan's roots, e.g. a test's tempdir).
fn prune_cache(seen: &HashSet<&PathBuf>, dirs: &[PathBuf]) {
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|p, _| seen.contains(p) || !dirs.iter().any(|d| p.starts_with(d)));
}

/// Where to look.
struct Roots {
    home: PathBuf,
    config: PathBuf,
    data: PathBuf,
    /// Candidate locations of Ghostty's bundled theme catalog, in order.
    /// Only the first that exists is listed: they are the same catalog
    /// installed different ways.
    bundled: Vec<PathBuf>,
}

/// The e2e build lets `TERMIC_E2E_THEME_HOME` stand in for all of it, with
/// `<home>/bundled` as the only bundled dir, so the suite reads fixtures
/// instead of the developer's real Ghostty / Warp themes. Feature-gated like
/// `TERMIC_E2E_AGENT_HOME` in agent_hooks.rs.
fn roots() -> Option<Roots> {
    #[cfg(feature = "e2e")]
    {
        if let Some(h) = std::env::var_os("TERMIC_E2E_THEME_HOME").map(PathBuf::from) {
            return Some(Roots { config: h.join(".config"), data: h.join(".local/share"), bundled: vec![h.join("bundled")], home: h });
        }
    }
    let home = dirs::home_dir()?;
    let xdg = |var: &str, default: &str| {
        std::env::var_os(var)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(default))
    };
    let (config, data) = (xdg("XDG_CONFIG_HOME", ".config"), xdg("XDG_DATA_HOME", ".local/share"));
    // Ghostty exports its resources dir into the shells it starts, so a
    // termic launched from one finds a source or Homebrew install too
    let mut bundled: Vec<PathBuf> = std::env::var_os("GHOSTTY_RESOURCES_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("themes"))
        .into_iter()
        .collect();
    bundled.extend([
        PathBuf::from("/Applications/Ghostty.app/Contents/Resources/ghostty/themes"),
        home.join("Applications/Ghostty.app/Contents/Resources/ghostty/themes"),
        PathBuf::from("/usr/local/share/ghostty/themes"),
        PathBuf::from("/usr/share/ghostty/themes"),
    ]);
    Some(Roots { home, config, data, bundled })
}

/// Up to `MAX_ENTRIES` entries of `dir`, sorted by name. Empty when the dir
/// is missing or unreadable.
fn list_dir(dir: &Path) -> Vec<fs::DirEntry> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut entries: Vec<fs::DirEntry> = rd.flatten().take(MAX_ENTRIES).collect();
    entries.sort_by_key(|e| e.file_name());
    entries
}

/// Lowercase, dash-separated id fragment from a theme file name
/// ("Monokai Classic" → "monokai-classic").
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// A color as `#hex`. Ghostty accepts hex with or without the `#`, Warp
/// writes it with. Anything else (Ghostty's X11 color names, a 200 KB
/// string) is `None`: the frontend fills the key from the base palette.
fn hex(v: &str) -> Option<String> {
    let v = v.trim().trim_matches('"');
    let bare = v.strip_prefix('#').unwrap_or(v);
    let ok = matches!(bare.len(), 3 | 4 | 6 | 8) && bare.chars().all(|c| c.is_ascii_hexdigit());
    ok.then(|| format!("#{bare}"))
}

/// `key` is the id fragment, `name` the display name. The name stays plain:
/// the palette tags each row with its source, read off the id. `None` when `key`
/// slugs to nothing (a file name with no ASCII letters or digits): every
/// such file would share the one id `ghostty:`, which `copy_stem` refuses,
/// so it would list and then fail to pick. A long slug is cut to what
/// `copy_stem` accepts for the same reason.
fn theme(source: &str, key: &str, name: &str, terminal: HashMap<String, String>) -> Option<CustomThemeFile> {
    let mut key = slug(key);
    key.truncate(MAX_NAME); // ASCII only, so any byte is a char boundary
    let key = key.trim_end_matches('-');
    if key.is_empty() {
        return None;
    }
    let name: String = name.chars().take(MAX_NAME).collect();
    Some(CustomThemeFile {
        id: format!("{source}:{key}"),
        name,
        // left empty: the frontend reads the scheme off the background
        color_scheme: String::new(),
        ui: HashMap::new(),
        terminal: terminal.into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect(),
    })
}

/// File stem of the native copy of import `id` (`ghostty:monokai` →
/// `ghostty-monokai`), or `None` for anything that is not an import id this
/// module could have produced. The id comes back from the webview, so it is
/// checked rather than trusted: it becomes a path. The frontend applies the
/// same `:` → `-` rule to hide imports that already have a copy
/// (`copyIdOf` in src/lib/customTheme.ts).
pub(crate) fn copy_stem(id: &str) -> Option<String> {
    let (source, key) = id.split_once(':')?;
    let ok = matches!(source, "ghostty" | "warp")
        && !key.is_empty()
        && key.len() <= MAX_NAME
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then(|| format!("{source}-{key}"))
}

// ── Ghostty ──────────────────────────────────────────────────────────────

/// Parse a Ghostty theme file (`key = value` lines, `palette = N=color`).
pub fn parse_ghostty(raw: &str) -> HashMap<String, String> {
    let mut t = HashMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (key, value) = match k.trim() {
            "palette" => {
                let Some((idx, color)) = v.split_once('=') else { continue };
                let Some(name) = idx.trim().parse::<usize>().ok().and_then(|i| ANSI.get(i)) else { continue };
                (*name, color)
            }
            "background" => ("background", v),
            "foreground" => ("foreground", v),
            "cursor-color" => ("cursor", v),
            "cursor-text" => ("cursorAccent", v),
            "selection-background" => ("selectionBackground", v),
            "selection-foreground" => ("selectionForeground", v),
            _ => continue,
        };
        if let Some(c) = hex(value) {
            t.insert(key.to_string(), c);
        }
    }
    t
}

/// Ghostty theme files to read, and the dirs they come from: the user theme
/// dirs, then the bundled catalog (~460 files). User dirs come first, so a
/// user theme shadows a bundled one of the same name in `scan`'s dedup,
/// which is also how Ghostty resolves a name. Ghostty's config (`theme =`)
/// is not read: every name it can select already lists from these dirs.
fn ghostty_files(r: &Roots) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mac = r.home.join("Library/Application Support/com.mitchellh.ghostty");
    let mut dirs: Vec<PathBuf> = [r.config.join("ghostty"), mac].iter().map(|d| d.join("themes")).collect();
    dirs.extend(r.bundled.iter().find(|d| d.is_dir()).cloned());

    let mut files: Vec<PathBuf> = Vec::new();
    for dir in &dirs {
        let found = list_dir(dir).into_iter().map(|e| e.path()).filter(|p| p.is_file());
        files.extend(found.take(MAX_FILES));
    }
    (files, dirs)
}

fn ghostty_theme(p: &Path) -> Option<CustomThemeFile> {
    let name = p.file_name()?.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    parse_cached(p, |raw| {
        let terminal = parse_ghostty(raw);
        // a file with no colors is not a theme (stray README, etc.)
        if !terminal.contains_key("background") && !terminal.contains_key("black") {
            return None;
        }
        theme("ghostty", name, name, terminal)
    })
}

// ── Warp ─────────────────────────────────────────────────────────────────

/// A Warp color is a hex string, or a gradient map (`{left, right}` /
/// `{top, bottom}`). For a gradient, the first stop stands in.
fn warp_color(v: &serde_yml::Value) -> Option<String> {
    match v {
        serde_yml::Value::String(s) => hex(s),
        serde_yml::Value::Mapping(m) => m.values().find_map(warp_color),
        _ => None,
    }
}

/// `(name, accent, terminal)` read out of a Warp theme. Warp's `details:
/// darker|lighter` is not read: the frontend takes the scheme from the
/// background luminance, which the derived surfaces are stepped for, so the
/// two cannot disagree.
type WarpTheme = (Option<String>, Option<String>, HashMap<String, String>);

/// Parse a Warp theme YAML.
pub fn parse_warp(raw: &str) -> Option<WarpTheme> {
    let doc: serde_yml::Value = serde_yml::from_str(raw).ok()?;
    let mut t = HashMap::new();
    for (key, yaml) in [("background", "background"), ("foreground", "foreground")] {
        if let Some(c) = doc.get(yaml).and_then(warp_color) {
            t.insert(key.to_string(), c);
        }
    }
    for (group, prefix) in [("normal", ""), ("bright", "bright")] {
        let Some(colors) = doc.get("terminal_colors").and_then(|tc| tc.get(group)) else { continue };
        for base in &ANSI[..8] {
            if let Some(c) = colors.get(*base).and_then(warp_color) {
                let key = if prefix.is_empty() {
                    base.to_string()
                } else {
                    format!("{prefix}{}{}", base[..1].to_uppercase(), &base[1..])
                };
                t.insert(key, c);
            }
        }
    }
    if t.is_empty() {
        return None;
    }
    let name = doc.get("name").and_then(|n| n.as_str()).map(str::to_string);
    let accent = doc.get("accent").and_then(warp_color);
    Some((name, accent, t))
}

fn warp_dirs(r: &Roots) -> Vec<PathBuf> {
    vec![r.home.join(".warp/themes"), r.data.join("warp-terminal/themes")]
}

/// Warp users often clone the warpdotdev/themes repo into the themes dir,
/// which nests themes a couple of folders deep. The walk is depth-capped,
/// does not follow symlinked dirs (a link to `.` or `$HOME` would fan out
/// on every scan), skips dot-entries (`.git/objects`, `.github/*.yml`), and
/// stops at `MAX_FILES`. Entries are sorted so the same tree always yields
/// the same list, which is what makes the dedup in `scan` deterministic.
fn yaml_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    for e in list_dir(dir) {
        if out.len() >= MAX_FILES {
            return;
        }
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            if depth > 0 {
                yaml_files(&p, depth - 1, out);
            }
        } else if matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")) {
            // a symlinked file is fine, `read_capped` checks what it points at
            out.push(p);
        }
    }
}

fn warp_theme(p: &Path) -> Option<CustomThemeFile> {
    let stem = p.file_stem()?.to_str()?;
    parse_cached(p, |raw| {
        let (name, accent, terminal) = parse_warp(raw)?;
        // id from the file stem, not the display name: two files sharing a
        // `name:` must not collide
        let mut t = theme("warp", stem, name.as_deref().unwrap_or(stem), terminal)?;
        if let Some(a) = accent {
            t.ui.insert("accent".into(), serde_json::Value::String(a));
        }
        Some(t)
    })
}

/// Every importable Ghostty / Warp theme, deduped by id (first wins) and
/// sorted for a stable picker order. "First" is stable: both scans visit
/// files in sorted path order.
pub fn imported_themes() -> Vec<CustomThemeFile> {
    roots().map(|r| scan(&r)).unwrap_or_default()
}

fn scan(r: &Roots) -> Vec<CustomThemeFile> {
    let (ghostty, mut dirs) = ghostty_files(r);
    let mut warp = Vec::new();
    for d in warp_dirs(r) {
        let mut files = Vec::new();
        yaml_files(&d, 3, &mut files);
        warp.extend(files);
        dirs.push(d);
    }

    let mut ids = HashSet::new();
    let mut out: Vec<CustomThemeFile> = Vec::new();
    let themes = ghostty.iter().filter_map(|p| ghostty_theme(p)).chain(warp.iter().filter_map(|p| warp_theme(p)));
    for t in themes {
        if ids.insert(t.id.clone()) {
            out.push(t);
        }
    }
    prune_cache(&ghostty.iter().chain(&warp).collect(), &dirs);
    out.sort_by_key(|t| t.name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // synthetic Ghostty theme in the shape the bundled files use: bare and
    // #-prefixed hex mixed, a comment, an out-of-range palette index
    const GHOSTTY: &str = "\
# monokai-ish
palette = 0=#272822
palette = 1=f92672
palette=9 = #f92672
palette = 16=#ffffff
background = 272822
foreground = #f8f8f2
cursor-color = #f8f8f0
cursor-text = #272822
selection-background = #49483e
selection-foreground = #f8f8f2
font-size = 14
";

    #[test]
    fn ghostty_parses_palette_and_specials() {
        let t = parse_ghostty(GHOSTTY);
        assert_eq!(t["black"], "#272822");
        assert_eq!(t["red"], "#f92672");
        assert_eq!(t["brightRed"], "#f92672");
        assert_eq!(t["background"], "#272822");
        assert_eq!(t["cursor"], "#f8f8f0");
        assert_eq!(t["cursorAccent"], "#272822");
        assert_eq!(t["selectionBackground"], "#49483e");
        assert!(!t.contains_key("font-size"));
        assert_eq!(t.len(), 9);
    }

    const WARP: &str = "\
name: Monokai
accent: '#f92672'
background: '#272822'
foreground: '#f8f8f2'
details: darker
terminal_colors:
  normal:
    black: '#272822'
    red: '#f92672'
  bright:
    black: '#75715e'
    magenta:
      left: '#ae81ff'
      right: '#66d9ef'
";

    #[test]
    fn warp_parses_colors_and_gradients() {
        let (name, accent, t) = parse_warp(WARP).unwrap();
        assert_eq!(name.as_deref(), Some("Monokai"));
        assert_eq!(accent.as_deref(), Some("#f92672"));
        assert_eq!(t["red"], "#f92672");
        assert_eq!(t["brightBlack"], "#75715e");
        assert_eq!(t["brightMagenta"], "#ae81ff");
        assert_eq!(t["background"], "#272822");
    }

    #[test]
    fn warp_rejects_non_theme_yaml() {
        assert!(parse_warp("foo: bar\n").is_none());
        assert!(parse_warp(": not yaml [").is_none());
    }

    #[test]
    fn read_capped_rejects_oversized_and_special_files() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("ok.yaml");
        fs::write(&ok, "name: x\n").unwrap();
        assert_eq!(read_capped(&ok).as_deref(), Some("name: x\n"));

        let big = dir.path().join("big.yaml");
        fs::write(&big, vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read_capped(&big).is_none());

        assert!(read_capped(dir.path()).is_none(), "a dir is not a file");
        assert!(read_capped(&dir.path().join("missing.yaml")).is_none());

        // a FIFO must be refused before `open`, which would block forever
        #[cfg(unix)]
        {
            let fifo = dir.path().join("fifo.yaml");
            assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
            assert!(read_capped(&fifo).is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn yaml_walk_skips_symlinked_dirs_and_dot_entries_in_sorted_order() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("standard")).unwrap();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::create_dir_all(root.join(".github")).unwrap();
        for f in ["b.yaml", "a.yml", "standard/c.yaml", ".git/objects/x.yaml", ".github/ci.yml", "notes.txt"] {
            fs::write(root.join(f), "x: 1\n").unwrap();
        }
        // links back to the root and out to elsewhere: neither is walked
        symlink(root, root.join("loop")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("o.yaml"), "x: 1\n").unwrap();
        symlink(outside.path(), root.join("out")).unwrap();
        // a symlinked FILE is still listed; read_capped vets its target
        symlink(outside.path().join("o.yaml"), root.join("linked.yaml")).unwrap();

        let mut out = Vec::new();
        yaml_files(root, 3, &mut out);
        let rel: Vec<_> = out.iter().map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(rel, ["a.yml", "b.yaml", "linked.yaml", "standard/c.yaml"]);
    }

    #[test]
    fn yaml_walk_stops_at_file_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..MAX_FILES + 5 {
            fs::write(dir.path().join(format!("{i:04}.yaml")), "").unwrap();
        }
        let mut out = Vec::new();
        yaml_files(dir.path(), 3, &mut out);
        assert_eq!(out.len(), MAX_FILES);
    }

    #[test]
    fn parse_cached_reparses_only_when_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.yaml");
        fs::write(&p, "one").unwrap();
        let mut calls = 0;
        let mut run = |p: &Path| {
            parse_cached(p, |raw| {
                calls += 1;
                Some(CustomThemeFile { name: raw.to_string(), ..Default::default() })
            })
        };
        assert_eq!(run(&p).unwrap().name, "one");
        assert_eq!(run(&p).unwrap().name, "one");
        // a different length changes the key even inside one mtime tick
        fs::write(&p, "three").unwrap();
        assert_eq!(run(&p).unwrap().name, "three");
        drop(run);
        assert_eq!(calls, 2);
    }

    #[test]
    fn hex_keeps_only_short_hex() {
        assert_eq!(hex("272822").as_deref(), Some("#272822"));
        assert_eq!(hex(" \"#FfF\" ").as_deref(), Some("#FfF"));
        assert_eq!(hex("#27282280").as_deref(), Some("#27282280"));
        assert_eq!(hex("cornflowerblue"), None);
        assert_eq!(hex("#12345"), None);
        assert_eq!(hex("url(https://x)"), None);
        assert_eq!(hex(&"a".repeat(200_000)), None);
    }

    #[test]
    fn ghostty_drops_non_hex_values() {
        let t = parse_ghostty("background = black\npalette = 1=#f92672\n");
        assert!(!t.contains_key("background"));
        assert_eq!(t["red"], "#f92672");
    }

    const THEME: &str = "background = 272822\npalette = 0=#272822\n";

    fn roots_in(home: &Path) -> Roots {
        Roots { config: home.join(".config"), data: home.join(".local/share"), bundled: vec![home.join("bundled")], home: home.to_path_buf() }
    }

    fn write(home: &Path, rel: &str, body: &str) {
        let p = home.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn scan_lists_user_themes_then_the_bundled_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path();
        write(h, ".config/ghostty/themes/Mine", THEME);
        write(h, "bundled/Other", THEME);
        // the bundled copy is shadowed by the user's, so its background never shows
        write(h, "bundled/Mine", "background = 000000\n");
        write(h, ".warp/themes/standard/w.yaml", "background: '#272822'\n");

        let themes = scan(&roots_in(h));
        let ids: Vec<&str> = themes.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids.iter().filter(|i| **i == "ghostty:mine").count(), 1);
        assert!(ids.contains(&"ghostty:other"));
        assert!(ids.contains(&"warp:w"));
        let mine = themes.iter().find(|t| t.id == "ghostty:mine").unwrap();
        assert_eq!(mine.terminal["background"], "#272822");
    }

    #[test]
    fn scan_lists_only_the_first_bundled_dir_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path();
        write(h, "b2/Second", THEME);
        write(h, "b3/Third", THEME);
        let mut r = roots_in(h);
        r.bundled = vec![h.join("missing"), h.join("b2"), h.join("b3")];
        let ids: Vec<String> = scan(&r).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["ghostty:second"]);
    }

    #[test]
    fn copy_stem_accepts_only_import_ids() {
        assert_eq!(copy_stem("ghostty:monokai-classic").as_deref(), Some("ghostty-monokai-classic"));
        assert_eq!(copy_stem("warp:w").as_deref(), Some("warp-w"));
        // the id becomes a file name, so nothing path-like gets through
        for bad in ["ghostty:", "ghostty:../x", "ghostty:a/b", "ghostty:A", "other:x", "warp", "", "warp:x:y"] {
            assert_eq!(copy_stem(bad), None, "{bad}");
        }
        assert_eq!(copy_stem(&format!("warp:{}", "a".repeat(MAX_NAME + 1))), None);
        // every id scan can produce round-trips
        assert_eq!(copy_stem(&format!("ghostty:{}", slug("Rosé Pine (moon)"))).as_deref(), Some("ghostty-ros-pine-moon"));
    }

    #[test]
    fn theme_ids_always_survive_copy_stem() {
        let t = |key: &str| theme("ghostty", key, key, HashMap::new());
        // nothing to slug: dropped, not listed as an unpickable `ghostty:`
        assert!(t("東京").is_none());
        assert!(t("---").is_none());
        // too long: cut to what copy_stem takes, with no dangling dash
        let long = format!("{}-{}", "a".repeat(MAX_NAME - 1), "b".repeat(50));
        for key in ["Monokai Classic", "Rosé Pine", long.as_str()] {
            let id = t(key).unwrap().id;
            assert!(copy_stem(&id).is_some(), "{id}");
            assert!(!id.ends_with('-'), "{id}");
        }
    }

    #[test]
    fn scan_caps_display_names() {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path();
        write(h, ".warp/themes/long.yaml", &format!("name: {}\nbackground: '#272822'\n", "n".repeat(10_000)));
        let t = scan(&roots_in(h)).pop().unwrap();
        assert_eq!(t.name, "n".repeat(MAX_NAME));
    }

    #[test]
    fn scan_prunes_cache_entries_for_files_that_went_away() {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path();
        write(h, ".warp/themes/a.yaml", "background: '#272822'\n");
        let a = h.join(".warp/themes/a.yaml");
        scan(&roots_in(h));
        assert!(cache().lock().unwrap().contains_key(&a));
        fs::rename(&a, h.join(".warp/themes/b.yaml")).unwrap();
        scan(&roots_in(h));
        let c = cache().lock().unwrap();
        assert!(!c.contains_key(&a));
        assert!(c.contains_key(&h.join(".warp/themes/b.yaml")));
    }

    #[test]
    fn slug_is_stable() {
        assert_eq!(slug("Monokai Classic"), "monokai-classic");
        assert_eq!(slug("Rosé Pine (moon)"), "ros-pine-moon");
    }
}
