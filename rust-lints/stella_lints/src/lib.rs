#![feature(rustc_private)]
#![warn(unused_extern_crates)]

extern crate rustc_ast;
extern crate rustc_hir;

use clippy_utils::diagnostics::span_lint_and_help;
use rustc_ast::LitKind;
use rustc_hir::{Expr, ExprKind};
use rustc_lint::{LateContext, LateLintPass};

dylint_linting::declare_late_lint! {
    /// ### What It Does
    ///
    /// Checks string literals for `Stella`.
    ///
    /// ### Why Restrict This?
    ///
    /// stella is written lowercase in public docs, diagnostics, and logs.
    ///
    /// ### Example
    ///
    /// ```rust
    /// let product = "Stella tooling";
    /// ```
    ///
    /// Use instead:
    ///
    /// ```rust
    /// let product = "stella tooling";
    /// ```
    pub STELLA_LOWERCASE,
    Warn,
    "stella should be written lowercase"
}

impl<'tcx> LateLintPass<'tcx> for StellaLowercase {
    fn check_expr(&mut self, cx: &LateContext<'tcx>, expr: &'tcx Expr<'_>) {
        let ExprKind::Lit(lit) = expr.kind else {
            return;
        };
        let LitKind::Str(value, _) = lit.node else {
            return;
        };
        if !has_stella_word(value.as_str()) {
            return;
        }

        span_lint_and_help(
            cx,
            STELLA_LOWERCASE,
            lit.span,
            "stella should be written lowercase",
            None,
            "replace `Stella` with `stella`",
        );
    }
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

#[test]
fn ui() {
    dylint_testing::ui_test(env!("CARGO_PKG_NAME"), "ui");
}
