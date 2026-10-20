// A `.only` access outside a Bun test file stays clean.
declare const config: { only: boolean };

// expect-clean: bun-test-hygiene/no-focused-tests
if (config.only) console.info("enabled");
