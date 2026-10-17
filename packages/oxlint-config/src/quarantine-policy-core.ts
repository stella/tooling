import { parseJsonc } from "./jsonc";

export const REQUIRED_RELEASE_AGE_SECONDS = 5 * 24 * 60 * 60;
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const EXACT_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HOUR_MS = 60 * 60 * 1000;
const EXACT_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const REGISTRY_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

type ParseToml = (text: string) => unknown;
type FirstPartyPackages = ReadonlySet<string> | readonly string[];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => {
  throw new Error(message);
};
const ownPackage = (name: string) => name.startsWith("@stll/");
const exactPackage = (name: string) =>
  name.length <= 214 && EXACT_PACKAGE.test(name);
export const isFirstPartyPackageName = (name: string): boolean =>
  exactPackage(name) && ownPackage(name);

export const exactTimestamp = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return (
    EXACT_UTC_TIMESTAMP.test(value) &&
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
};

export const readParsedExcludes = (
  bunfig: string,
  parseToml: ParseToml,
): string[] => {
  const parsed = parseToml(bunfig);
  if (!isRecord(parsed) || !isRecord(parsed["install"]))
    return fail("bunfig.toml must contain an [install] table");
  const install = parsed["install"];
  if (
    ("registry" in install && install["registry"] !== NPM_REGISTRY) ||
    ("scopes" in install &&
      (!isRecord(install["scopes"]) ||
        Object.keys(install["scopes"]).length > 0))
  )
    fail("bunfig.toml quarantine policy requires the canonical npm registry");
  if (install["minimumReleaseAge"] !== REQUIRED_RELEASE_AGE_SECONDS)
    fail(
      `bunfig.toml must set minimumReleaseAge = ${REQUIRED_RELEASE_AGE_SECONDS}`,
    );
  if (!Array.isArray(install["minimumReleaseAgeExcludes"]))
    return fail(
      "bunfig.toml must declare minimumReleaseAgeExcludes as an array",
    );
  const names: string[] = [];
  for (const value of install["minimumReleaseAgeExcludes"]) {
    if (typeof value !== "string" || !exactPackage(value))
      return fail(
        "bunfig.toml minimumReleaseAgeExcludes must contain only exact npm package names",
      );
    names.push(value);
  }
  if (new Set(names).size !== names.length)
    fail("bunfig.toml minimumReleaseAgeExcludes must not contain duplicates");
  return names;
};

type Token = {
  type: "string" | "atom" | "punctuation" | "comment" | "newline";
  start: number;
  end: number;
  text: string;
};
// Tokenize before locating declarations: text in comments, multiline strings and
// unrelated tables cannot masquerade as the install policy's source array.
const tokensOf = (text: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    const character = text.charAt(index++);
    if (character === "\n") {
      tokens.push({ type: "newline", start, end: index, text: character });
      continue;
    }
    if (/\s/u.test(character)) continue;
    let type: Token["type"];
    if (character === "#") {
      type = "comment";
      while (index < text.length && text.charAt(index) !== "\n") index++;
    } else if (character === '"' || character === "'") {
      type = "string";
      const triple = text.slice(start, start + 3) === character.repeat(3);
      if (triple) index = start + 3;
      while (index < text.length) {
        const current = text.charAt(index++);
        if (character === '"' && current === "\\") {
          index++;
          continue;
        }
        if (current !== character) continue;
        if (!triple) break;
        if (text.slice(index - 1, index + 2) !== character.repeat(3)) continue;
        index += 2;
        while (text.charAt(index) === character) index++;
        break;
      }
    } else if ("[]=.,{}".includes(character)) type = "punctuation";
    else {
      type = "atom";
      while (
        index < text.length &&
        !/[\s#[\]=.,{}"']/u.test(text.charAt(index))
      )
        index++;
    }
    tokens.push({
      type,
      start,
      end: index,
      text:
        type === "comment"
          ? text.slice(start, index).replace(/\r$/u, "")
          : text.slice(start, index),
    });
  }
  return tokens;
};

const stringValue = (token: Token, parseToml: ParseToml): string => {
  const parsed = parseToml(`value = ${token.text}`);
  if (!isRecord(parsed) || typeof parsed["value"] !== "string")
    return fail("bunfig.toml has an unsupported quarantine string");
  return parsed["value"];
};
const keyParts = (tokens: readonly Token[], parseToml: ParseToml): string[] =>
  tokens
    .filter(({ text }) => text !== ".")
    .map((token) =>
      token.type === "string" ? stringValue(token, parseToml) : token.text,
    );

