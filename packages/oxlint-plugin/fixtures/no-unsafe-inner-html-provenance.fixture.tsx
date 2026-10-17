// This fixture opts into source-level provenance instead of the default
// allowlist of sanitizer callee names.

const rawHtml = "<img src=x onerror=alert(1)>";
const sanitizeHtml = (value: string): string => value;
const sanitizeDom = (value: string): { html: string } => ({ html: value });

export const UnannotatedIdentitySanitizer = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: sanitizeHtml(rawHtml),
    }}
  />
);

export const UnannotatedSanitizerResultAccessor = () => (
  <div
    dangerouslySetInnerHTML={{
      // oxlint-disable-next-line no-unsafe-inner-html/no-unsafe-inner-html
      __html: sanitizeDom(rawHtml).html,
    }}
  />
);

export const AnnotatedSanitizerSource = () => (
  <div
    dangerouslySetInnerHTML={{
      // safe-html: fixture function output has escaped markup provenance
      __html: sanitizeHtml(rawHtml),
    }}
  />
);

export const StaticMarkupNeedsNoAnnotation = () => (
  <div dangerouslySetInnerHTML={{ __html: "<b>Static</b>" }} />
);
