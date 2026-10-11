export const compilerPackages = {
  typescript: "typescript",
  typescriptCompatibility: "@typescript/typescript6",
  native: "@typescript/native",
  nativePreview: "@typescript/native-preview",
  typescriptCompatibilityAlias: "typescript-compat",
  bunTypes: "bun-types",
  typesBun: "@types/bun",
  tsgo: "tsgo",
  typescriptTsgo: "@typescript/tsgo",
} as const;

export const isCompilerPackage = (name: string) =>
  Object.values(compilerPackages).some((identifier) => identifier === name) ||
  name.startsWith("@typescript/native-");
