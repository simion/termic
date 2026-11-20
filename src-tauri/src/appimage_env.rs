//! Keep the Linux AppImage's private environment out of what Termic spawns.
//!
//! An AppImage finds its bundled libraries through the environment: AppRun
//! and the GTK hook export `LD_LIBRARY_PATH`, `GTK_PATH`, `GIO_EXTRA_MODULES`,
//! `XDG_DATA_DIRS`, `PYTHONHOME` and a dozen more, all pointing into the
//! mounted AppDir (`/tmp/.mount_TermicXXXXXX`). The app needs them, and so do
//! the WebKit helper processes it starts (their RUNPATH alone resolves to the
//! HOST's libwebkit), so they cannot be dropped from our own environment.
//!
//! Every child inherits them too, and a child is the user's world, not ours:
//!
//!   * `LD_LIBRARY_PATH` makes every system binary load the libraries we
//!     bundled. On Ubuntu 25.10+ `env`, `ls` and `cat` are the Rust coreutils,
//!     which link libsystemd, and they die on our older copy ("version
//!     `LIBSYSTEMD_254' not found"). That killed every `#!/usr/bin/env`
//!     script in a Termic terminal, and our own `$SHELL -ilc env` login
//!     probe with it.
//!   * `PYTHONHOME` / `PYTHONPATH` / `PERLLIB` break python3 and perl (#47).
//!   * `GTK_PATH`, `GDK_PIXBUF_MODULE_FILE`, `GIO_EXTRA_MODULES`, ... hand
//!     our GTK's modules to any GTK program started from a terminal.
//!   * `GDK_BACKEND=x11` and `GTK_THEME` force XWayland and a theme on it.
//!
//! So each spawn gets the environment the user would have had: this module
//! works out the difference ONCE and `proc_ctl::command` and `pty_spawn`, the
//! two places a child is built, apply it.
//!
//! The rule is by VALUE, not by a list of names: any `:`-separated entry that
//! lives inside an AppImage mount is dropped, and a variable left with
//! nothing is removed. A list of names goes stale the first time the bundler
//! exports one more; a path into our own squashfs is never the host's.
//!
//! Plain std and compiled everywhere, like `linux_desktop`, so the tests run
//! on the machine they are written on. Off an AppImage `$APPDIR` is unset and
//! the override list is empty.

use std::path::Path;
use std::sync::OnceLock;

/// What to do to one variable in a child: `Some` replaces it, `None` removes.
pub type Override = (String, Option<String>);

/// Set by the AppImage runtime or the GTK hook, with a value that is not a
/// path into the AppDir, so the by-value rule cannot see them. The hook
/// overwrites `GTK_THEME` unconditionally and defaults `GDK_BACKEND` to x11,
/// both meant for our window only.
const NOT_FOR_CHILDREN: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "GDK_BACKEND", "GTK_THEME"];

/// The fontconfig file `hide_colrv1_fonts` points our own process at. A
/// `FONTCONFIG_FILE` naming it is ours, so children lose it; one the user
/// set is theirs and passes through.
const OWN_FONTCONFIG: &str = "appimage-fonts.conf";

/// The system's config plus one rule: no COLRv1 font.
#[cfg(any(target_os = "linux", test))]
const FONTCONFIG: &str = r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <selectfont><rejectfont><glob>*COLRv1*</glob></rejectfont></selectfont>
</fontconfig>
"#;

/// Keep COLRv1 color fonts away from the WebKitGTK we bundle.
///
/// The AppImage carries Ubuntu 22.04's WebKitGTK, whose Skia aborts on a
/// COLRv1 glyph (`colrv1_configure_skpaint`: assertion `__n < this->size()`).
/// The web process dies, the window goes blank and the app keeps running
/// behind it. Fedora 45's only color emoji font is `Noto-COLRv1.ttf`, so one
/// emoji in a task title or a file name was enough. Emoji fall back to
/// whatever other emoji font is installed, or tofu, which beats a blank
/// window. The host's own WebKitGTK (a `.deb`, a dev build) is not affected,
/// so only an AppImage does this, and never over a `FONTCONFIG_FILE` the
/// user set. Call before GTK starts: the WebKit helpers inherit it.
#[cfg(target_os = "linux")]
pub fn hide_colrv1_fonts(dir: &Path) {
    if std::env::var_os("APPDIR").is_none()
        || std::env::var_os("FONTCONFIG_FILE").is_some()
        || !Path::new("/etc/fonts/fonts.conf").exists()
    {
        return;
    }
    let path = dir.join(OWN_FONTCONFIG);
    if std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, FONTCONFIG)).is_ok() {
        std::env::set_var("FONTCONFIG_FILE", &path);
    }
}

