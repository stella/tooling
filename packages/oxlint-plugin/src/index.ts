import type { OxlintConfig } from "oxlint";

type JsPlugins = NonNullable<OxlintConfig["jsPlugins"]>;
type Rules = NonNullable<OxlintConfig["rules"]>;

export const noAnyCastsPluginSpecifier = "@stll/oxlint-plugin/no-any-casts";
export const noDangerousTypeAssertionsPluginSpecifier =
  "@stll/oxlint-plugin/no-dangerous-type-assertions";
export const noPartialRecordSatisfiesPluginSpecifier =
  "@stll/oxlint-plugin/no-partial-record-satisfies";
export const noUnsafeInnerHtmlPluginSpecifier =
  "@stll/oxlint-plugin/no-unsafe-inner-html";
export const noRawRouteQueryClientPluginSpecifier =
  "@stll/oxlint-plugin/no-raw-route-query-client";
export const requireLoaderPrefetchPluginSpecifier =
  "@stll/oxlint-plugin/require-loader-prefetch";

export const portableSafetyPluginSpecifiers = [
  noAnyCastsPluginSpecifier,
  noDangerousTypeAssertionsPluginSpecifier,
  noPartialRecordSatisfiesPluginSpecifier,
  noUnsafeInnerHtmlPluginSpecifier,
] satisfies JsPlugins;

export const portableSafetyRules = {
  "no-any-casts/no-any-casts": "error",
  "no-dangerous-type-assertions/no-dangerous-type-assertions": "error",
  "no-partial-record-satisfies/no-partial-record-satisfies": "error",
  "no-unsafe-inner-html/no-unsafe-inner-html": "error",
} satisfies Rules;

export const routeQueryPluginSpecifiers = [
  noRawRouteQueryClientPluginSpecifier,
  requireLoaderPrefetchPluginSpecifier,
] satisfies JsPlugins;

export const routeQueryRules = {
  "no-raw-route-query-client/no-raw-route-query-client": "error",
  "require-loader-prefetch/require-loader-prefetch": "error",
} satisfies Rules;
