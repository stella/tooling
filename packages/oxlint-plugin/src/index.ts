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
export const bunTestHygienePluginSpecifier =
  "@stll/oxlint-plugin/bun-test-hygiene";

export const bunTestHygienePluginSpecifiers = [
  bunTestHygienePluginSpecifier,
] satisfies JsPlugins;

export const bunTestHygieneRules = {
  "bun-test-hygiene/no-disabled-tests": "error",
  "bun-test-hygiene/no-focused-tests": "error",
  "bun-test-hygiene/no-forced-database-drop": "error",
  "bun-test-hygiene/no-identical-title": "error",
  "bun-test-hygiene/no-promise-matchers": "error",
} satisfies Rules;

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

export const noWallClockInTestsPluginSpecifier =
  "@stll/oxlint-plugin/no-wall-clock-in-tests";
export const noRealTimerWaitsInTestsPluginSpecifier =
  "@stll/oxlint-plugin/no-real-timer-waits-in-tests";
export const noUnseededRandomInTestsPluginSpecifier =
  "@stll/oxlint-plugin/no-unseeded-random-in-tests";
export const noRealNetworkInTestsPluginSpecifier =
  "@stll/oxlint-plugin/no-real-network-in-tests";
export const noCheckoutWritesInTestsPluginSpecifier =
  "@stll/oxlint-plugin/no-checkout-writes-in-tests";
export const noWallClockBoundPluginSpecifier =
  "@stll/oxlint-plugin/no-wall-clock-bound";

// Intentionally separate from every preset: consumers adopt these with a
// shrink-only test baseline.
export const testReliabilityPluginSpecifiers = [
  noWallClockInTestsPluginSpecifier,
  noRealTimerWaitsInTestsPluginSpecifier,
  noUnseededRandomInTestsPluginSpecifier,
  noRealNetworkInTestsPluginSpecifier,
  noCheckoutWritesInTestsPluginSpecifier,
  noWallClockBoundPluginSpecifier,
] satisfies JsPlugins;

export const testReliabilityRules = {
  "no-wall-clock-in-tests/no-wall-clock-in-tests": "error",
  "no-real-timer-waits-in-tests/no-real-timer-waits-in-tests": "error",
  "no-unseeded-random-in-tests/no-unseeded-random-in-tests": "error",
  "no-real-network-in-tests/no-real-network-in-tests": "error",
  "no-checkout-writes-in-tests/no-checkout-writes-in-tests": "error",
  "no-wall-clock-bound/no-wall-clock-bound": "error",
} satisfies Rules;
