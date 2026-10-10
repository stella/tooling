import { expect, test } from "bun:test";

import { selectConsumerReactVersions } from "./consumer-react";

const reactVersions = {
  "19.0.1": {},
  "18.0.0": {},
  "19.0.0": {},
  "19.0.0-rc.1": {},
  malformed: {},
};
const domVersions = {
  "19.0.1": { peerDependencies: { react: "^19.0.0" } },
  "18.0.0": { peerDependencies: { react: "^18.0.0" } },
  "19.0.0": { peerDependencies: { react: "^19.0.0" } },
  "19.0.0-rc.1": { peerDependencies: { react: "^19.0.0" } },
};

test("React-only selection remains independent of renderer compatibility", () => {
  expect(
    selectConsumerReactVersions({ reactRange: "^18 || ^19", reactVersions }),
  ).toEqual({ react: "18.0.0" });
});

test("joint selection advances React only when its oldest version has no allowed renderer", () => {
  expect(
    selectConsumerReactVersions({
      reactRange: "^18 || ^19",
      reactVersions,
      dom: { range: "^19", versions: domVersions },
    }),
  ).toEqual({ react: "19.0.0", "react-dom": "19.0.0" });
  expect(
    selectConsumerReactVersions({
      reactRange: "^18 || ^19",
      reactVersions,
      dom: { versions: domVersions },
    }),
  ).toEqual({ react: "18.0.0", "react-dom": "18.0.0" });
});

test("renderer peer metadata decides compatibility and the oldest compatible renderer wins", () => {
  const versions = {
    "18.0.0": { peerDependencies: { react: "^17" } },
    "18.0.2": { peerDependencies: { react: "^18" } },
    "18.0.1": { peerDependencies: { react: "^18" } },
    "17.0.0": { peerDependencies: { react: "^18" } },
  };
  expect(
    selectConsumerReactVersions({
      reactRange: "^18",
      reactVersions,
      dom: { range: "^18", versions },
    }),
  ).toEqual({ react: "18.0.0", "react-dom": "18.0.1" });
});

test("malformed renderer records cannot establish compatibility", () => {
  for (const metadata of [
    undefined,
    null,
    [],
    {},
    { peerDependencies: [] },
    { peerDependencies: { react: 18 } },
    { peerDependencies: { react: "invalid" } },
  ])
    expect(() =>
      selectConsumerReactVersions({
        reactRange: "^18",
        reactVersions,
        dom: { versions: { "18.0.0": metadata } },
      }),
    ).toThrow("no published React/ReactDOM pair");
});

test("invalid ranges and absent published versions retain precise failures", () => {
  expect(() =>
    selectConsumerReactVersions({ reactRange: "invalid", reactVersions }),
  ).toThrow("invalid consumer peer range: invalid");
  expect(() =>
    selectConsumerReactVersions({ reactRange: "^20", reactVersions }),
  ).toThrow("no published consumer version satisfies ^20");
  expect(() =>
    selectConsumerReactVersions({
      reactRange: "^18",
      reactVersions,
      dom: { range: "invalid", versions: domVersions },
    }),
  ).toThrow("invalid consumer peer range: invalid");
  expect(() =>
    selectConsumerReactVersions({
      reactRange: "^18",
      reactVersions,
      dom: { range: "^20", versions: domVersions },
    }),
  ).toThrow("no published consumer version satisfies ^20");
  expect(() =>
    selectConsumerReactVersions({
      reactRange: "^18",
      reactVersions,
      dom: { range: "^19", versions: domVersions },
    }),
  ).toThrow(
    "no published React/ReactDOM pair satisfies React ^18 and ReactDOM ^19",
  );
});
