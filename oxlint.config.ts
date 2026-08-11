import { library } from "./packages/oxlint-config/src/index";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "./packages/oxlint-plugin/src/index";

export default library({
  ignorePatterns: ["packages/oxlint-config/dist/"],
  jsPlugins: [...portableSafetyPluginSpecifiers],
  overrides: [
    {
      files: ["packages/oxlint-plugin/fixtures/**/*.{ts,tsx}"],
      rules: portableSafetyRules,
    },
  ],
});
