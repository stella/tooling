import { createSeededRandom, testSeed } from "@stll/test-kit";
// oxlint-disable-next-line no-unseeded-random-in-tests/no-unseeded-random-in-tests -- fixture
export const a = Math.random();
// oxlint-disable-next-line no-unseeded-random-in-tests/no-unseeded-random-in-tests -- fixture
crypto.getRandomValues(new Uint8Array(2));
const random = Math.random;
// oxlint-disable-next-line no-unseeded-random-in-tests/no-unseeded-random-in-tests -- fixture
export const b = random();
// oxlint-disable-next-line typescript/unbound-method -- fixture aliases the API to prove detector behavior
const fill = crypto.getRandomValues;
// oxlint-disable-next-line no-unseeded-random-in-tests/no-unseeded-random-in-tests -- fixture
fill(new Uint8Array(2));
// expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
export const v1 = createSeededRandom(testSeed)();
// expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
export const v2 = 0.5;
// expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
export const v3 = crypto.randomUUID();
// expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
export const v4 = new Uint8Array([1, 2]);

const nestedRandom = random;
const randomLater = () => {
  // oxlint-disable-next-line no-unseeded-random-in-tests/no-unseeded-random-in-tests -- fixture
  nestedRandom();
};
void randomLater;
{
  const Math = { random: () => 0.5 };
  // expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
  Math.random();
}
