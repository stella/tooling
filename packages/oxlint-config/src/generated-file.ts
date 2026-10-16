import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const optionalStat = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

export const checkGeneratedOutput = async (destination: string) => {
  const parent = dirname(destination);
  const parentStat = await optionalStat(parent);
  if (
    parentStat !== undefined &&
    (parentStat.isSymbolicLink() || !parentStat.isDirectory())
  )
    throw new Error(
      "generated output parent must be a real repository directory",
    );
  const destinationStat = await optionalStat(destination);
  if (
    destinationStat !== undefined &&
    (destinationStat.isSymbolicLink() ||
      !destinationStat.isFile() ||
      destinationStat.nlink !== 1)
  )
    throw new Error(
      "generated output destination must be a single-link regular repository file",
    );
  return destinationStat;
};

type GeneratedFileOptions = {
  destination: string;
  text: string;
  mode: number;
};

export const writeGeneratedFile = async ({
  destination,
  text,
  mode,
}: GeneratedFileOptions) => {
  await checkGeneratedOutput(destination);
  await mkdir(dirname(destination), { recursive: true });
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    mode,
  );
  try {
    const opened = await output.stat();
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error(
        "generated output destination must be a single-link regular repository file",
      );
    await output.truncate(0);
    await output.writeFile(text, "utf8");
    await output.chmod(mode);
  } finally {
    await output.close();
  }
};
