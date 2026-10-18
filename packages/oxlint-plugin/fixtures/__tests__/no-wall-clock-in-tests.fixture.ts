import { clock } from "@stll/test-kit";
// oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
export const a = Date.now();
// oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
export const b = new Date();
// oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
export const calledDate = Date();
// oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
export const c = performance.now();
const now = Date.now;
// oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
export const d = now();
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
export const v1 = clock.now();
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
export const v2 = new Date(0);
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
export const calledDateWithArgument = Date(0);
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
export const v3 = Date.parse("2020-01-01T00:00:00Z");
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
export const v4 = performance.timeOrigin;

const nestedNow = now;
const readLater = () => {
  // oxlint-disable-next-line no-wall-clock-in-tests/no-wall-clock-in-tests -- fixture
  nestedNow();
};
void readLater;
{
  const Date = { now: () => 0 };
  // expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
  Date.now();
}
