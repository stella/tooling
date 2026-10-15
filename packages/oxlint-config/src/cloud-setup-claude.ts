import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

import { cloudSetupPath } from "./cloud-setup";
import { cloudShellProfilePath } from "./cloud-setup-shell";

export const cloudClaudeSettingsPath = ".claude/settings.json";
export const cloudSessionStartHook = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  bash ${cloudSetupPath} start || exit "$?"
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    if [ ! -f ${cloudShellProfilePath} ]; then
      printf '%s\\n' 'cloud-setup: cloud shell profile is unavailable; run install' >&2
      exit 1
    fi
    printf '\\n' >> "$CLAUDE_ENV_FILE" || exit "$?"
    cat ${cloudShellProfilePath} >> "$CLAUDE_ENV_FILE"
  fi
fi`,
    },
  ],
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const readSettings = (text: string | undefined) => {
  const settings: unknown =
    text === undefined
      ? {}
      : JSON.parse(text, (_key, value: unknown) => {
          if (
            typeof value === "number" &&
            (!Number.isFinite(value) ||
              (Number.isInteger(value) && !Number.isSafeInteger(value)))
          )
            throw new Error(
              "settings contains a number that cannot be safely preserved",
            );
          return value;
        });
  if (
    text !== undefined &&
    parseDocument(text, { uniqueKeys: true }).errors.length > 0
  )
    throw new Error("settings contains duplicate or ambiguous JSON keys");
  if (!record(settings)) throw new Error("settings must be a JSON object");
  if (settings["disableAllHooks"] === true)
    throw new Error("disableAllHooks prevents SessionStart from running");
  const hooks = settings["hooks"] === undefined ? {} : settings["hooks"];
  if (!record(hooks)) throw new Error("hooks must be a JSON object");
  const sessionStart =
    hooks["SessionStart"] === undefined ? [] : hooks["SessionStart"];
  if (
    !array(sessionStart) ||
    sessionStart.some((entry) => !record(entry) || !array(entry["hooks"]))
  )
    throw new Error("hooks.SessionStart must be an array of hook groups");
  return { settings, hooks, sessionStart };
};

const cloudHookGroups = (sessionStart: readonly unknown[]) =>
  sessionStart.filter(
    (entry) =>
      record(entry) &&
      array(entry["hooks"]) &&
      entry["hooks"].some(
        (hook) =>
          record(hook) &&
          typeof hook["command"] === "string" &&
          hook["command"].includes(cloudSetupPath),
      ),
  );

export const cloudSessionStartFix =
  `preserve unrelated settings in ${cloudClaudeSettingsPath}, repair its JSON/hooks structure and set disableAllHooks to false if needed, and ensure hooks.SessionStart contains exactly this cloud setup entry (replace conflicting cloud setup entries):\n` +
  JSON.stringify(cloudSessionStartHook, null, 2);

/** Append only when the existing settings have no conflicting cloud startup. */
export const mergeCloudSessionStartHook = (text: string | undefined) => {
  try {
    const { settings, hooks, sessionStart } = readSettings(text);
    const cloudGroups = cloudHookGroups(sessionStart);
    if (cloudGroups.length !== 0) {
      if (
        cloudGroups.length === 1 &&
        isDeepStrictEqual(cloudGroups.at(0), cloudSessionStartHook) &&
        text !== undefined
      )
        return text;
      throw new Error("existing cloud setup SessionStart hook differs");
    }
    return `${JSON.stringify(
      {
        ...settings,
        hooks: {
          ...hooks,
          SessionStart: [...sessionStart, cloudSessionStartHook],
        },
      },
      null,
      2,
    )}\n`;
  } catch (error) {
    throw new Error(
      `cannot safely merge ${cloudClaudeSettingsPath}: ${error instanceof Error ? error.message : String(error)}; ${cloudSessionStartFix}`,
    );
  }
};

/** Settings formatting and unrelated hooks do not affect the generated contract. */
export const hasCloudSessionStartHook = (text: string | undefined) => {
  if (text === undefined) return false;
  try {
    const { sessionStart } = readSettings(text);
    const cloudGroups = cloudHookGroups(sessionStart);
    return (
      cloudGroups.length === 1 &&
      isDeepStrictEqual(cloudGroups.at(0), cloudSessionStartHook)
    );
  } catch {
    return false;
  }
};