/// Where AppImage mounts live: `<tmp>/.mount_`, from our own `$APPDIR`.
///
/// Sibling mounts count, not only ours. An AppImage started from another
/// one's terminal (a Termic relaunched by its updater, say) inherits the
/// first one's entries, and those are no more the host's than our own.
fn mount_prefix(appdir: &str) -> Option<String> {
    let appdir = appdir.trim_end_matches('/');
    let (parent, name) = appdir.rsplit_once('/')?;
    name.starts_with(".mount_").then(|| format!("{parent}/.mount_"))
}

/// The overrides for an environment, given the `$APPDIR` it was started with.
/// Pure, so the rule is testable without being an AppImage.
pub fn overrides_for(env: impl IntoIterator<Item = (String, String)>, appdir: &str) -> Vec<Override> {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() { return Vec::new(); }
    let mounts = mount_prefix(appdir);
    let inside = |entry: &str| {
        entry == appdir
            || entry.strip_prefix(appdir).is_some_and(|rest| rest.starts_with('/'))
            || mounts.as_deref().is_some_and(|m| entry.starts_with(m))
    };
    let mut out = Vec::new();
    for (k, v) in env {
        if NOT_FOR_CHILDREN.contains(&k.as_str())
            || (k == "FONTCONFIG_FILE" && v.ends_with(&format!("/{OWN_FONTCONFIG}")))
        {
            out.push((k, None));
            continue;
        }
        if !v.split(':').any(inside) { continue; }
        let kept: Vec<&str> = v.split(':').filter(|e| !e.is_empty() && !inside(e)).collect();
        out.push((k, (!kept.is_empty()).then(|| kept.join(":"))));
    }
    out
}

/// This process's overrides, computed once. Empty unless we are an AppImage.
pub fn overrides() -> &'static [Override] {
    static CACHE: OnceLock<Vec<Override>> = OnceLock::new();
    CACHE.get_or_init(|| {
        if !cfg!(target_os = "linux") { return Vec::new(); }
        let Ok(appdir) = std::env::var("APPDIR") else { return Vec::new() };
        overrides_for(std::env::vars(), &appdir)
    })
}

/// One variable as a child will see it: `std::env::var` minus the AppDir.
/// For code that reads our environment in order to hand it on (the PATH
/// served before the login-shell probe lands).
pub fn host_var(key: &str) -> Option<String> {
    match overrides().iter().find(|(k, _)| k == key) {
        Some((_, v)) => v.clone(),
        None => std::env::var(key).ok(),
    }
}

/// Give a std child the host's environment back.
pub fn scrub(cmd: &mut std::process::Command) {
    for (k, v) in overrides() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
}

