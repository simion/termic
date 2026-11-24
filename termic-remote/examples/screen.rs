//! Replay PTY output through the screen reader, for debugging what a
//! remote client will see: `termic logs <task> | cargo run --example screen -- 24 80`
use std::io::Read;

fn main() {
    let args: Vec<u16> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    let (rows, cols) = (*args.first().unwrap_or(&24), *args.get(1).unwrap_or(&80));
    let mut bytes = Vec::new();
    std::io::stdin().read_to_end(&mut bytes).expect("stdin");
    let lines = termic_remote::screen::render(&bytes, rows, cols);
    for l in &lines {
        println!("|{l}");
    }
    println!("question: {:#?}", termic_remote::screen::question(&lines));
    println!("activity: {:?}", termic_remote::screen::activity(&lines));
}
