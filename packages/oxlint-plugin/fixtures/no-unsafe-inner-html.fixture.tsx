// Passive regression fixture for
// `no-unsafe-inner-html/no-unsafe-inner-html`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

const rawHtml = "<img src=x onerror=alert(1)>";
declare const opaqueInsertArguments: [
  Element,
  "beforebegin" | "afterbegin" | "beforeend" | "afterend",
  string,
];
declare const opaqueApplyArguments: [
  Element,
  ["beforebegin" | "afterbegin" | "beforeend" | "afterend", string],
];
declare const opaqueWriteArguments: [Document, string];
declare const opaqueAttributeArguments: [string, string];

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const sanitizeHtml = (value: string): string => escapeHtml(value);

declare const DOMPurify: { sanitize: (value: string) => { value: string } };

const escapeRegex = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sanitizeFilename = (value: string): string => value.replaceAll("/", "_");

export const UnsafeDangerouslySetInnerHtml = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
);

export const UnsafeInnerHtmlAssignment = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = rawHtml;
  return element;
};

export const UnsafeTemplateInterpolation = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = `<strong>${rawHtml}</strong>`;
  return element;
};

export const UnsafeRegexEscaper = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = escapeRegex(rawHtml);
  return element;
};

export const UnsafeFilenameSanitizer = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: sanitizeFilename(rawHtml),
    }}
  />
);

const hoistedPayload = { __html: rawHtml };

export const UnsafeHoistedPayload = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <div dangerouslySetInnerHTML={hoistedPayload} />
);

const spreadPayload = { __html: rawHtml };

export const UnsafeSpreadPayload = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      ...spreadPayload,
    }}
  />
);

const shadowedSanitizeHtml = (value: string): string => value;

export const UnsafeShadowedSanitizer = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: shadowedSanitizeHtml(rawHtml),
    }}
  />
);

export const UnsafeComputedInnerHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- fixture: computed HTML sink
  element["innerHTML"] = rawHtml;
  return element;
};

declare const getDynamicProperty: () => string;

export const DynamicComputedPropertyNamedInnerHtmlIsNotAStaticSink = () => {
  const element = document.createElement("div");
  const innerHTML = getDynamicProperty();
  element[innerHTML] = rawHtml;
  return element;
};

export const UnsafeStaticTemplateComputedInnerHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element[`innerHTML`] = rawHtml;
  return element;
};

export const UnsafeOuterHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.outerHTML = rawHtml;
};

export const UnsafeInsertAdjacentHtml = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML("beforeend", rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element[`insertAdjacentHTML`](`beforeend`, rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- call form
  element.insertAdjacentHTML.call(element, "beforeend", rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  (0, element.insertAdjacentHTML)("beforeend", rawHtml);
};

export const UnsafeDirectSpreadInsertAdjacentHtml = (element: Element) => {
  const forwardedArguments = ["beforeend", rawHtml] as const;
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque spread hides the HTML argument position
  element.insertAdjacentHTML(...forwardedArguments);
};

export const SafeLiteralSpreadInsertAdjacentHtml = (element: Element) =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML(...(["beforeend", "<p>static</p>"] as const));

export const UnsafeCallSpreadInsertAdjacentHtml = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque call spread hides the HTML argument position
  Element.prototype.insertAdjacentHTML.call(...opaqueInsertArguments);
};

export const UnsafeApplyOpaqueCallSpreadInsertAdjacentHtml = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque apply spread hides the forwarded argument list
  Element.prototype.insertAdjacentHTML.apply(...opaqueApplyArguments);
};

export const UnsafeCallSpreadDocumentWrite = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque call spread hides document.write arguments
  document.write.call(...opaqueWriteArguments);
};

export const UnsafeSpreadSetAttribute = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque spread may name srcdoc
  document.createElement("iframe").setAttribute(...opaqueAttributeArguments);
};

export const UnsafeStaticTemplateSrcdocAttribute = () => {
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- static template selects the srcdoc sink
  frame.setAttribute(`srcdoc`, rawHtml);
  return frame;
};

export const UnsafeWrappedStaticSrcdocAttribute = () => {
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- TypeScript wrapper preserves the static srcdoc name
  frame.setAttribute(("srcdoc" as const), rawHtml);
  return frame;
};

