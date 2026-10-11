use std::process::ExitCode;

fn main() -> ExitCode {
    stella_source_lint::cli::run(std::env::args_os().skip(1))
}
