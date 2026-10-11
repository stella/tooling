use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::config::FixturePaths;
use crate::{capitalized_product_name, collect_sources, lint_source};

pub fn run(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> ExitCode {
    let mut paths = Vec::new();
    let mut config = None;
    let mut arguments = arguments.into_iter();
    let mut positional = false;
    while let Some(argument) = arguments.next() {
        if !positional && (argument == "--help" || argument == "-h") {
            println!(
                "Usage: cargo stella-lint [--config FILE] [PATH ...]\nChecks Rust sources under PATH (default: .)."
            );
            return ExitCode::SUCCESS;
        }
        if !positional && argument == "--" {
            positional = true;
            continue;
        }
        if !positional && argument == "--config" {
            let Some(path) = arguments.next() else {
                eprintln!("--config requires a file path");
                return ExitCode::from(2);
            };
            if config.is_some() {
                eprintln!("--config may be supplied only once");
                return ExitCode::from(2);
            }
            match FixturePaths::load(&PathBuf::from(path)) {
                Ok(fixtures) => config = Some(fixtures),
                Err(error) => {
                    eprintln!("invalid fixture configuration: {error}");
                    return ExitCode::from(2);
                }
            }
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
        if let Some(fixtures) = &config {
            match fixtures.contains(&path) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    eprintln!("{}: {error}", path.display());
                    status = 2;
                    continue;
                }
            }
        }
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
                        "{}:{}:{}: stella_lowercase: stella should be written lowercase; replace `{}` with `stella`",
                        path.display(),
                        diagnostic.line,
                        diagnostic.column,
                        capitalized_product_name()
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
