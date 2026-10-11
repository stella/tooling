use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::{collect_sources, lint_source};

pub fn run(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> ExitCode {
    let mut paths = Vec::new();
    for argument in arguments {
        if argument == "--help" || argument == "-h" {
            println!(
                "Usage: cargo stella-lint [PATH ...]\nChecks Rust sources under PATH (default: .)."
            );
            return ExitCode::SUCCESS;
        }
        if argument == "--" {
            continue;
        }
        paths.push(PathBuf::from(argument));
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    let mut files = Vec::new();
    for path in paths {
        if let Err(error) = collect_sources(&path, &mut files) {
            eprintln!("{}: {error}", path.display());
            return ExitCode::from(2);
        }
    }
    files.sort();
    files.dedup();
    let mut status = 0;
    for path in files {
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                eprintln!("{}: {error}", path.display());
                status = 2;
                continue;
            }
        };
        match lint_source(&source) {
            Ok(diagnostics) => {
                for diagnostic in diagnostics {
                    eprintln!(
                        "{}:{}:{}: stella_lowercase: stella should be written lowercase; replace `Stella` with `stella`",
                        path.display(),
                        diagnostic.line,
                        diagnostic.column
                    );
                    if status == 0 {
                        status = 1;
                    }
                }
            }
            Err(error) => {
                let start = error.span().start();
                eprintln!(
                    "{}:{}:{}: {error}",
                    path.display(),
                    start.line,
                    start.column + 1
                );
                status = 2;
            }
        }
    }
    ExitCode::from(status)
}
