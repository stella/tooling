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

declare const opaqueArguments: unknown[];

// The inline route options retain their position through a literal spread.
export const Route = createFileRoute("/__fixture/no-loader")(
  ...[{ component: NoLoaderComponent }],
);

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

  // Known literal spreads preserve the first query argument.
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- fixture: literal spread preserves the query factory
  useSuspenseQuery(...[membersOptions]);
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- fixture: nested spreads preserve the query factory
  useSuspenseQuery(...[...[membersOptions]]);
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- fixture: an empty spread consumes no argument position
  useSuspenseQuery(...[], membersOptions);
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- fixture: a spread factory call still requires loader prefetch
  useSuspenseQuery(...[entityOptions(...["id"])]);

  // A later opaque spread does not obscure the already known first argument.
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- fixture: a later opaque spread leaves the first factory known
  useSuspenseQuery(membersOptions, ...opaqueArguments);

  // An opaque first spread or an array hole cannot reveal a factory at argument zero.
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  useSuspenseQuery(...opaqueArguments);
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  useSuspenseQuery(...opaqueArguments, membersOptions);
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  useSuspenseQuery(...[...opaqueArguments, membersOptions]);
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  useSuspenseQuery(...[, membersOptions]);

  // Literal spread expansion does not make an opaque member-call factory attributable.
  // expect-clean: require-loader-prefetch/require-loader-prefetch
  useSuspenseQuery(...[opaqueOptions.items("id")]);

  return `${entity.data}${members.data}${other.data}${opaque.data}`;
}
