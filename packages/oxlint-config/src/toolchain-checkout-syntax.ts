import path from "node:path";

/** Repository names are case-insensitive; the selected ref retains its exact spelling. */
export const checkoutActionRef = (value: unknown) =>
  typeof value === "string"
    ? /^actions\/checkout@(.+)$/i.exec(value)?.at(1)
    : undefined;

export const literalSparseCheckoutPath = (value: string) =>
  value !== "" &&
  !/[!$*?[\]\\:]/.test(value) &&
  !path.posix.isAbsolute(value) &&
  !value.split("/").includes("..");

export const normalizeCheckoutPath = (prefix: string) =>
  path.posix.normalize(prefix).replace(/\/$/, "") || ".";

export const selfCheckoutRepository = (
  value: unknown,
  repository: string | undefined,
) =>
  value === undefined ||
  value === "${{ github.repository }}" ||
  (typeof value === "string" &&
    repository !== undefined &&
    value.toLowerCase() === repository.toLowerCase());

export const sparseCheckoutPaths = (value: string) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/^\//, ""))
    .filter((entry) => entry !== "");

type CheckoutContainment = { destination: string; selector: string };
export const checkoutContains = ({
  destination,
  selector,
}: CheckoutContainment) =>
  destination === "." ||
  selector === destination ||
  selector.startsWith(`${destination}/`);