declare const dynamicAttributeName: string;
export const DynamicSetAttributeNameIsNotAStaticSrcdocSink = (
  frame: HTMLIFrameElement,
) => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  frame.setAttribute(dynamicAttributeName, rawHtml);
};

export const UnsafeWindowDocumentObjectAssignOpaqueSource = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- window.document creates a known DOM target
  Object.assign(window.document.createElement("div"), unsafeDomProperties);

export const UnsafeDocumentWrite = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.write(rawHtml);
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.writeln("<p>", rawHtml);
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- member document
  frame.contentDocument?.write(rawHtml);
};

export const UnsafeSrcdocProperty = () => {
  const frame = document.createElement("iframe");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  frame.srcdoc = rawHtml;
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  frame.setAttribute("srcdoc", rawHtml);
  return frame;
};

export const UnsafeSrcdocAttribute = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  <iframe sandbox="" srcDoc={rawHtml} title="preview" />
);

declare const shadowRoot: ShadowRoot;

export const UnsafeSetHtmlUnsafe = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  shadowRoot.setHTMLUnsafe(rawHtml);
};

export const UnsafeContextualFragment = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.createRange().createContextualFragment(rawHtml);

export const UnsafeObjectAssign = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { innerHTML: rawHtml });

export const UnsafeApplyInsertAdjacentHtml = (element: Element) => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML.apply(element, ["beforeend", rawHtml]);
};

export const UnsafeApplySpreadInsertAdjacentHtml = (element: Element) => {
  const argumentsList = ["beforeend", rawHtml] as const;
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML.apply(element, [...argumentsList]);
};

export const UnsafeApplyDocumentWrite = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.write.apply(document, [rawHtml]);
};

declare const opaqueChunks: string[];
export const UnsafeOpaqueApplyDocumentWrite = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  document.write.apply(document, opaqueChunks);
};

declare const unsafeDomProperties: object;
declare const opaqueObjectAssignSources: object[];
export const UnsafeObjectAssignHoistedSource = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), unsafeDomProperties);
};

export const UnsafeObjectAssignConstDomTarget = () => {
  const element = document.createElement("div");
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- a stable local DOM target cannot hide an opaque HTML payload
  Object.assign(element, unsafeDomProperties);
};

export const UnsafeObjectAssignDomAliasChain = () => {
  const element = document.createElement("div");
  const firstAlias = element;
  const secondAlias = firstAlias;
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- stable aliases retain DOM target provenance
  Object.assign(secondAlias, unsafeDomProperties);
};

export const SafeObjectAssignCyclicAliases = () => {
  const first = second;
  const second = first;
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(first, unsafeDomProperties);
};

export const SafeObjectAssignReassignedTarget = () => {
  let element: object = document.createElement("div");
  Object.assign(element, { textContent: "initial" });
  element = config;
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(element, unsafeDomProperties);
};

export const SafeObjectAssignNonDomConstTarget = () => {
  const options = {};
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(options, unsafeDomProperties);
};

export const UnsafeObjectAssignApplyHoistedSource = () => {
  Object.assign.apply(Object, [
    document.createElement("div"),
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- fixture: opaque DOM source is reported at its argument
    unsafeDomProperties,
  ]);
};

export const UnsafeObjectAssignApplyKnownArgumentsWithOpaqueRawTail = () => {
  Object.assign.apply(
    Object,
    [
      document.createElement("div"),
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- known apply array retains the unsafe source position
      { innerHTML: rawHtml },
    ],
    ...opaqueObjectAssignSources,
  );
};

export const UnsafeObjectAssignSpreadSource = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { ...unsafeDomProperties });

export const UnsafeObjectAssignLiteralArgumentSpreads = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- literal argument spread forwards an unsafe DOM source
  Object.assign(...[document.createElement("div"), { innerHTML: rawHtml }]);

export const UnsafeObjectAssignLiteralTargetSpread = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- literal target spread keeps the source position known
  Object.assign(...[document.createElement("div")], { innerHTML: rawHtml });

export const UnsafeObjectAssignLiteralSourceSpread = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- literal source spread keeps the DOM target known
  Object.assign(document.createElement("div"), ...[{ innerHTML: rawHtml }]);

export const UnsafeObjectAssignNestedArgumentSpreads = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- nested literal spreads preserve target and source positions
  Object.assign(...[document.createElement("div"), ...[{ srcdoc: rawHtml }]]);

