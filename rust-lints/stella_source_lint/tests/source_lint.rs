use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use stella_source_lint::{Diagnostic, collect_sources, excluded_path, lint_source};

#[test]
fn original_ui_reports_only_the_product_name() {
    assert_eq!(
        lint_source(include_str!("fixtures/main.rs")).unwrap(),
        vec![Diagnostic {
            line: 2,
            column: 20
        }],
    );
}

#[test]
fn boundaries_preserve_the_original_unicode_word_rule() {
    let boundaries = [' ', '.', '-', ':', '\n', '(', ')', '🦀'];
    let word_characters = ['a', 'Z', '0', '_', 'é', 'Ж', '中', '٣'];
    for character in boundaries {
        for value in [format!("{character}Stella"), format!("Stella{character}")] {
            let source = format!("fn main() {{ let _ = {value:?}; }}");
            assert_eq!(lint_source(&source).unwrap().len(), 1, "{value:?}");
        }
    }
    for character in word_characters {
        for value in [format!("{character}Stella"), format!("Stella{character}")] {
            let source = format!("fn main() {{ let _ = {value:?}; }}");
            assert!(lint_source(&source).unwrap().is_empty(), "{value:?}");
        }
    }
}

#[test]
fn strings_are_decoded_and_macro_literals_are_checked_once() {
    let source = r###"fn main() {
    let _ = r#"Stella tooling"#;
    let _ = "\u{53}tella tooling";
    println!("Stella tooling");
    nested!({ inner!("Stella tooling") });
    let _ = b"Stella tooling";
    let _ = c"Stella tooling";
}"###;
    let diagnostics = lint_source(source).unwrap();
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.line)
            .collect::<Vec<_>>(),
        vec![2, 3, 4, 5]
    );
}

#[test]
fn doc_comments_attributes_and_comments_are_not_literal_expressions() {
    let source = r###"//! Stella tooling
/// Stella tooling
#[doc = "Stella tooling"]
#[allow(reason = "Stella tooling", dead_code)]
fn example() {
    // Stella tooling
    /* Stella tooling */
    quote! {
        /// Stella tooling
        #[doc = "Stella tooling"]
        fn nested() {}
    };
}"###;
    assert!(lint_source(source).unwrap().is_empty());
}

#[test]
fn arbitrary_macro_brackets_are_checked_without_treating_them_as_attributes() {
    let positive = r###"fn main() {
    passthrough!(# ["stella tooling"]);
    passthrough!(#! ["stella tooling"]);
    passthrough!(# [doc = "Stella tooling"]);
    passthrough!(#! [doc = "Stella tooling"]);
}"###;
    assert!(lint_source(positive).unwrap().is_empty());

    let mutation = positive.replace("stella tooling", "Stella tooling");
    assert_ne!(positive, mutation);
    let diagnostics = lint_source(&mutation).unwrap();
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.line)
            .collect::<Vec<_>>(),
        vec![2, 3],
    );
}

#[test]
fn malformed_sources_are_errors() {
    assert!(lint_source("fn main( {").is_err());
}

#[test]
fn exclusions_follow_path_components_and_generated_file_names() {
    for excluded in [
        "fuzz/a.rs",
        "crate/target/a.rs",
        "crate/generated/a.rs",
        "src/generated.rs",
        "src/route.generated.rs",
        ".git/a.rs",
    ] {
        assert!(excluded_path(Path::new(excluded)), "{excluded}");
    }
    for included in [
        "src/fuzzy.rs",
        "targeted/a.rs",
        "src/generator.rs",
        "src/a.rs",
    ] {
        assert!(!excluded_path(Path::new(included)), "{included}");
    }
}

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct ScratchDirectory(PathBuf);

impl ScratchDirectory {
    fn new() -> Self {
        let unique = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "stella-source-lint-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn write(&self, path: &str, source: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }

    fn run(&self) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_stella_source_lint"))
            .arg(&self.0)
            .output()
            .unwrap()
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn a_source_mutation_changes_cli_success_to_a_line_diagnostic() {
    let directory = ScratchDirectory::new();
    let positive = include_str!("fixtures/main.rs").replace("Stella tooling", "stella tooling");
    directory.write("src/main.rs", &positive);
    assert!(directory.run().status.success());

    let mutation = positive.replace("stella tooling", "Stella tooling");
    assert_ne!(positive, mutation);
    directory.write("src/main.rs", &mutation);
    let output = directory.run();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("main.rs:2:20: stella_lowercase:"),
        "{stderr}"
    );
    assert!(stderr.contains("replace `Stella` with `stella`"));
}

#[test]
fn discovery_excludes_generated_and_fuzz_sources_but_checks_all_other_rust_files() {
    let directory = ScratchDirectory::new();
    let negative = "fn main() { let _ = \"Stella tooling\"; }";
    for path in [
        "fuzz/main.rs",
        "target/main.rs",
        "src/generated/main.rs",
        "src/generated.rs",
        "src/a.generated.rs",
    ] {
        directory.write(path, negative);
    }
    directory.write("src/main.rs", "fn main() { let _ = \"stella tooling\"; }");
    directory.write("src/notes.txt", negative);
    let mut files = Vec::new();
    collect_sources(&directory.0, &mut files).unwrap();
    assert_eq!(files, vec![directory.0.join("src/main.rs")]);
    assert!(directory.run().status.success());
    directory.write("src/main.rs", negative);
    assert_eq!(directory.run().status.code(), Some(1));
}

#[test]
fn cli_does_not_succeed_on_a_parse_error() {
    let directory = ScratchDirectory::new();
    directory.write("src/main.rs", "fn main( {");
    let output = directory.run();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("main.rs:1:")
    );
}

#[test]
fn documented_cargo_alias_runs_the_installed_subcommand_and_rejects_a_source_mutation() {
    let directory = ScratchDirectory::new();
    directory.write(
        ".cargo/config.toml",
        include_str!("../../../rust/cargo-config.toml"),
    );
    directory.write(
        "Cargo.toml",
        "[package]\nname = \"lint-consumer\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
    );
    let positive = include_str!("fixtures/main.rs").replace("Stella tooling", "stella tooling");
    directory.write("src/main.rs", &positive);

    let binary_directory = Path::new(env!("CARGO_BIN_EXE_cargo-stella-lint"))
        .parent()
        .unwrap();
    let mut paths = vec![binary_directory.to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let executable_path = std::env::join_paths(paths).unwrap();
    let run_alias = || {
        Command::new(env!("CARGO"))
            .arg("ci-stella-lint")
            .current_dir(&directory.0)
            .env("PATH", &executable_path)
            .output()
            .unwrap()
    };
    let output = run_alias();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mutation = positive.replace("stella tooling", "Stella tooling");
    assert_ne!(positive, mutation);
    directory.write("src/main.rs", &mutation);
    let output = run_alias();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("main.rs:2:20: stella_lowercase:"),
        "{stderr}"
    );
}

impl ScratchDirectory {
    fn run_configured(&self) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_stella_source_lint"))
            .arg("--config")
            .arg(self.0.join("stella-source-lint.json"))
            .arg(&self.0)
            .output()
            .unwrap()
    }

    fn configure(&self, paths: &[&str]) {
        self.write(
            "stella-source-lint.json",
            &serde_json::json!({ "fixturePaths": paths }).to_string(),
        );
    }
}

