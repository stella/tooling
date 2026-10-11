use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use proc_macro2::{Delimiter, TokenStream, TokenTree};
use syn::visit::{self, Visit};

#[derive(Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub line: usize,
    pub column: usize,
}

fn has_stella_word(value: &str) -> bool {
    value.match_indices("Stella").any(|(index, _)| {
        let before = value[..index].chars().next_back();
        let after = value[index + "Stella".len()..].chars().next();
        before.is_none_or(is_word_boundary) && after.is_none_or(is_word_boundary)
    })
}

fn is_word_boundary(value: char) -> bool {
    !value.is_alphanumeric() && value != '_'
}

#[derive(Default)]
struct StringVisitor {
    diagnostics: Vec<Diagnostic>,
}

impl StringVisitor {
    fn check_string(&mut self, literal: &syn::LitStr) {
        if has_stella_word(&literal.value()) {
            let start = literal.span().start();
            self.diagnostics.push(Diagnostic {
                line: start.line,
                column: start.column + 1,
            });
        }
    }

    fn visit_tokens(&mut self, tokens: TokenStream) {
        let mut tokens = tokens.into_iter().peekable();
        while let Some(token) = tokens.next() {
            // Attributes, including desugared doc comments, are not literal expressions.
            if matches!(&token, TokenTree::Punct(punct) if punct.as_char() == '#') {
                if matches!(tokens.peek(), Some(TokenTree::Punct(punct)) if punct.as_char() == '!')
                {
                    tokens.next();
                }
                if matches!(tokens.peek(), Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Bracket)
                {
                    tokens.next();
                    continue;
                }
            }
            match token {
                TokenTree::Group(group) => self.visit_tokens(group.stream()),
                TokenTree::Literal(literal) => {
                    if let Ok(syn::Lit::Str(value)) =
                        syn::parse2(TokenStream::from(TokenTree::Literal(literal)))
                    {
                        self.check_string(&value);
                    }
                }
                _ => {}
            }
        }
    }
}

impl<'ast> Visit<'ast> for StringVisitor {
    fn visit_attribute(&mut self, _attribute: &'ast syn::Attribute) {}

    fn visit_lit_str(&mut self, literal: &'ast syn::LitStr) {
        self.check_string(literal);
    }

    fn visit_macro(&mut self, value: &'ast syn::Macro) {
        self.visit_tokens(value.tokens.clone());
        visit::visit_path(self, &value.path);
    }
}

pub fn lint_source(source: &str) -> Result<Vec<Diagnostic>, syn::Error> {
    let file = syn::parse_file(source)?;
    let mut visitor = StringVisitor::default();
    visitor.visit_file(&file);
    visitor
        .diagnostics
        .sort_by_key(|diagnostic| (diagnostic.line, diagnostic.column));
    visitor.diagnostics.dedup();
    Ok(visitor.diagnostics)
}

pub fn excluded_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name) if name == "fuzz" || name == "target" || name == "generated" || name == ".git")
    }) || path.file_name().is_some_and(|name| {
        name == "generated.rs" || name.to_string_lossy().ends_with(".generated.rs")
    })
}

pub fn collect_sources(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if excluded_path(path) {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            collect_sources(&entry?.path(), files)?;
        }
    } else if path.extension().is_some_and(|extension| extension == "rs") {
        files.push(path.to_path_buf());
    }
    Ok(())
}
