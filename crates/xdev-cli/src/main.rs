use clap::Parser;

#[derive(Parser)]
#[command(name = "xdev", version = xdev_core::version(), about = "Local-first project knowledge for humans and AI agents")]
struct Cli {}

fn main() {
    Cli::parse();
}