export const UnsafeObjectAssignOpaqueSourceSpread = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- known DOM target with opaque source spread must fail closed
  Object.assign(document.createElement("div"), ...opaqueObjectAssignSources);
};

export const UnsafeObjectAssignDomTargetWithLiteralSpreadTail = () => {
  Object.assign(
    document.createElement("div"),
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque source spread after known DOM target must fail closed
    ...opaqueObjectAssignSources,
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- literal HTML source after opaque spread is still detected
    ...[{ srcdoc: rawHtml }],
  );
};

export const UnsafeObjectAssignKnownTailAfterOpaqueSource = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- explicit HTML source after an opaque source remains detectable
  Object.assign(config, ...opaqueObjectAssignSources, { innerHTML: rawHtml });
};

export const UnsafeObjectAssignLiteralSpreadTailAfterOpaqueSource = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- literal source spread after an opaque source remains detectable
  Object.assign(config, ...opaqueObjectAssignSources, ...[{ innerHTML: rawHtml }]);
};

export const SafeObjectAssignStaticHtmlSpread = () => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(...[document.createElement("div"), { innerHTML: "<p>safe</p>" }]);
};

declare const opaqueObjectAssignArguments: [object, ...object[]];
export const SafeObjectAssignUnknownTargetSpread = () => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(...opaqueObjectAssignArguments);
};

// The equivalence corpus also derives static bracket access for both members.
export const UnsafeStaticMemberObjectAssign = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque HTML-bearing properties require a proven-safe source
  Object.assign(document.createElement("div"), unsafeDomProperties);
};

export const UnsafeOpaqueComputedHtmlPayload = (key: string) => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- an unresolved payload key may name __html, like an object spread
      [key]: rawHtml,
    }}
  />
);

export const UnsafeOpaqueComputedPropsPayload = (key: string) => ({
  dangerouslySetInnerHTML: {
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- opaque computed payload keys are checked outside JSX too
    [key]: rawHtml,
  },
});

export const UnsafeObjectAssignComputedKey = (key: string) =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { [key]: rawHtml });

declare const config: Record<string, unknown>;
export const SafeObjectAssignHoistedConfig = () => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(config, unsafeDomProperties);
};

declare const React: {
  createElement: (type: string, props: object | null) => unknown;
};
declare const jsx: (type: string, props: object) => unknown;
declare const createElement: (type: string, props: object) => unknown;

export const UnsafeReactCreateElement = () =>
  React.createElement("div", {
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- createElement props
    dangerouslySetInnerHTML: { __html: rawHtml },
  });

export const UnsafeJsxRuntimeCall = () =>
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- jsx() props
  jsx("div", { dangerouslySetInnerHTML: { __html: rawHtml } });

export const UnsafeImportedCreateElementShorthand = () => {
  const dangerouslySetInnerHTML = { __html: rawHtml };
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- shorthand property
  return createElement("div", { dangerouslySetInnerHTML });
};

declare const jsxs: (type: string, props: object) => unknown;
declare const jsxDEV: (
  type: string,
  props: object,
  key: unknown,
  staticChildren: boolean,
  source: unknown,
  self: unknown,
) => unknown;

export const UnsafeCreateElementSrcDoc = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- React object props carry the same HTML as JSX attributes
  React.createElement("iframe", { srcDoc: rawHtml });
};

export const UnsafeJsxSrcDoc = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- jsx runtime object props carry HTML
  jsx("iframe", { srcDoc: rawHtml });
};

export const UnsafeJsxsSrcdoc = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- lowercase srcdoc also carries HTML through jsxs
  jsxs("iframe", { srcdoc: rawHtml });
};

export const UnsafeJsxDevSrcDoc = () => {
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- development JSX runtime uses the same prop policy
  jsxDEV("iframe", { srcDoc: rawHtml }, undefined, false, undefined, undefined);
};

export const UnsafeLowercaseSrcdocJsx = () => (
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- lowercase HTML prop shares the JSX and factory policy
  <iframe sandbox="" srcdoc={rawHtml} title="preview" />
);

export const SafeFactorySrcDoc = () => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  React.createElement("iframe", { srcDoc: "<p>Static</p>" });
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  jsx("iframe", { srcdoc: "<p>Static</p>" });
};

// expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
export const NonReactSrcDocData = { srcDoc: rawHtml };

