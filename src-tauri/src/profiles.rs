//! Profiles: a fully isolated termic instance (own projects, tasks, settings,
//! agents) in its own window. See `docs/plans/profiles.md`.
//!
//! Two rules carry the whole module and both are load-bearing:
//!
//! 1. **The default profile IS the app data dir.** It has no directory of its
//!    own and no slug on disk. An install that never creates a second profile
//!    has no `profiles.json`, no `profiles/` tree, and byte-identical files to
//!    a pre-profiles install. That is what makes the feature migration-free,
//!    and it is why [`ProfileId`] has a `Root` variant rather than every
//!    profile being a slug.
//!
//! 2. **The profile rides the DATA, not the call.** Records are loaded from
//!    every profile and tagged in memory with the directory they came from, so
//!    a by-id lookup (a task id is a UUID, unique across profiles) needs no
//!    profile at all, and a write can go back where the record came from. Only
//!    LISTING and CREATION need to name a profile. The alternative, deriving
//!    it from the calling window, was measured against the call graph and does
//!    not survive: ~200 sites, a large minority of them in `cli_server`,
//!    `mcp_server`, watchers and per-task threads with no window to take.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Registry filename, in the app data dir. ABSENT until the first profile is
/// created, and absent again once the last one is deleted: its absence is the
/// "this feature does not exist yet" state the UI keys off, not a missing file
/// to be healed.
pub const REGISTRY_FILE: &str = "profiles.json";

/// Subdirectory holding every profile EXCEPT the root one.
pub const PROFILES_SUBDIR: &str = "profiles";

/// Which profile a record belongs to.
///
/// `Root` is the profile whose data is the app data dir itself. There is at
/// most one, `Registry::root_slug` names it, and there may be none at all
/// (the root profile can be deleted like any other, which just clears that
/// field: nothing is promoted and nothing moves).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub enum ProfileId {
    #[default]
    Root,
    Slug(String),
}

impl ProfileId {
    /// The slug, or `None` for the root profile (which has no directory).
    pub fn slug(&self) -> Option<&str> {
        match self {
            ProfileId::Root => None,
            ProfileId::Slug(s) => Some(s.as_str()),
        }
    }

    pub fn is_root(&self) -> bool {
        matches!(self, ProfileId::Root)
    }

    /// The window label this profile's window carries.
    ///
    /// `tauri-plugin-window-state` keys saved frames by label, so these must be
    /// stable and distinct or every profile fights over one saved geometry.
    /// The root profile keeps the literal `main` label it has always had: a
    /// pre-profiles install must find its window frame exactly where it left
    /// it, and `main` is hardcoded in the automation bridge besides.
    pub fn window_label(&self) -> String {
        match self {
            ProfileId::Root => "main".to_string(),
            ProfileId::Slug(s) => format!("profile-{s}"),
        }
    }

    /// Inverse of [`window_label`](Self::window_label).
    ///
    /// Returns `None` for a label that is not a profile window at all (the
    /// Activity monitor, say), which is what lets a caller distinguish "the
    /// root profile" from "not a profile window".
    pub fn from_window_label(label: &str) -> Option<ProfileId> {
        if label == "main" {
            return Some(ProfileId::Root);
        }
        label.strip_prefix("profile-").map(|s| ProfileId::Slug(s.to_string()))
    }
}

impl std::fmt::Display for ProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProfileId::Root => f.write_str("(root)"),
            ProfileId::Slug(s) => f.write_str(s),
        }
    }
}

