// Passive regression fixture for `stella-lowercase/stella-lowercase`.
//
// Disabled lines are cases the rule must flag. If the rule regresses, the
// corresponding directive becomes unused and lint fails with
// report-unused-disable-directives enabled.

// oxlint-disable-next-line stella-lowercase/stella-lowercase
const _midSentenceString = "Welcome to Stella";

const _midSentenceTemplate = (status: number): string =>
  // oxlint-disable-next-line stella-lowercase/stella-lowercase
  `Request to Stella failed with ${status}`;

const _nonHeadQuasi = (label: string): string =>
  // oxlint-disable-next-line stella-lowercase/stella-lowercase
  `${label} Stella refused`;

const _jsxMidSentence = () => (
  <p>
    {/* oxlint-disable-next-line stella-lowercase/stella-lowercase */}
    Powered by Stella
  </p>
);

const _stringStart = "Stella is loading";
const _afterPeriodSpace = "Workflow paused. Stella resumed";
const _kebabAssetName = "Stella-macos-universal.dmg";
const _bundleId = "Stella.app";
const _pathString = "/Applications/Stella.app/Contents/MacOS";
const _identifierString = "StellaMark";
const _alreadyLowercase = "Welcome to stella";

export const __stellaLowercaseFixture = {
  _midSentenceString,
  _midSentenceTemplate,
  _nonHeadQuasi,
  _jsxMidSentence,
  _stringStart,
  _afterPeriodSpace,
  _kebabAssetName,
  _bundleId,
  _pathString,
  _identifierString,
  _alreadyLowercase,
};
