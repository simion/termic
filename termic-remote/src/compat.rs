//! Which versions work together (docs/remote.md, "Versions that work
//! together"). A minimum per side, not a 1:1 match: most releases change
//! nothing on the wire, and forcing every server and paired computer onto
//! the exact same build on each release would make every release a
//! breaking one.
//!
//! Raise a minimum only when this build stops working with what is older:
//! a request or a message the other side must understand, a field it must
//! send, a reply shape it reads. The release skill
//! (.claude/skills/release/SKILL.md) checks the diff since the last tag
//! and proposes a bump; nothing else changes these.
//!
//! Both floors must stay at or below the app's own version (a test pins
//! it), so a build always works with itself.

/// The oldest termic-server this Termic desktop works with. A server older
/// than this is upgraded and restarted onto the build the desktop carries
/// as soon as no agent there is mid-turn; a newer-but-different one is
/// upgraded quietly and restarts when the user chooses.
pub const REQUIRES_SERVER: &str = "1.24.6";

/// The oldest Termic desktop this build works with: as a paired computer
/// (checked both ways), and, in termic-server, as the desktop driving it.
/// A desktop older than a server's floor is told to update itself instead
/// of downgrading the server.
pub const REQUIRES_DESKTOP: &str = "1.24.3";

/// `major.minor.patch` of a version, ignoring a `+build` or `-pre` suffix.
/// None for anything else (a hand-built or test version), which compares
/// as older than every floor.
pub fn core(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split(['+', '-']).next()?;
    let mut it = v.split('.').map(|p| p.parse::<u64>().ok());
    let r = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(r)
}

/// Whether `v` is at least `min`. An unreadable `v` is not.
pub fn at_least(v: &str, min: &str) -> bool {
    match (core(v), core(min)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versions_and_compares_by_core() {
        assert_eq!(core("1.25.0"), Some((1, 25, 0)));
        assert_eq!(core("v1.25.0"), Some((1, 25, 0)));
        assert_eq!(core("1.25.0+abc123def456"), Some((1, 25, 0)));
        assert_eq!(core("1.25.0-beta.1"), Some((1, 25, 0)));
        for bad in ["", "0-old", "1.25", "1.25.0.1", "x.y.z"] {
            assert_eq!(core(bad), None, "{bad}");
        }
        assert!(at_least("1.25.0", "1.25.0"));
        assert!(at_least("1.25.1+abc", "1.25.0"));
        assert!(at_least("1.100.0", "1.25.0"));
        assert!(!at_least("1.24.9", "1.25.0"));
        assert!(!at_least("0-old", "0.0.0"));
    }

    #[test]
    fn floors_are_versions() {
        assert!(core(REQUIRES_SERVER).is_some());
        assert!(core(REQUIRES_DESKTOP).is_some());
    }
}
