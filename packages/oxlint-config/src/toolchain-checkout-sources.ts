import path from "node:path";

import {
  checkoutActionRef,
  literalSparseCheckoutPath,
  normalizeCheckoutPath,
} from "./toolchain-checkout-syntax";

export type CheckoutSource = {
  path: string;
  job: string;
  checkout: string;
  consumer: string;
  destination: string;
  ref: string | null;
  condition: string | null;
  selector: string;
  reason: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value);
const repositoryPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  !/[\\:$*?\s]/.test(value) &&
  !value.startsWith("/") &&
  !value.split("/").includes("..");

/** A declaration binds one consumer to one reviewed checkout, never an entire rule. */
export const parseCheckoutSources = (input: unknown): CheckoutSource[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new Error("checkoutSources must be an array");
  const entries: CheckoutSource[] = [];
  const consumers = new Set<string>();
  for (const value of input) {
    if (
      !record(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "path",
            "job",
            "checkout",
            "consumer",
            "destination",
            "ref",
            "condition",
            "selector",
            "reason",
          ].includes(key),
      ) ||
      typeof value["path"] !== "string" ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(value["path"]) ||
      !identifier(value["job"]) ||
      !identifier(value["checkout"]) ||
      !identifier(value["consumer"]) ||
      !repositoryPath(value["destination"]) ||
      !repositoryPath(value["selector"]) ||
      !(
        value["ref"] === null ||
        (typeof value["ref"] === "string" && value["ref"].trim() !== "")
      ) ||
      !(
        value["condition"] === null ||
        (typeof value["condition"] === "string" &&
          value["condition"].trim() !== "")
      ) ||
      typeof value["reason"] !== "string" ||
      value["reason"].trim() === ""
    )
      throw new Error(
        "checkout source requires an exact workflow, job, checkout and consumer IDs, destination, ref, condition, selector and reason",
      );
    const key = `${value["path"]}:${value["job"]}:${value["consumer"]}`;
    if (consumers.has(key))
      throw new Error("checkout source consumers must be unique");
    consumers.add(key);
    entries.push({
      path: value["path"],
      job: value["job"],
      checkout: value["checkout"],
      consumer: value["consumer"],
      destination: value["destination"],
      ref: value["ref"],
      condition: value["condition"],
      selector: value["selector"],
      reason: value["reason"],
    });
  }
  return entries;
};

type CheckoutSourceProof = {
  declaration: CheckoutSource;
  workflow: unknown;
  checkoutSha: string;
  selector: string;
  repository?: string | undefined;
};

/** Identical predicates are sufficient only when their operands cannot change between steps. */
const stableCheckoutCondition = (
  condition: string,
  steps: unknown[],
  checkoutIndex: number,
) => {
  const expression = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens =
    expression.match(
      /'(?:[^']|'')*'|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*|\d+|&&|\|\||==|!=|[!()<>]|\s+|./g,
    ) ?? [];
  return tokens.every((token) => {
    if (
      /^(?:\s+|'(?:[^']|'')*'|\d+|true|false|null|&&|\|\||==|!=|[!()<>])$/.test(
        token,
      )
    )
      return true;
    if (/^(?:inputs|needs|matrix|strategy)\.[A-Za-z_][\w.-]*$/.test(token))
      return true;
    if (
      /^github\.(?:event_name|repository|ref|sha|workflow_sha)$/.test(token) ||
      /^github\.event\.[A-Za-z_][\w.-]*$/.test(token)
    )
      return true;
    const referenced =
      /^steps\.([A-Za-z_][\w-]*)\.(?:outputs\.[A-Za-z_][\w.-]*|outcome|conclusion)$/
        .exec(token)
        ?.at(1);
    if (referenced === undefined) return false;
    const indices = steps.flatMap((step, index) =>
      record(step) && step["id"] === referenced ? [index] : [],
    );
    return (
      indices.length === 1 && (indices.at(0) ?? checkoutIndex) < checkoutIndex
    );
  });
};

