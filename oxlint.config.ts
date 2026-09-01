import { library } from "./packages/oxlint-config/src/index";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
  routeQueryPluginSpecifiers,
  routeQueryRules,
} from "./packages/oxlint-plugin/src/index";

export default library({
  ignorePatterns: ["packages/oxlint-config/dist/"],
  jsPlugins: [...portableSafetyPluginSpecifiers, ...routeQueryPluginSpecifiers],
  overrides: [
    {
      // Oxlint presents plugin AST nodes as intentionally untyped values.
      // Type-aware any-flow and condition rules cannot add safety inside the
      // visitor implementation; the passive fixtures prove rule behavior.
      files: ["packages/oxlint-plugin/src/**/*.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/no-unnecessary-condition": "off",
      },
    },
    {
      files: ["packages/oxlint-plugin/fixtures/**/*.{ts,tsx}"],
      rules: { ...portableSafetyRules, ...routeQueryRules },
    },
  ],
});
