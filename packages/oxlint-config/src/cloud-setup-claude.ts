import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

import { cloudSetupPath } from "./cloud-setup";
import { cloudShellProfilePath } from "./cloud-setup-shell";

export const cloudClaudeSettingsPath = ".claude/settings.json";
const releasedSessionStartHook = (script: string) =>
  ({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  ${script} start || exit "$?"
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
  }) as const;
// SessionStart cannot block a session; successful stdout supplies model context.
const sessionStartHook = (script: string) =>
  ({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  cloud_setup_incomplete() {
    printf '%s\\n' 'Cloud setup could not establish a verified session environment. From the repository root, run bash .agents/cloud-setup.sh install and then bash .agents/cloud-setup.sh start. Do not assume pinned tools or services are ready until start succeeds.'
    printf '%s\\n' "cloud-setup: $1" >&2
    exit 0
  }
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    cloud_session_exports="$(${script} session)" || cloud_setup_incomplete 'startup failed; run install'
  else
    ${script} start >&2 || cloud_setup_incomplete 'startup failed; run install'
    exit 0
  fi
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    if [ ! -s ${cloudShellProfilePath} ]; then
      cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    fi
    cloud_shell_exports="$(cat ${cloudShellProfilePath})" || cloud_setup_incomplete 'cloud shell profile could not be read; run install'
    [ -n "$cloud_shell_exports" ] || cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    if [ -e "$CLAUDE_ENV_FILE" ] || [ -L "$CLAUDE_ENV_FILE" ]; then
      [ -f "$CLAUDE_ENV_FILE" ] && [ ! -L "$CLAUDE_ENV_FILE" ] || cloud_setup_incomplete 'session environment must be a regular file; check its path and rerun start'
    fi
    cloud_env_temporary="$(umask 077; mktemp "\${CLAUDE_ENV_FILE}.XXXXXX")" || cloud_setup_incomplete 'session environment could not be prepared; check its write access and rerun start'
    if [ -e "$CLAUDE_ENV_FILE" ] || [ -L "$CLAUDE_ENV_FILE" ]; then
      cat "$CLAUDE_ENV_FILE" > "$cloud_env_temporary" || { rm -f -- "$cloud_env_temporary"; cloud_setup_incomplete 'session environment could not be read; check its access and rerun start'; }
    fi
    if [ -n "$cloud_session_exports" ]; then
      cloud_session_exports="$cloud_session_exports
$cloud_shell_exports"
    else
      cloud_session_exports="$cloud_shell_exports"
    fi
    printf '\\n%s\\n' "$cloud_session_exports" >> "$cloud_env_temporary" || { rm -f -- "$cloud_env_temporary"; cloud_setup_incomplete 'session environment could not be prepared; check its write access and rerun start'; }
    mv -f -- "$cloud_env_temporary" "$CLAUDE_ENV_FILE" || { rm -f -- "$cloud_env_temporary"; cloud_setup_incomplete 'session environment could not be persisted; check its write access and rerun start'; }
  fi
fi`,
      },
    ],
  }) as const;
// This exact form was persisted by the previous main-branch generator at 783bc97.
// Keep it only so consumers of that release can regenerate to the current hook.
const currentMainSessionStartHook = (script: string) =>
  ({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `if [ "\${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  cloud_setup_incomplete() {
    printf '%s\\n' 'Cloud setup could not establish a verified session environment. From the repository root, run bash .agents/cloud-setup.sh install and then bash .agents/cloud-setup.sh start. Do not assume pinned tools or services are ready until start succeeds.'
    printf '%s\\n' "cloud-setup: $1" >&2
    exit 0
  }
  ${script} start >&2 || cloud_setup_incomplete 'startup failed; run install'
  if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
    if [ ! -s ${cloudShellProfilePath} ]; then
      cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    fi
    cloud_shell_exports="$(cat ${cloudShellProfilePath})" || cloud_setup_incomplete 'cloud shell profile could not be read; run install'
    [ -n "$cloud_shell_exports" ] || cloud_setup_incomplete 'cloud shell profile is unavailable; run install'
    printf '\\n%s\\n' "$cloud_shell_exports" >> "$CLAUDE_ENV_FILE" || cloud_setup_incomplete 'session environment could not be persisted; check its write access and rerun start'
  fi
fi`,
      },
    ],
  }) as const;
// Hooks run in the session's working directory; resolve the script from the project root.
export const cloudSessionStartHook = sessionStartHook(
  `bash "$CLAUDE_PROJECT_DIR/${cloudSetupPath}"`,
);
// Releases 1.1.0 and 1.3.1 persisted these exact forms in consumer settings.
// Remove after supported consumers regenerate with a release containing this hook.
const previousCloudSessionStartHooks = [
  releasedSessionStartHook(`bash ${cloudSetupPath}`),
  releasedSessionStartHook(`bash "$CLAUDE_PROJECT_DIR/${cloudSetupPath}"`),
  currentMainSessionStartHook(`bash "$CLAUDE_PROJECT_DIR/${cloudSetupPath}"`),
];
export const cloudAttribution = { commit: "", pr: "" } as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const parseSettings = (text: string) => {
  try {
    const settings: unknown = JSON.parse(text, (_key, value: unknown) => {
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
    return settings;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("settings must contain valid JSON");
    throw error;
  }
};

const readSettings = (text: string | undefined) => {
  const settings = text === undefined ? {} : parseSettings(text);
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
export const cloudAttributionFix =
  `preserve unrelated settings in ${cloudClaudeSettingsPath} and set its top-level attribution to exactly:\n` +
  JSON.stringify({ attribution: cloudAttribution }, null, 2);

const sessionStartState = (sessionStart: readonly unknown[]) => {
  const groups = cloudHookGroups(sessionStart);
  const group = groups.at(0);
  if (group === undefined) return { type: "missing" } as const;
  if (groups.length === 1 && isDeepStrictEqual(group, cloudSessionStartHook))
    return { type: "current" } as const;
  if (
    groups.length === 1 &&
    previousCloudSessionStartHooks.some((hook) =>
      isDeepStrictEqual(group, hook),
    )
  )
    return { type: "previous", group } as const;
  return { type: "conflict" } as const;
};

const attributionState = (settings: Record<string, unknown>) => {
  const attribution = settings["attribution"];
  if (attribution === undefined) return "missing";
  return isDeepStrictEqual(attribution, cloudAttribution)
    ? "current"
    : "conflict";
};

const mergeError = (reason: string, fix: string) =>
  new Error(
    `cannot safely merge ${cloudClaudeSettingsPath}: ${reason}; ${fix}`,
  );

const readMergeableSettings = (text: string | undefined) => {
  try {
    return readSettings(text);
  } catch (error) {
    throw mergeError(
      error instanceof Error ? error.message : String(error),
      cloudSessionStartFix,
    );
  }
};

/** Add the cloud hook and attribution; never overwrite conflicting values. */
export const mergeCloudClaudeSettings = (text: string | undefined) => {
  const { settings, hooks, sessionStart } = readMergeableSettings(text);
  const hook = sessionStartState(sessionStart);
  if (hook.type === "conflict")
    throw mergeError(
      "existing cloud setup SessionStart hook differs",
      cloudSessionStartFix,
    );
  const attribution = attributionState(settings);
  if (attribution === "conflict")
    throw mergeError("existing attribution differs", cloudAttributionFix);
  if (
    hook.type === "current" &&
    attribution === "current" &&
    text !== undefined
  )
    return text;
  const mergedSessionStart = (() => {
    switch (hook.type) {
      case "current":
        return sessionStart;
      case "missing":
        return [...sessionStart, cloudSessionStartHook];
      case "previous":
        return sessionStart.map((entry) =>
          entry === hook.group ? cloudSessionStartHook : entry,
        );
      default: {
        const exhaustive: never = hook;
        throw new Error(`Unsupported hook state: ${String(exhaustive)}`);
      }
    }
  })();
  return `${JSON.stringify(
    {
      ...settings,
      attribution: cloudAttribution,
      hooks: { ...hooks, SessionStart: mergedSessionStart },
    },
    null,
    2,
  )}\n`;
};

/** Settings formatting and unrelated hooks do not affect the generated contract. */
export const hasCloudSessionStartHook = (text: string | undefined) => {
  if (text === undefined) return false;
  try {
    return (
      sessionStartState(readSettings(text).sessionStart).type === "current"
    );
  } catch {
    return false;
  }
};

export const hasCloudAttribution = (text: string | undefined) => {
  if (text === undefined) return false;
  try {
    return attributionState(readSettings(text).settings) === "current";
  } catch {
    return false;
  }
};