/** Resolve the last overlapping writer before this consumer; later writers cannot alter its input. */
export const proveCheckoutSource = ({
  declaration,
  workflow,
  checkoutSha,
  selector,
  repository,
}: CheckoutSourceProof) => {
  if (
    selector !== declaration.selector ||
    !record(workflow) ||
    !record(workflow["jobs"])
  )
    return false;
  const job = workflow["jobs"][declaration.job];
  if (!record(job) || !Array.isArray(job["steps"])) return false;
  const steps: unknown[] = job["steps"];
  const consumerIndices = steps.flatMap((step, index) =>
    record(step) && step["id"] === declaration.consumer ? [index] : [],
  );
  const checkoutIndices = steps.flatMap((step, index) =>
    record(step) && step["id"] === declaration.checkout ? [index] : [],
  );
  const consumerIndex = consumerIndices.at(0);
  const checkoutIndex = checkoutIndices.at(0);
  if (
    consumerIndices.length !== 1 ||
    checkoutIndices.length !== 1 ||
    consumerIndex === undefined ||
    checkoutIndex === undefined ||
    checkoutIndex >= consumerIndex
  )
    return false;
  const consumer = steps.at(consumerIndex);
  const checkout = steps.at(checkoutIndex);
  if (
    !record(consumer) ||
    !record(checkout) ||
    checkoutActionRef(checkout["uses"]) !== checkoutSha ||
    Object.hasOwn(checkout, "continue-on-error")
  )
    return false;
  const options = checkout["with"] === undefined ? {} : checkout["with"];
  if (
    !record(options) ||
    Object.keys(options).some((key) => key !== key.toLowerCase())
  )
    return false;
  const destination = options["path"] ?? ".";
  if (
    destination !== declaration.destination ||
    (options["ref"] ?? null) !== declaration.ref ||
    (checkout["if"] ?? null) !== declaration.condition ||
    (declaration.condition !== null &&
      consumer["if"] !== declaration.condition) ||
    (options["clean"] !== undefined &&
      options["clean"] !== true &&
      options["clean"] !== "true") ||
    (options["repository"] !== undefined &&
      options["repository"] !== "${{ github.repository }}" &&
      options["repository"] !== repository)
  )
    return false;
  if (
    declaration.condition !== null &&
    !stableCheckoutCondition(declaration.condition, steps, checkoutIndex)
  )
    return false;
  const consumerCondition = consumer["if"];
  if (
    declaration.condition === null &&
    consumerCondition !== undefined &&
    (typeof consumerCondition !== "string" ||
      !stableCheckoutCondition(consumerCondition, steps, consumerIndex))
  )
    return false;
  const selected = normalizeCheckoutPath(selector);
  const prefix = normalizeCheckoutPath(declaration.destination);
  if (prefix !== "." && !selected.startsWith(`${prefix}/`)) return false;
  for (const step of steps.slice(checkoutIndex + 1, consumerIndex)) {
    if (!record(step) || checkoutActionRef(step["uses"]) === undefined)
      continue;
    const withOptions = step["with"];
    const other = record(withOptions) ? (withOptions["path"] ?? ".") : ".";
    // Unknown destinations can shadow any selector, even when conditionally written.
    if (!repositoryPath(other)) return false;
    const otherPrefix = normalizeCheckoutPath(other);
    if (
      otherPrefix === "." ||
      selected === otherPrefix ||
      selected.startsWith(`${otherPrefix}/`) ||
      otherPrefix.startsWith(`${selected}/`)
    )
      return false;
  }
  const sparse = options["sparse-checkout"];
  if (sparse !== undefined) {
    if (typeof sparse !== "string") return false;
    const patterns = sparse
      .split(/\r?\n/)
      .map((value) => value.trim().replace(/^\//, "").replace(/\/$/, ""))
      .filter(Boolean);
    if (
      patterns.length === 0 ||
      patterns.some((value) => !literalSparseCheckoutPath(value))
    )
      return false;
    const relative =
      prefix === "." ? selected : path.posix.relative(prefix, selected);
    if (
      !patterns.some(
        (value) => relative === value || relative.startsWith(`${value}/`),
      )
    )
      return false;
  }
  return true;
};
