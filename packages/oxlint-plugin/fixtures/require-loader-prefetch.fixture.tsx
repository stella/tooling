// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// Route file with NO loader. Every `useSuspenseQuery(factory...)` must flag,
// because the missing loader forces a render-fetch waterfall. Each
// `oxlint-disable-next-line` suppresses a pattern the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness.

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

declare const entityOptions: (id: string) => {
  queryKey: readonly ["entity", string];
  queryFn: () => Promise<string>;
};
declare const membersOptions: {
  queryKey: readonly ["members"];
  queryFn: () => Promise<string>;
};
declare const opaqueOptions: {
  items: (id: string) => {
    queryKey: readonly ["opaque", string];
    queryFn: () => Promise<string>;
  };
};

export const Route = createFileRoute("/__fixture/no-loader")({
  component: NoLoaderComponent,
});

function NoLoaderComponent() {
  // Factory-call argument, no loader — MUST flag.
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch
  const entity = useSuspenseQuery(entityOptions("id"));

  // Bare-identifier argument, no loader — MUST flag.
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch
  const members = useSuspenseQuery(membersOptions);

  // Member-expression argument the rule cannot attribute — NOT flagged.
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  const other = useSuspenseQuery({ queryKey: ["x"], queryFn: () => "x" });

  // Opaque member-call factory without a loader remains outside static attribution.
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  const opaque = useSuspenseQuery(opaqueOptions.items("id"));

  return `${entity.data}${members.data}${other.data}${opaque.data}`;
}
