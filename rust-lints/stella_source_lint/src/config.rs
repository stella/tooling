use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Configuration {
    fixture_paths: Vec<String>,
}

enum FixturePath {
    File(PathBuf),
    Directory(PathBuf),
}

pub(crate) struct FixturePaths(Vec<FixturePath>);

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

impl FixturePaths {
    pub(crate) fn load(file: &Path) -> io::Result<Self> {
        if fs::symlink_metadata(file)?.is_symlink() {
            return Err(invalid("fixture configuration must not be a symlink"));
        }
        let configuration: Configuration = serde_json::from_str(&fs::read_to_string(file)?)
            .map_err(|error| invalid(error.to_string()))?;
        let root = fs::canonicalize(
            file.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        let mut seen = HashSet::new();
        let mut fixtures = Vec::new();
        for value in configuration.fixture_paths {
            let relative = Path::new(&value);
            if value.contains('\\')
                || value.split('/').any(|component| component.is_empty())
                || relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
                || !relative.starts_with("tests")
                || relative == Path::new("tests")
            {
                return Err(invalid(format!(
                    "fixture path must be a narrow relative path under tests: {value}"
                )));
            }
            let mut target = root.clone();
            for component in relative.components() {
                target.push(component);
                if fs::symlink_metadata(&target)?.is_symlink() {
                    return Err(invalid(format!(
                        "fixture paths must not follow symlinks: {value}"
                    )));
                }
            }
            let metadata = fs::metadata(&target)?;
            let canonical = fs::canonicalize(&target)?;
            if !canonical.starts_with(&root) || !seen.insert(canonical.clone()) {
                return Err(invalid(format!(
                    "fixture path escapes its root or is duplicated: {value}"
                )));
            }
            if metadata.is_dir() && relative.starts_with("tests/fixtures") {
                fixtures.push(FixturePath::Directory(canonical));
            } else if metadata.is_file()
                && relative
                    .extension()
                    .is_some_and(|extension| extension == "rs")
            {
                fixtures.push(FixturePath::File(canonical));
            } else {
                return Err(invalid(format!(
                    "fixture directories must be under tests/fixtures; exact test files must be Rust: {value}"
                )));
            }
        }
        Ok(Self(fixtures))
    }

    pub(crate) fn contains(&self, file: &Path) -> io::Result<bool> {
        let canonical = fs::canonicalize(file)?;
        Ok(self.0.iter().any(|fixture| match fixture {
            FixturePath::File(path) => canonical == *path,
            FixturePath::Directory(path) => canonical.starts_with(path),
        }))
    }
}
