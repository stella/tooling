import { defineConfig, type OxlintConfig, type OxlintOverride } from "oxlint";

type Rules = NonNullable<OxlintConfig["rules"]>;
type JsPlugins = NonNullable<OxlintConfig["jsPlugins"]>;
type Options = NonNullable<OxlintConfig["options"]>;
type Plugins = NonNullable<OxlintConfig["plugins"]>;

export type LibraryOptions = {
  jsPlugins?: JsPlugins;
  ignorePatterns?: string[];
  options?: Options;
  overrides?: OxlintOverride[];
  plugins?: Plugins;
  rules?: Rules;
};

export const stellaLowercasePluginSpecifier = "@stll/oxlint-config/plugin";
export const noRawColorsPluginSpecifier = "@stll/oxlint-config/no-raw-colors";

export const libraryIgnorePatterns = ["node_modules/", "dist/", "coverage/"];

// Setting oxlint's `plugins` config replaces its built-in default list rather
// than appending to it. This must stay in sync with every plugin-prefixed
// rule below: `import/*` and `promise/*` rules are configured further down,
// but oxlint disables both plugins unless they are listed here, which left
// `import/no-cycle` and every `promise/*` rule silently unenforced. `react`
// is enabled for the React Compiler category rules; see the comment on that
// ruleset for why every other `react/*` rule is explicitly turned back off.
export const libraryPlugins = [
  "eslint",
  "typescript",
  "unicorn",
  "oxc",
  "import",
  "promise",
  "react",
] satisfies Plugins;

// Oxlint 1.80 replaced react/react-compiler with category-specific rules.
// Keep the actionable compiler diagnostics strict while excluding internal
// invariant and unfinished-feature reports that do not identify source bugs.
export const reactCompilerRules = {
  "react/capitalized-calls": "error",
  "react/error-boundaries": "error",
  "react/exhaustive-effect-dependencies": "error",
  "react/globals": "error",
  "react/hooks": "error",
  "react/immutability": "error",
  "react/incompatible-library": "error",
  "react/invariant": "off",
  "react/memo-dependencies": "error",
  "react/no-deriving-state-in-effects": "error",
  "react/preserve-manual-memoization": "error",
  "react/purity": "error",
  "react/refs": "error",
  "react/rule-suppression": "error",
  "react/set-state-in-effect": "error",
  "react/set-state-in-render": "error",
  "react/static-components": "error",
  "react/syntax": "error",
  "react/todo": "off",
  "react/unsupported-syntax": "error",
  "react/use-memo": "error",
  "react/void-use-memo": "error",
} satisfies Rules;

