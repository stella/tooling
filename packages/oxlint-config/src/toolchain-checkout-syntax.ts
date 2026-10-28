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