type Entry = {
  name: string;
  token: Token;
  comment: Token | undefined;
  comma: Token | undefined;
};
type SourceArray = {
  open: Token;
  close: Token;
  entries: Entry[];
  comments: Token[];
};
const readSourceArray = (bunfig: string, parseToml: ParseToml): SourceArray => {
  const names = readParsedExcludes(bunfig, parseToml);
  let table: string[] = [];
  let statement: Token[] = [];
  let depth = 0;
  let found: SourceArray | undefined;
  const visitStatement = () => {
    const meaningful = statement.filter(
      ({ type }) => type !== "comment" && type !== "newline",
    );
    const first = meaningful.at(0);
    if (first?.text === "[") {
      const end = meaningful.at(-1);
      if (end?.text === "]")
        table = keyParts(meaningful.slice(1, -1), parseToml);
      return;
    }
    const equals = meaningful.findIndex(({ text }) => text === "=");
    if (equals < 0) return;
    const key = [...table, ...keyParts(meaningful.slice(0, equals), parseToml)];
    if (
      key.join(".") !== "install.minimumReleaseAgeExcludes" ||
      key.length !== 2
    )
      return;
    const open = meaningful.at(equals + 1);
    const close = meaningful.at(-1);
    if (
      open === undefined ||
      close === undefined ||
      open.text !== "[" ||
      close.text !== "]" ||
      found !== undefined
    )
      fail(
        "bunfig.toml must declare a single install minimumReleaseAgeExcludes array",
      );
    const values = meaningful.slice(equals + 2, -1);
    if (values.some(({ type, text }) => type !== "string" && text !== ","))
      fail("bunfig.toml quarantine array must contain package strings");
    const strings = values.filter(({ type }) => type === "string");
    const comments = statement.filter(({ type }) => type === "comment");
    const entries = strings.map((token, index) => {
      const next = strings.at(index + 1)?.start ?? Number.POSITIVE_INFINITY;
      const comment = comments.find(
        (candidate) =>
          candidate.start >= token.end &&
          candidate.start < next &&
          !bunfig.slice(token.end, candidate.start).includes("\n"),
      );
      const following = values.find(
        (candidate) => candidate.start >= token.end,
      );
      return {
        name: stringValue(token, parseToml),
        token,
        comment,
        comma: following?.text === "," ? following : undefined,
      };
    });
    if (
      entries.length !== names.length ||
      entries.some(({ name }, index) => name !== names.at(index))
    )
      fail(
        "bunfig.toml quarantine source does not match its parsed install array",
      );
    found = { open, close, entries, comments };
  };
  for (const token of tokensOf(bunfig)) {
    if (token.type === "newline" && depth === 0) {
      visitStatement();
      statement = [];
      continue;
    }
    statement.push(token);
    if (token.type !== "punctuation") continue;
    if (token.text === "[" || token.text === "{") depth++;
    if (token.text === "]" || token.text === "}") depth--;
  }
  visitStatement();
  if (found === undefined)
    return fail(
      "bunfig.toml must declare an explicit [install] minimumReleaseAgeExcludes array",
    );
  return found;
};

type Annotation =
  | { type: "none" }
  | { type: "invalid" }
  | { type: "expires" | "excluded-since"; timestamp: string };
const annotationOf = ({ comment }: Entry): Annotation => {
  if (comment === undefined) return { type: "none" };
  const match = /^#\s*quarantine-(expires|excluded-since):\s*(\S+)\s*$/u.exec(
    comment.text,
  );
  const marker = match?.at(1);
  const timestamp = match?.at(2);
  if (
    (marker === "expires" || marker === "excluded-since") &&
    timestamp !== undefined
  )
    return { type: marker, timestamp };
  return { type: "invalid" };
};