/// One profile's registry entry. The DATA lives in the profile's directory;
/// this is only what every window needs to know about every profile.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    /// Frozen at creation, never changes. It keys BOTH trees: the data dir
    /// (`<data>/profiles/<slug>/`) and the worktrees base
    /// (`~/termic/profiles/<slug>/tasks`), so the two halves of a profile are
    /// the same word in both places. Renaming the profile renames `name` and
    /// nothing else, because CWD-resume agents key sessions to the working
    /// directory and relocating worktrees would orphan every conversation
    /// under them.
    pub slug: String,
    /// User-facing label. Renameable, and shown in the sidebar strip.
    pub name: String,
    /// Accent color, `#rrggbb`. Tints the strip, which is the largest
    /// always-on surface it gets.
    pub accent: String,
    #[serde(default)]
    pub order: u32,
    /// RFC3339. Breaks the tie when a project exists in several profiles:
    /// Chrome's rule, most recently focused wins.
    #[serde(default)]
    pub last_focused_at: Option<String>,
    /// Whether this profile had a window up when the app last quit.
    ///
    /// Launch restores exactly these. The plan left the choice open (every
    /// profile that was open, or only the last focused one) and this is the
    /// answer: the use case is two windows on two monitors AT THE SAME TIME,
    /// so relaunching to one window would be a daily papercut for the person
    /// who asked for the feature. Cleared when the USER closes a window, so a
    /// deliberate close is remembered; app quit does not clear it, which is
    /// what makes "restore what I had" work at all.
    #[serde(default)]
    pub open_at_quit: bool,
}

/// `profiles.json`.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct Registry {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// Which slug owns the ROOT data dir (the pre-profiles install). `None`
    /// once that profile has been deleted, after which every remaining profile
    /// lives under `profiles/<slug>/` and the root holds only global state.
    #[serde(default)]
    pub root_slug: Option<String>,
}

impl Registry {
    /// The profile a data dir id belongs to, or `None` with no profiles.
    pub fn profile_of(&self, id: &ProfileId) -> Option<&Profile> {
        match id {
            ProfileId::Root => self.root_slug.as_deref().and_then(|s| self.get(s)),
            ProfileId::Slug(s) => self.get(s),
        }
    }

    pub fn get(&self, slug: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.slug == slug)
    }

    /// Resolve a slug to the id whose DIRECTORY it uses. The profile flagged
    /// as root uses the root paths; everyone else uses `profiles/<slug>/`.
    /// One line, and it is the only place that asymmetry is expressed.
    pub fn id_for(&self, slug: &str) -> ProfileId {
        if self.root_slug.as_deref() == Some(slug) {
            ProfileId::Root
        } else {
            ProfileId::Slug(slug.to_string())
        }
    }

    /// Every profile id with data on disk, root first.
    ///
    /// An EMPTY registry still yields `[Root]`: an install with no profiles is
    /// an install with one unnamed profile, which is what keeps every loader
    /// below identical in both states.
    pub fn ids(&self) -> Vec<ProfileId> {
        if self.profiles.is_empty() {
            return vec![ProfileId::Root];
        }
        let mut out = Vec::new();
        if self.root_slug.is_some() {
            out.push(ProfileId::Root);
        }
        for p in &self.profiles {
            if self.root_slug.as_deref() != Some(p.slug.as_str()) {
                out.push(ProfileId::Slug(p.slug.clone()));
            }
        }
        out
    }

    /// True when the feature is dormant: no profiles, so no strip, no second
    /// window, and every path resolves exactly as it did before profiles
    /// existed.
    pub fn is_dormant(&self) -> bool {
        self.profiles.is_empty()
    }
}

/// Filesystem-safe, lowercase, deduped against `taken`.
///
/// Deliberately strict rather than merely escaped: the slug becomes a path
/// segment in two trees AND a window label, so anything that could traverse
/// (`.`, `/`) or collide case-insensitively on APFS is folded out here rather
/// than validated at each use.
pub fn slugify(name: &str, taken: &HashSet<String>) -> String {
    let mut s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    let base = if s.is_empty() { "profile".to_string() } else { s };
    let base: String = base.chars().take(48).collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "profile".to_string() } else { base };

    if !taken.contains(&base) {
        return base;
    }
    for n in 2..10_000u32 {
        let cand = format!("{base}-{n}");
        if !taken.contains(&cand) {
            return cand;
        }
    }
    format!("{base}-{}", uuid::Uuid::new_v4().simple())
}

/// The directory holding one profile's `settings.json`, `projects.json`,
/// `tasks/` and `scratch/`.
pub fn profile_dir(global: &Path, id: &ProfileId) -> PathBuf {
    match id {
        ProfileId::Root => global.to_path_buf(),
        ProfileId::Slug(s) => global.join(PROFILES_SUBDIR).join(s),
    }
}

pub fn registry_path(global: &Path) -> PathBuf {
    global.join(REGISTRY_FILE)
}

