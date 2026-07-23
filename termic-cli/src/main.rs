fn main() {
    // A closed stdout pipe (`termic ... | head`) must end the process
    // the standard unix way (SIGPIPE, shells report 141), not as a
    // Rust panic with exit 101: the runtime ignores SIGPIPE by default
    // and println! panics on EPIPE. 141 is outside, and compatible
    // with, the 0-10 exit contract.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    std::process::exit(termic_cli::run());
}
