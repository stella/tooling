use std::process::ExitCode;

fn main() -> ExitCode {
    let mut arguments = std::env::args_os().skip(1).peekable();
    // Cargo passes the external subcommand name before its user arguments.
    if arguments
        .peek()
        .is_some_and(|argument| argument == "stella-lint")
    {
        arguments.next();
    }
    stella_source_lint::cli::run(arguments)
}
