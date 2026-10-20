const started = performance.now();
declare const run: () => void;
run();

// A production file is outside the rule's test-only scope.
expect(performance.now() - started).toBeLessThan(2_000);
