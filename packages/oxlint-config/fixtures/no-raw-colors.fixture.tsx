// Passive regression fixture for `no-raw-colors/no-raw-colors`.
//
// Disabled lines are cases the rule must flag. If the rule regresses, the
// corresponding directive becomes unused and lint fails with
// report-unused-disable-directives enabled.

// Gray-scale neutrals must fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _grayBg = "bg-gray-100";
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _stoneText = "text-stone-900";
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _zincBorder = "border-zinc-200";

// Saturated palette must fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _emeraldBg = "bg-emerald-100";
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _amberText = "text-amber-800";
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _blueRing = "ring-blue-500";

// Opacity modifier on a palette class must still fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _emeraldOpacity = "bg-emerald-100/30";

// Nested arbitrary selectors must fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _nestedBlue = "[&_span]:bg-blue-500";

// Standalone white/black must fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _bareWhite = "bg-white";
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _bareBlack = "text-black";

// Multi-token strings must flag the offending token.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _mixedClasses = "flex items-center bg-rose-50 text-rose-900";

// Template literal quasi text (TemplateElement) must fire.
// oxlint-disable-next-line no-raw-colors/no-raw-colors
const _templatedQuasi = (size: string): string => `bg-blue-500 ${size}`;
// Embedded string literals inside a template expression must fire too.
const _templatedExpr = (active: boolean): string =>
  // oxlint-disable-next-line no-raw-colors/no-raw-colors
  `px-2 ${active ? "bg-blue-500" : "text-foreground"}`;

// Passes — semantic tokens with opacity (success/warning/destructive/etc.)
const _semanticSuccess = "bg-success/12 text-success";
const _semanticWarning = "bg-warning/12 text-warning";
const _semanticDestructive = "bg-destructive/12 text-destructive";
const _semanticMuted = "bg-muted text-foreground";

// Passes — opacity on white/black (bg-white/20) is allowed; only bare tokens fire.
const _whiteOpacity = "bg-white/20";
const _blackOpacity = "border-black/10";

// Passes — non-palette identifiers that happen to contain a hue word.
const _whitespaceLike = "bg-whitesmoke";

// Passes — unrelated utilities.
const _layout = "flex items-center justify-between gap-2 rounded-md";

export const __noRawColorsFixture = {
  _grayBg,
  _stoneText,
  _zincBorder,
  _emeraldBg,
  _amberText,
  _blueRing,
  _emeraldOpacity,
  _nestedBlue,
  _bareWhite,
  _bareBlack,
  _mixedClasses,
  _templatedQuasi,
  _templatedExpr,
  _semanticSuccess,
  _semanticWarning,
  _semanticDestructive,
  _semanticMuted,
  _whiteOpacity,
  _blackOpacity,
  _whitespaceLike,
  _layout,
};
