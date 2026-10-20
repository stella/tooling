// The test-reliability rules are inert outside *.test.*, *.spec.*, and __tests__.
// expect-clean: no-wall-clock-in-tests/no-wall-clock-in-tests
Date.now();
// expect-clean: no-real-timer-waits-in-tests/no-real-timer-waits-in-tests
setTimeout(() => {}, 10);
// expect-clean: no-unseeded-random-in-tests/no-unseeded-random-in-tests
Math.random();
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("https://example.com");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
void Bun.write("fixture.txt", "x");