export const libraryRules = {
  "no-console": "off",
  "no-shadow": "error",
  "require-await": "error",
  "no-useless-catch": "error",
  "no-non-null-assertion": "error",
  "no-useless-assignment": "error",
  "no-loop-func": "error",
  "no-nested-ternary": "error",
  "no-void": ["error", { allowAsStatement: true }],
  // Callback expressions should stay lexically scoped; avoids accidental `this` rebinding.
  "prefer-arrow-callback": "error",
  "stella-lowercase/stella-lowercase": "error",
  "no-raw-colors/no-raw-colors": "error",

  // Spreading into an accumulator on every loop iteration is O(n^2); push/concat instead.
  "oxc/no-accumulating-spread": "error",
  // Spreading inside `.map()` allocates a new array per callback invocation; push instead.
  "oxc/no-map-spread": "error",
  // Flags `if`/`switch` branches with identical bodies: likely dead logic or a missed merge.
  "oxc/branches-sharing-code": "error",

  "typescript/no-explicit-any": "error",
  "typescript/no-dynamic-delete": "error",
  "typescript/no-misused-promises": [
    "error",
    { checksVoidReturn: { attributes: false } },
  ],
  "typescript/consistent-type-definitions": ["error", "type"],
  "typescript/consistent-return": "error",
  "typescript/dot-notation": "error",
  "typescript/no-inferrable-types": "off",
  "typescript/no-unnecessary-type-conversion": "error",
  "typescript/no-unnecessary-condition": [
    "error",
    { allowConstantLoopConditions: "only-allowed-literals" },
  ],
  "typescript/no-unnecessary-type-arguments": "error",
  "typescript/switch-exhaustiveness-check": [
    "error",
    { considerDefaultExhaustiveForUnions: true },
  ],
  "typescript/strict-boolean-expressions": [
    "error",
    { allowNullableString: true, allowNullableBoolean: true },
  ],
  "typescript/no-confusing-void-expression": [
    "error",
    { ignoreArrowShorthand: true, ignoreVoidReturningFunctions: true },
  ],
  "typescript/prefer-nullish-coalescing": [
    "error",
    { ignorePrimitives: { string: true, boolean: true } },
  ],
  "typescript/only-throw-error": "error",
  "typescript/return-await": ["error", "error-handling-correctness-only"],

  "unicorn/no-useless-undefined": "off",
  "unicorn/prefer-array-find": "error",
  "unicorn/prefer-at": "error",
  "unicorn/prefer-set-has": "error",
  "unicorn/filename-case": "off",
  "unicorn/consistent-function-scoping": "off",
  "unicorn/prefer-ternary": "off",
  "unicorn/no-array-reduce": "error",
  "unicorn/no-nested-ternary": "off",
  // `Array.from({ length }).fill(obj)` shares one reference across every slot.
  "unicorn/no-array-fill-with-reference-type": "error",

  "import/no-cycle": "error",
  "import/consistent-type-specifier-style": "off",
  // Keep a blank line after the import block so it stays visually separate from module body.
  "import/newline-after-import": "error",

  "promise/always-return": "error",
  "promise/no-return-in-finally": "error",
  "promise/prefer-await-to-then": "off",
  "promise/prefer-await-to-callbacks": "off",
  "promise/avoid-new": "off",

  // Enabling the `react` plugin (above) turns on its whole correctness-category
  // rule set at "warn" by default, not just the React Compiler categories.
  // Only the compiler categories are deliberate additions here, so the rest
  // are turned off to keep this package's blast radius scoped; lift any of
  // these independently if a future change wants them.
  "react/exhaustive-deps": "off",
  "react/forward-ref-uses-ref": "off",
  "react/jsx-key": "off",
  "react/jsx-no-duplicate-props": "off",
  "react/jsx-no-undef": "off",
  "react/jsx-props-no-spread-multi": "off",
  "react/no-children-prop": "off",
  "react/no-danger-with-children": "off",
  "react/no-did-mount-set-state": "off",
  "react/no-did-update-set-state": "off",
  "react/no-direct-mutation-state": "off",
  "react/no-find-dom-node": "off",
  "react/no-is-mounted": "off",
  "react/no-render-return-value": "off",
  "react/no-string-refs": "off",
  "react/no-this-in-sfc": "off",
  "react/no-unsafe": "off",
  "react/no-will-update-set-state": "off",
  "react/void-dom-elements-no-children": "off",
  ...reactCompilerRules,

  "sort-keys": "off",
  "no-plusplus": "off",
  "no-inline-comments": "off",
  "max-statements": "off",
  "prefer-destructuring": "off",
  "no-negated-condition": "off",
  "no-use-before-define": "off",
  "no-useless-return": "off",
  "no-warning-comments": "off",
  "no-unexpected-multiline": "off",
  "max-classes-per-file": "off",
  "class-methods-use-this": "off",
  "no-unmodified-loop-condition": "off",
  complexity: "off",
  "func-style": "off",
  "func-names": "off",
  "default-case": "off",
} satisfies Rules;

export const libraryOverrides = [
  {
    files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "__test__/**", "__tests__/**"],
    rules: {
      "no-console": "off",
      "require-await": "off",
      "no-non-null-assertion": "off",
    },
  },
] satisfies OxlintOverride[];

export const library = (options: LibraryOptions = {}): OxlintConfig =>
  defineConfig({
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      ...options.options,
    },
    plugins: Array.from(
      new Set([...libraryPlugins, ...(options.plugins ?? [])]),
    ),
    jsPlugins: [
      stellaLowercasePluginSpecifier,
      noRawColorsPluginSpecifier,
      ...(options.jsPlugins ?? []),
    ],
    ignorePatterns: [
      ...libraryIgnorePatterns,
      ...(options.ignorePatterns ?? []),
    ],
    rules: {
      ...libraryRules,
      ...options.rules,
    },
    overrides: [...libraryOverrides, ...(options.overrides ?? [])],
  });

export default library();