#[test]
fn configured_fixture_paths_do_not_exempt_unlisted_files_with_identical_content() {
    let source = include_str!("fixtures/main.rs");
    for fixture in ["tests/fixtures/listed.rs", "tests/fixtures/listed"] {
        let directory = ScratchDirectory::new();
        let listed = if fixture.ends_with(".rs") {
            fixture.to_string()
        } else {
            format!("{fixture}/main.rs")
        };
        directory.write(&listed, source);
        directory.write("tests/source_lint.rs", source);
        directory.configure(&[fixture, "tests/source_lint.rs"]);
        let positive = directory.run_configured();
        assert!(
            positive.status.success(),
            "{}",
            String::from_utf8_lossy(&positive.stderr)
        );
        assert_eq!(directory.run().status.code(), Some(1));

        directory.write("tests/fixtures/unlisted.rs", source);
        let mutation = directory.run_configured();
        assert_eq!(mutation.status.code(), Some(1));
        let stderr = String::from_utf8(mutation.stderr).unwrap();
        assert!(
            stderr.contains("unlisted.rs:2:20: stella_lowercase:"),
            "{stderr}"
        );
        assert!(!stderr.contains(&format!("{}:2:20:", directory.0.join(&listed).display())));
    }
}

#[test]
fn fixture_configuration_cannot_exclude_production_sources_or_all_tests() {
    let directory = ScratchDirectory::new();
    directory.write("src/main.rs", include_str!("fixtures/main.rs"));
    directory.write(
        "tests/fixtures/example.rs",
        include_str!("fixtures/main.rs"),
    );
    directory.write("tests/support/example.rs", include_str!("fixtures/main.rs"));
    for path in [
        "src/main.rs",
        "tests",
        ".",
        "tests/support",
        "tests/fixtures/../support/example.rs",
        "tests/fixtures/missing.rs",
        "tests/fixtures/*.rs",
    ] {
        directory.configure(&[path]);
        let output = directory.run_configured();
        assert_eq!(output.status.code(), Some(2), "{path}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("invalid fixture configuration:"));
    }
    directory.configure(&[directory
        .0
        .join("tests/fixtures/example.rs")
        .to_str()
        .unwrap()]);
    assert_eq!(directory.run_configured().status.code(), Some(2));
}

#[test]
fn fixture_configuration_is_closed_and_rejects_duplicate_paths() {
    let directory = ScratchDirectory::new();
    directory.write(
        "tests/fixtures/example.rs",
        include_str!("fixtures/main.rs"),
    );
    for source in [
        r#"{"fixturePaths":[],"exclude":["src"]}"#,
        r#"{"fixturePaths": [3]}"#,
        r#"{"fixturePaths": [], "fixturePaths": ["tests/fixtures/example.rs"]}"#,
        r#"{"fixturePaths": ["tests/fixtures/example.rs", "tests/fixtures/example.rs"]}"#,
    ] {
        directory.write("stella-source-lint.json", source);
        assert_eq!(
            directory.run_configured().status.code(),
            Some(2),
            "{source}"
        );
    }
}

#[cfg(unix)]
#[test]
fn fixture_configuration_rejects_symlink_files_and_directories() {
    let directory = ScratchDirectory::new();
    directory.write("src/main.rs", include_str!("fixtures/main.rs"));
    directory.write("tests/fixtures/keep.rs", "fn main() {}");
    std::os::unix::fs::symlink(
        directory.0.join("src/main.rs"),
        directory.0.join("tests/fixtures/linked.rs"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        directory.0.join("src"),
        directory.0.join("tests/fixtures/linked"),
    )
    .unwrap();
    for path in [
        "tests/fixtures/linked.rs",
        "tests/fixtures/linked",
        "tests/fixtures/linked/main.rs",
    ] {
        directory.configure(&[path]);
        let output = directory.run_configured();
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("must not follow symlinks"));
    }
}

#[test]
fn the_checker_lints_its_own_production_sources_with_only_its_declared_fixtures_exempted() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let output = Command::new(env!("CARGO_BIN_EXE_stella_source_lint"))
        .arg("--config")
        .arg(root.join("stella-source-lint.json"))
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