/// Read the registry. A missing file is the dormant state, NOT an error.
///
/// A CORRUPT file is also treated as dormant rather than fatal, for the same
/// reason `load_projects` tolerates a bad `projects.json`: refusing to start is
/// a worse failure than starting with the feature dormant, and the root
/// profile's data is reachable either way.
pub fn load_registry(global: &Path) -> Registry {
    let p = registry_path(global);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Registry::default(),
    }
}

/// Write the registry, or DELETE it when the last profile goes away.
///
/// The delete is the point: absence is the dormant state, so a registry left
/// behind holding `{"profiles":[]}` would leave the strip logic reading an
/// empty list forever rather than returning the app to its pre-profiles shape.
pub fn save_registry(global: &Path, reg: &Registry) -> Result<()> {
    let p = registry_path(global);
    if reg.profiles.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    let json = serde_json::to_string_pretty(reg)?;
    crate::write_atomic(&p, json.as_bytes()).map_err(|e| anyhow!("write profiles.json: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn slugify_lowercases_and_dashes() {
        assert_eq!(slugify("Work Stuff", &taken(&[])), "work-stuff");
        assert_eq!(slugify("Acme  Inc.", &taken(&[])), "acme-inc");
    }

    #[test]
    fn slugify_dedupes_with_a_numeric_suffix() {
        assert_eq!(slugify("Work", &taken(&["work"])), "work-2");
        assert_eq!(slugify("Work", &taken(&["work", "work-2"])), "work-3");
    }

    #[test]
    fn slugify_never_yields_a_traversal_or_an_empty_segment() {
        // The slug is a path segment in two trees; these must not survive.
        for hostile in ["..", "../..", "/", "...", "   ", "", "-", "./."] {
            let s = slugify(hostile, &taken(&[]));
            assert!(!s.is_empty(), "{hostile:?} produced an empty slug");
            assert!(!s.contains('/'), "{hostile:?} kept a separator: {s}");
            assert!(!s.contains('.'), "{hostile:?} kept a dot: {s}");
            assert_ne!(s, "-");
        }
    }

    /// Does a capability `windows` entry cover this label? Only the trailing
    /// `*` form is implemented, which is the only form the file uses.
    fn glob_covers(pattern: &str, label: &str) -> bool {
        match pattern.strip_suffix('*') {
            Some(prefix) => label.starts_with(prefix),
            None => pattern == label,
        }
    }

    #[test]
    fn every_profile_window_is_covered_by_a_tauri_capability() {
        // Capabilities are scoped by window LABEL, and a window matching no
        // entry gets NO permissions at all, `core:event` included. A profile
        // window then cannot listen for events, so every PTY spawn in it dies
        // with `event.listen not allowed on window "profile-work"` and the
        // window is inert.
        //
        // It shipped that way because the root profile keeps the literal
        // `main` label: the first window worked, and only the SECOND one was
        // broken, which is the half of the feature nobody exercises until a
        // real profile exists. Nothing in the type system connects
        // `window_label()` to a JSON file, so this test is the connection.
        let raw = include_str!("../capabilities/default.json");
        let cap: serde_json::Value = serde_json::from_str(raw).expect("default.json parses");
        let windows: Vec<String> = cap["windows"]
            .as_array()
            .expect("capability lists windows")
            .iter()
            .map(|w| w.as_str().unwrap_or_default().to_string())
            .collect();

        // Derived from the real label builder, so renaming the scheme fails
        // here rather than silently at runtime in a window nobody tested.
        for slug in ["work", "personal", "a-very-long-profile-name-2"] {
            let label = ProfileId::Slug(slug.into()).window_label();
            assert!(
                windows.iter().any(|p| glob_covers(p, &label)),
                "no capability window pattern covers {label:?} (have {windows:?}). \
                 A profile window with no capability gets no permissions at all, \
                 so it cannot listen for events and every spawn in it fails.",
            );
        }
        // ...and the root window, which is the one that always worked.
        let root = ProfileId::Root.window_label();
        assert!(windows.iter().any(|p| glob_covers(p, &root)), "root window {root:?} uncovered");
    }

    #[test]
    fn window_label_round_trips_and_root_keeps_main() {
        assert_eq!(ProfileId::Root.window_label(), "main");
        assert_eq!(ProfileId::Slug("work".into()).window_label(), "profile-work");
        assert_eq!(ProfileId::from_window_label("main"), Some(ProfileId::Root));
        assert_eq!(
            ProfileId::from_window_label("profile-work"),
            Some(ProfileId::Slug("work".into()))
        );
        // Not a profile window at all: the Activity monitor must not resolve
        // to the root profile by accident.
        assert_eq!(ProfileId::from_window_label("procmon"), None);
    }

    #[test]
    fn a_dormant_registry_still_has_one_profile_to_load_from() {
        let reg = Registry::default();
        assert!(reg.is_dormant());
        assert_eq!(reg.ids(), vec![ProfileId::Root]);
    }

    #[test]
    fn the_root_slug_decides_which_profile_uses_the_root_dir() {
        let reg = Registry {
            profiles: vec![
                Profile { slug: "work".into(), name: "Work".into(), accent: "#f00".into(), order: 0, last_focused_at: None, open_at_quit: false },
                Profile { slug: "home".into(), name: "Home".into(), accent: "#0f0".into(), order: 1, last_focused_at: None, open_at_quit: false },
            ],
            root_slug: Some("work".into()),
        };
        assert_eq!(reg.id_for("work"), ProfileId::Root);
        assert_eq!(reg.id_for("home"), ProfileId::Slug("home".into()));
        assert_eq!(reg.ids(), vec![ProfileId::Root, ProfileId::Slug("home".into())]);
    }

    #[test]
    fn deleting_the_root_profile_leaves_every_other_one_in_its_own_dir() {
        // The asymmetry that surfaces when the profile living at the root is
        // the one deleted: nothing is promoted, nothing moves, root_slug just
        // clears.
        let reg = Registry {
            profiles: vec![Profile {
                slug: "home".into(), name: "Home".into(), accent: "#0f0".into(), order: 1, last_focused_at: None, open_at_quit: false,
            }],
            root_slug: None,
        };
        assert_eq!(reg.ids(), vec![ProfileId::Slug("home".into())]);
        assert!(!reg.is_dormant());
    }

    #[test]
    fn profile_of_resolves_root_and_slugs_and_nothing_without_profiles() {
        let p = |slug: &str| Profile { slug: slug.into(), name: slug.to_uppercase(), accent: "#123456".into(), order: 0, last_focused_at: None, open_at_quit: false };
        let reg = Registry { profiles: vec![p("work"), p("home")], root_slug: Some("work".into()) };
        assert_eq!(reg.profile_of(&ProfileId::Root).map(|x| x.name.as_str()), Some("WORK"));
        assert_eq!(reg.profile_of(&ProfileId::Slug("home".into())).map(|x| x.name.as_str()), Some("HOME"));
        assert!(Registry::default().profile_of(&ProfileId::Root).is_none());
    }

    #[test]
    fn profile_dir_puts_the_root_profile_at_the_data_dir_itself() {
        let g = Path::new("/data");
        assert_eq!(profile_dir(g, &ProfileId::Root), PathBuf::from("/data"));
        assert_eq!(
            profile_dir(g, &ProfileId::Slug("work".into())),
            PathBuf::from("/data/profiles/work")
        );
    }

    #[test]
    fn saving_an_empty_registry_removes_the_file() {
        // Absence IS the dormant state, so the last delete must return the
        // install to its pre-profiles shape rather than leave an empty list.
        let tmp = std::env::temp_dir().join(format!("termic-prof-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let reg = Registry {
            profiles: vec![Profile {
                slug: "work".into(), name: "Work".into(), accent: "#f00".into(), order: 0, last_focused_at: None, open_at_quit: false,
            }],
            root_slug: Some("work".into()),
        };
        save_registry(&tmp, &reg).unwrap();
        assert!(registry_path(&tmp).exists());
        assert_eq!(load_registry(&tmp), reg);

        save_registry(&tmp, &Registry::default()).unwrap();
        assert!(!registry_path(&tmp).exists());
        assert!(load_registry(&tmp).is_dormant());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_corrupt_registry_reads_as_dormant_rather_than_failing() {
        let tmp = std::env::temp_dir().join(format!("termic-prof-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(registry_path(&tmp), b"{ not json").unwrap();
        assert!(load_registry(&tmp).is_dormant());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