export const UnsafeSpreadProps = () => {
  const props = {
    // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- props object spread into JSX
    dangerouslySetInnerHTML: { __html: rawHtml },
  };
  return <div {...props} />;
};

export const UnsafeEmptyWaiver = () => {
  const element = document.createElement("div");
  // safe-html:
  // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html -- a marker without provenance text
  element.innerHTML = rawHtml;
  return element;
};

export const UnsafeSecondSinkOnWaivedLine = (frame: HTMLIFrameElement) => {
  // safe-html: fixture value stands in for server-side escaped markup
  Object.assign(frame, { innerHTML: rawHtml, srcdoc: rawHtml }); // oxlint-disable-line no-unsafe-inner-html/no-unsafe-inner-html -- one marker covers one sink
};

export const SafeThenUnsafeSameLine = (element: HTMLElement) => {
  // safe-html: fixture waiver is consumed by the first, statically safe assignment
  element.innerHTML = ""; element.outerHTML = rawHtml; // oxlint-disable-line no-unsafe-inner-html/no-unsafe-inner-html -- the safe first sink cannot transfer its waiver
};

export const UnsafeThenSafeSameLine = (element: HTMLElement) => {
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  // safe-html: fixture waiver applies to the first assignment only
  element.innerHTML = rawHtml; element.outerHTML = "";
};

export const TwoUnsafeSameLine = (element: HTMLElement) => {
  // safe-html: fixture waiver applies to the first assignment only
  element.innerHTML = rawHtml; element.outerHTML = rawHtml; // oxlint-disable-line no-unsafe-inner-html/no-unsafe-inner-html -- second same-line sink is intentionally raw
};

// --- Cases the rule MUST NOT flag ---

export const SafeSanitizedCallWithProvenance = () => (
  <div
    dangerouslySetInnerHTML={{
      // safe-html: sanitized locally by the fixture's escaping sanitizeHtml helper
      __html: sanitizeHtml(rawHtml),
    }}
  />
);

// Shared sanitizer allowlist remains valid without a waiver comment.
export const SafeSanitizedCall = () => (
  <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(rawHtml) }} />
);

export const SafeSanitizedResult = () => (
  <div
    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rawHtml).value }}
  />
);

export const SafeAnnotatedSource = () => (
  <div
    dangerouslySetInnerHTML={{
      // safe-html: fixture value stands in for server-side escaped markup
      __html: rawHtml,
    }}
  />
);

export const SafeTemplateInterpolation = () => {
  const element = document.createElement("div");
  // safe-html: rawHtml is escaped by escapeHtml before interpolation
  element.innerHTML = `<strong>${escapeHtml(rawHtml)}</strong>`;
  return element;
};

export const safeStaticMarkup = () => {
  const element = document.createElement("div");
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  element.innerHTML = "<span>Static</span>";
  return element;
};

export const SafeStaticDangerouslySetInnerHtml = () => (
  <div dangerouslySetInnerHTML={{ __html: "<b>Static</b>" }} />
);

export const SafeStaticSrcdoc = () => (
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  <iframe sandbox="" srcDoc="<p>Static</p>" title="preview" />
);

export const SafeAnnotatedWrite = () => {
  const frame = document.createElement("iframe");
  // safe-html: fixture value stands in for server-side escaped markup
  frame.srcdoc = rawHtml;
};

export const SafeTextContentAssign = () =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), { textContent: rawHtml });

export const SafeObjectAssignComputedTemplate = () =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  Object.assign(document.createElement("div"), {
    [`innerHTML`]: "<b>Static</b>",
  });

// The equivalence corpus derives the static bracket spelling from this case.
export const SafeSanitizerResultAccess = () => (
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rawHtml).value }} />
);

export const SafeApplyStaticDocumentWrite = () =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  document.write.apply(document, ["<p>Static</p>"]);

export const SafeApplyStaticInsertAdjacentHtml = (element: Element) =>
  // expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
  element.insertAdjacentHTML.apply(element, ["beforeend", "<b>Static</b>"]);

declare const stream: { write: (chunk: string) => void };
// expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
stream.write(rawHtml);

// A plain object with a `__html` property is data, not a DOM sink until it is
// passed to `dangerouslySetInnerHTML`.
// expect-clean: no-unsafe-inner-html/no-unsafe-inner-html
export const htmlPayload = { __html: rawHtml };