/// The same for a PTY child. Call it AFTER copying our environment into the
/// builder and BEFORE the overlays, so a value the user set on purpose in
/// Settings still wins.
pub fn scrub_pty(cmd: &mut portable_pty::CommandBuilder) {
    for (k, v) in overrides() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_TermicAbCdEf";

    fn run(env: &[(&str, &str)]) -> Vec<Override> {
        overrides_for(env.iter().map(|(k, v)| (k.to_string(), v.to_string())), APPDIR)
    }

    fn get<'a>(o: &'a [Override], k: &str) -> Option<&'a Option<String>> {
        o.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }

    #[test]
    fn our_fontconfig_file_stays_out_of_children_and_the_users_does_not() {
        let o = run(&[("FONTCONFIG_FILE", "/home/u/.local/share/termic/appimage-fonts.conf")]);
        assert_eq!(get(&o, "FONTCONFIG_FILE"), Some(&None));
        let o = run(&[("FONTCONFIG_FILE", "/home/u/my-fonts.conf")]);
        assert_eq!(get(&o, "FONTCONFIG_FILE"), None);
    }

    #[test]
    fn the_fontconfig_keeps_the_system_config_and_rejects_colrv1() {
        assert!(FONTCONFIG.contains(r#"<include ignore_missing="yes">/etc/fonts/fonts.conf</include>"#));
        assert!(FONTCONFIG.contains("<rejectfont><glob>*COLRv1*</glob></rejectfont>"));
    }

    #[test]
    fn a_library_path_made_only_of_appdir_entries_is_removed() {
        // The reported case: nothing of the user's is in it, so the child must
        // not have the variable at all. An empty LD_LIBRARY_PATH is not the
        // same thing: ld.so reads an empty entry as the current directory.
        let o = run(&[("LD_LIBRARY_PATH", "/tmp/.mount_TermicAbCdEf/usr/lib/:/tmp/.mount_TermicAbCdEf/lib/")]);
        assert_eq!(get(&o, "LD_LIBRARY_PATH"), Some(&None));
    }

    #[test]
    fn the_users_own_entries_survive() {
        let o = run(&[
            ("LD_LIBRARY_PATH", "/tmp/.mount_TermicAbCdEf/usr/lib/:/opt/cuda/lib64"),
            ("PATH", "/tmp/.mount_TermicAbCdEf/usr/bin/:/home/alice/.local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_TermicAbCdEf/usr/share:/usr/share:/usr/local/share/"),
        ]);
        assert_eq!(get(&o, "LD_LIBRARY_PATH"), Some(&Some("/opt/cuda/lib64".into())));
        assert_eq!(get(&o, "PATH"), Some(&Some("/home/alice/.local/bin:/usr/bin".into())));
        assert_eq!(get(&o, "XDG_DATA_DIRS"), Some(&Some("/usr/share:/usr/local/share/".into())));
    }

    #[test]
    fn single_path_variables_are_caught_by_value_not_by_name() {
        // None of these names appears in this module. The GTK hook writes the
        // doubled slash, and a name list would have to keep up with it.
        let o = run(&[
            ("PYTHONHOME", "/tmp/.mount_TermicAbCdEf/usr/"),
            ("GTK_PATH", "/tmp/.mount_TermicAbCdEf//usr/lib/gtk-3.0"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_TermicAbCdEf//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ("GTK_DATA_PREFIX", "/tmp/.mount_TermicAbCdEf"),
            ("SOME_FUTURE_BUNDLER_VAR", "/tmp/.mount_TermicAbCdEf/usr/lib/whatever"),
        ]);
        for k in ["PYTHONHOME", "GTK_PATH", "GDK_PIXBUF_MODULE_FILE", "GTK_DATA_PREFIX", "SOME_FUTURE_BUNDLER_VAR"] {
            assert_eq!(get(&o, k), Some(&None), "{k}");
        }
    }

    #[test]
    fn another_appimages_mount_is_not_the_hosts_either() {
        // Started from a different AppImage's terminal, we inherit its
        // entries behind our own.
        let o = run(&[("PATH", "/tmp/.mount_TermicAbCdEf/usr/bin/:/tmp/.mount_OtherXyZ123/usr/bin/:/usr/bin")]);
        assert_eq!(get(&o, "PATH"), Some(&Some("/usr/bin".into())));
    }

    #[test]
    fn runtime_markers_and_window_only_settings_are_removed() {
        let o = run(&[
            ("APPDIR", APPDIR), ("APPIMAGE", "/home/alice/Termic.AppImage"),
            ("ARGV0", "/home/alice/Termic.AppImage"), ("OWD", "/home/alice"),
            ("GDK_BACKEND", "x11"), ("GTK_THEME", "Adwaita:light"),
        ]);
        for k in NOT_FOR_CHILDREN {
            assert_eq!(get(&o, k), Some(&None), "{k}");
        }
    }

    #[test]
    fn everything_else_is_left_exactly_alone() {
        // No override at all, not an identical one: the child inherits it.
        let o = run(&[
            ("HOME", "/home/alice"),
            ("EDITOR", "vim"),
            ("LS_COLORS", "di=01;34:ln=01;36"),
            ("ANTHROPIC_API_KEY", "sk-placeholder"),
        ]);
        assert!(o.is_empty(), "{o:?}");
    }

    #[test]
    fn an_extracted_appimage_scrubs_its_own_dir_only() {
        // `--appimage-extract` then `squashfs-root/AppRun`: APPDIR is an
        // ordinary directory, so there is no mount prefix to generalise from.
        let env = [
            ("LD_LIBRARY_PATH", "/home/alice/squashfs-root/usr/lib/:/opt/x/lib"),
            ("PATH", "/home/alice/squashfs-root-old/usr/bin:/usr/bin"),
        ];
        let o = overrides_for(
            env.iter().map(|(k, v)| (k.to_string(), v.to_string())),
            "/home/alice/squashfs-root/",
        );
        assert_eq!(get(&o, "LD_LIBRARY_PATH"), Some(&Some("/opt/x/lib".into())));
        assert_eq!(get(&o, "PATH"), None);
    }

    #[test]
    fn off_an_appimage_there_is_nothing_to_do() {
        let o = overrides_for([("PATH".to_string(), "/usr/bin".to_string())], "");
        assert!(o.is_empty());
    }
}