export const readRegistryFirstPartyPackages = (
  lockfile: string | undefined,
): Set<string> => {
  if (lockfile === undefined) return new Set();
  const parsed = parseJsonc(lockfile);
  if (!isRecord(parsed) || !isRecord(parsed["packages"]))
    return fail("bun.lock must contain a packages mapping");
  const names = new Set<string>();
  for (const value of Object.values(parsed["packages"])) {
    if (!Array.isArray(value)) continue;
    const identity: unknown = value.at(0);
    if (typeof identity !== "string") continue;
    const separator = identity.lastIndexOf("@");
    const name = identity.slice(0, separator);
    if (
      exactPackage(name) &&
      ownPackage(name) &&
      REGISTRY_VERSION.test(identity.slice(separator + 1))
    )
      names.add(name);
  }
  return names;
};

const ownNames = (names: FirstPartyPackages): Set<string> => {
  const result = new Set(names);
  for (const name of result)
    if (!exactPackage(name) || !ownPackage(name))
      fail(`Expected an exact first-party npm package name: ${name}`);
  return result;
};
const validNow = (now: Date): number => {
  if (!Number.isFinite(now.getTime()))
    return fail("Quarantine policy requires a valid current date");
  return now.getTime();
};
export type CheckResult = { errors: string[]; warnings: string[] };
type CheckOptions = {
  bunfig: string;
  lockfile: string | undefined;
  parseToml: ParseToml;
  npmrcPresent?: boolean;
  now?: Date;
  firstPartyPackages?: FirstPartyPackages;
};
export const checkQuarantinePolicy = ({
  bunfig,
  lockfile,
  parseToml,
  npmrcPresent = false,
  now = new Date(),
  firstPartyPackages,
}: CheckOptions): CheckResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const nowMs = validNow(now);
    const { entries } = readSourceArray(bunfig, parseToml);
    if (npmrcPresent)
      errors.push(
        "bunfig.toml quarantine policy does not allow a repository .npmrc",
      );
    for (const entry of entries) {
      const annotation = annotationOf(entry);
      if (ownPackage(entry.name) && annotation.type === "none") continue;
      if (annotation.type === "none" || annotation.type === "invalid") {
        errors.push(
          `bunfig.toml has an unannotated or malformed quarantine exclude: ${entry.name}`,
        );
        continue;
      }
      if (!exactTimestamp(annotation.timestamp)) {
        errors.push(
          `bunfig.toml quarantine exclude "${entry.name}" has an invalid UTC timestamp: ${annotation.timestamp}`,
        );
        continue;
      }
      const timestampMs = Date.parse(annotation.timestamp);
      if (ownPackage(entry.name)) {
        if (annotation.type !== "excluded-since")
          errors.push(
            `bunfig.toml first-party quarantine exclude "${entry.name}" must be permanent (quarantine-excluded-since: or no timestamp)`,
          );
        else if (timestampMs > nowMs)
          errors.push(
            `bunfig.toml first-party quarantine exclude "${entry.name}" has a future exclusion date`,
          );
        continue;
      }
      if (annotation.type !== "expires") {
        errors.push(
          `bunfig.toml third-party quarantine exclude "${entry.name}" must use quarantine-expires:`,
        );
        continue;
      }
      if (nowMs >= timestampMs + 24 * HOUR_MS)
        errors.push(
          `bunfig.toml temporary quarantine exclude "${entry.name}" expired at ${annotation.timestamp} and is still present`,
        );
      else if (nowMs >= timestampMs)
        warnings.push(
          `bunfig.toml temporary quarantine exclude "${entry.name}" expired at ${annotation.timestamp}; its removal PR should be merged`,
        );
      else if (nowMs >= timestampMs - 48 * HOUR_MS)
        warnings.push(
          `bunfig.toml temporary quarantine exclude "${entry.name}" expires at ${annotation.timestamp}; prepare its removal PR`,
        );
    }
    const required = readRegistryFirstPartyPackages(lockfile);
    if (firstPartyPackages !== undefined) {
      for (const name of ownNames(firstPartyPackages)) required.add(name);
    }
    const declared = new Set(entries.map(({ name }) => name));
    const missing = [...required].filter((name) => !declared.has(name)).sort();
    if (missing.length > 0)
      errors.push(
        `bunfig.toml is missing registry-backed first-party quarantine excludes: ${missing.join(", ")}`,
      );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { errors, warnings };
};

