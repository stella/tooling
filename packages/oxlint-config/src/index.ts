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
  react?: { files: [string, ...string[]] };
};

export const stellaLowercasePluginSpecifier = "@stll/oxlint-config/plugin";
export const noRawColorsPluginSpecifier = "@stll/oxlint-config/no-raw-colors";

export const libraryIgnorePatterns = ["node_modules/", "dist/", "coverage/"];

// Setting oxlint's `plugins` config replaces its built-in default list rather
// than appending to it. This must stay in sync with every plugin-prefixed
// rule below: `import/*` and `promise/*` rules are configured further down,
// but oxlint disables both plugins unless they are listed here, which left
// `import/no-cycle` and every `promise/*` rule silently unenforced.
export const libraryPlugins = [
  "eslint",
  "typescript",
  "unicorn",
  "oxc",
  "import",
  "promise",
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
  // `== null` stays allowed as the one idiomatic nullish check.
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": "error",
  // Bug-shaped constructs outside oxlint's default correctness category.
  // Switch fallthrough is left to `noFallthroughCasesInSwitch` in the shared
  // tsconfig; oxlint's rule misreads commented empty cases.
  "no-case-declarations": "error",
  "default-case-last": "error",
  "array-callback-return": "error",
  "no-self-compare": "error",
  "no-unneeded-ternary": "error",
  "no-useless-concat": "error",
  "no-useless-constructor": "error",
  // Rethrowing a new error must keep the original as `cause`.
  "preserve-caught-error": "error",
  // String-evaluated code and prototype tampering.
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-extend-native": "error",
  "no-proto": "error",
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
  // Rejections follow the same Error-only contract as `throw`.
  "typescript/prefer-promise-reject-errors": "error",
  "typescript/use-unknown-in-catch-callback-variable": "error",
  "typescript/return-await": ["error", "error-handling-correctness-only"],
  // Bare `@ts-ignore`/`@ts-nocheck` hide type errors; `@ts-expect-error`
  // needs a description and fails once the error it covers is gone.
  "typescript/ban-ts-comment": "error",
  "typescript/no-require-imports": "error",
  "typescript/no-empty-object-type": "error",
  "typescript/no-unsafe-function-type": "error",
  "typescript/no-unnecessary-type-constraint": "error",
  "typescript/no-confusing-non-null-assertion": "error",
  "typescript/no-deprecated": "error",
  "typescript/no-unnecessary-type-assertion": "error",
  "typescript/no-unnecessary-template-expression": "error",
  "typescript/no-unnecessary-boolean-literal-compare": "error",
  "typescript/restrict-plus-operands": "error",
  "typescript/no-unsafe-enum-comparison": "error",
  "typescript/no-mixed-enums": "error",
  "typescript/prefer-includes": "error",
  "typescript/prefer-string-starts-ends-with": "error",
  "typescript/prefer-find": "error",

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
  "unicorn/prefer-node-protocol": "error",
  "unicorn/prefer-array-flat-map": "error",
  // `instanceof Array`/`String` fails across realms and for primitives.
  "unicorn/no-instanceof-builtins": "error",
  "unicorn/no-accessor-recursion": "error",
  "unicorn/require-post-message-target-origin": "error",

  "oxc/misrefactored-assign-op": "error",

  "import/no-cycle": "error",
  "import/no-duplicates": "error",
  "import/no-self-import": "error",
  "import/no-absolute-path": "error",
  "import/no-empty-named-blocks": "error",
  "import/consistent-type-specifier-style": "off",
  // Keep a blank line after the import block so it stays visually separate from module body.
  "import/newline-after-import": "error",

  "promise/always-return": "error",
  "promise/no-return-in-finally": "error",
  "promise/no-multiple-resolved": "error",
  "promise/prefer-await-to-then": "off",
  "promise/prefer-await-to-callbacks": "off",
  "promise/avoid-new": "off",

  // None of these are on in `library()` itself (oxlint enables only the
  // correctness category). They stay listed because consumers spread
  // `libraryRules` over broader presets such as Ultracite, where these
  // opinionated rules are on and would otherwise apply.
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

// Applied only to the consumer-selected React files.
export const reactRules = {
  // Enabling the `react` plugin turns on its whole correctness category.
  // These two duplicate other checks: the compiler's dependency rules
  // replace `exhaustive-deps`, and TypeScript reports undefined JSX names.
  "react/exhaustive-deps": "off",
  "react/jsx-no-undef": "off",
  // The rest of the category reports real bugs (missing keys, duplicate
  // props, mutated state, removed React APIs), so it stays on as errors.
  "react/forward-ref-uses-ref": "error",
  "react/jsx-key": "error",
  "react/jsx-no-duplicate-props": "error",
  "react/jsx-props-no-spread-multi": "error",
  "react/no-children-prop": "error",
  "react/no-danger-with-children": "error",
  "react/no-did-mount-set-state": "error",
  "react/no-did-update-set-state": "error",
  "react/no-direct-mutation-state": "error",
  "react/no-find-dom-node": "error",
  "react/no-is-mounted": "error",
  "react/no-render-return-value": "error",
  "react/no-string-refs": "error",
  "react/no-this-in-sfc": "error",
  "react/no-unsafe": "error",
  "react/no-will-update-set-state": "error",
  "react/void-dom-elements-no-children": "error",
  ...reactCompilerRules,
} satisfies Rules;

export const libraryOverrides = [
  {
    // Override globs are anchored at the config directory, so test folders
    // need a leading `**/` to match inside packages.
    files: [
      "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "**/__test__/**",
      "**/__tests__/**",
    ],
    rules: {
      "no-console": "off",
      "require-await": "off",
      "no-non-null-assertion": "off",
    },
  },
] satisfies OxlintOverride[];

export const library = (options: LibraryOptions = {}): OxlintConfig => {
  const plugins = new Set([...libraryPlugins, ...(options.plugins ?? [])]);
  const presetOverrides = [
    ...libraryOverrides,
    ...(options.react === undefined
      ? []
      : [
          {
            files: options.react.files,
            plugins: [...plugins, "react"],
            rules: reactRules,
          } satisfies OxlintOverride,
        ]),
  ];
  return defineConfig({
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      ...options.options,
    },
    plugins: Array.from(plugins),
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
    overrides: [
      // Consumer rules take precedence over every preset, including scoped ones.
      ...presetOverrides.map((override) =>
        Object.assign({}, override, {
          rules: Object.assign({}, override.rules, options.rules),
        }),
      ),
      ...(options.overrides ?? []),
    ],
  });
};

export default library();
