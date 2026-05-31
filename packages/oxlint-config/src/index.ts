import { defineConfig, type OxlintConfig, type OxlintOverride } from "oxlint";

type Rules = NonNullable<OxlintConfig["rules"]>;
type JsPlugins = NonNullable<OxlintConfig["jsPlugins"]>;
type Options = NonNullable<OxlintConfig["options"]>;

export type LibraryOptions = {
  jsPlugins?: JsPlugins;
  ignorePatterns?: string[];
  options?: Options;
  overrides?: OxlintOverride[];
  rules?: Rules;
};

export const stellaLowercasePluginSpecifier = "@stll/oxlint-config/plugin";

export const libraryIgnorePatterns = ["node_modules/", "dist/", "coverage/"];

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
  "stella-lowercase/stella-lowercase": "error",

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

  "import/no-cycle": "error",
  "import/consistent-type-specifier-style": "off",

  "promise/always-return": "error",
  "promise/no-return-in-finally": "error",
  "promise/prefer-await-to-then": "off",
  "promise/prefer-await-to-callbacks": "off",
  "promise/avoid-new": "off",

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
    jsPlugins: [stellaLowercasePluginSpecifier, ...(options.jsPlugins ?? [])],
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