type PruneOptions = { bunfig: string; parseToml: ParseToml; now?: Date };
export const pruneExpiredExcludes = ({
  bunfig,
  parseToml,
  now = new Date(),
}: PruneOptions): { bunfig: string; pruned: string[] } => {
  const nowMs = validNow(now);
  const { entries, close } = readSourceArray(bunfig, parseToml);
  const removals: { start: number; end: number }[] = [];
  const pruned: string[] = [];
  for (const entry of entries) {
    if (ownPackage(entry.name)) continue;
    const annotation = annotationOf(entry);
    if (annotation.type !== "expires" || !exactTimestamp(annotation.timestamp))
      return fail(
        `bunfig.toml third-party quarantine exclude "${entry.name}" must have an exact UTC quarantine-expires: annotation`,
      );
    if (nowMs < Date.parse(annotation.timestamp)) continue;
    const lineStart = bunfig.lastIndexOf("\n", entry.token.start - 1) + 1;
    const nextNewline = bunfig.indexOf("\n", entry.token.end);
    const lineEnd = nextNewline < 0 ? bunfig.length : nextNewline;
    const commentInside =
      entry.comment !== undefined && entry.comment.start < close.start;
    const end = commentInside
      ? (entry.comment?.end ?? entry.token.end)
      : (entry.comma?.end ?? entry.token.end);
    if (
      bunfig.slice(lineStart, entry.token.start).trim() === "" &&
      bunfig.slice(end, lineEnd).trim() === ""
    )
      removals.push({
        start: lineStart,
        end: nextNewline < 0 ? lineEnd : lineEnd + 1,
      });
    else removals.push({ start: entry.token.start, end });
    if (entry.comment !== undefined && !commentInside)
      removals.push({ start: entry.comment.start, end: entry.comment.end });
    pruned.push(entry.name);
  }
  let result = bunfig;
  for (const removal of removals.toReversed())
    result = result.slice(0, removal.start) + result.slice(removal.end);
  // Never return edited TOML without confirming the resulting source is valid.
  readSourceArray(result, parseToml);
  return { bunfig: result, pruned };
};

type SynchronizeOptions = {
  bunfig: string;
  firstPartyPackages: FirstPartyPackages;
  parseToml: ParseToml;
  now?: Date;
};
export const synchronizeFirstPartyExcludes = ({
  bunfig,
  firstPartyPackages,
  parseToml,
  now = new Date(),
}: SynchronizeOptions): string => {
  validNow(now);
  const required = ownNames(firstPartyPackages);
  const { open, close, entries, comments } = readSourceArray(bunfig, parseToml);
  const attachedComments = new Set(
    entries.flatMap(({ comment }) => (comment === undefined ? [] : [comment])),
  );
  const lines = comments
    .filter((comment) => !attachedComments.has(comment))
    .map(({ text }) => `  ${text}`);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!ownPackage(entry.name)) {
      const annotation = annotationOf(entry);
      if (
        annotation.type !== "expires" ||
        !exactTimestamp(annotation.timestamp)
      )
        return fail(
          `bunfig.toml third-party quarantine exclude "${entry.name}" must have an exact UTC quarantine-expires: annotation`,
        );
      lines.push(
        `  ${entry.token.text},${entry.comment === undefined ? "" : ` ${entry.comment.text}`}`,
      );
      continue;
    }
    if (!required.has(entry.name)) continue;
    seen.add(entry.name);
    const annotation = annotationOf(entry);
    const timestamp =
      annotation.type === "excluded-since" &&
      exactTimestamp(annotation.timestamp)
        ? annotation.timestamp
        : now.toISOString();
    lines.push(
      `  ${JSON.stringify(entry.name)}, # quarantine-excluded-since: ${timestamp}`,
    );
  }
  for (const name of [...required]
    .filter((requiredPackage) => !seen.has(requiredPackage))
    .sort())
    lines.push(
      `  ${JSON.stringify(name)}, # quarantine-excluded-since: ${now.toISOString()}`,
    );
  const newline = bunfig.includes("\r\n") ? "\r\n" : "\n";
  const trailingComment = entries.at(-1)?.comment;
  const end =
    trailingComment !== undefined && trailingComment.start > close.end
      ? trailingComment.end
      : close.end;
  const result =
    bunfig.slice(0, open.start) +
    `[${newline}${lines.join(newline)}${lines.length === 0 ? "" : newline}]` +
    bunfig.slice(end);
  readSourceArray(result, parseToml);
  return result;
};
