// Focus and disabling accesses outside a Bun test file stay clean.
declare const config: {
  only: boolean;
  skip: unknown;
  skipIf: unknown;
  todo: unknown;
  todoIf: unknown;
};

// expect-clean: bun-test-hygiene/no-focused-tests
if (config.only) console.info("enabled");
// expect-clean: bun-test-hygiene/no-disabled-tests
void config.skip;
// expect-clean: bun-test-hygiene/no-disabled-tests
void config.skipIf;
// expect-clean: bun-test-hygiene/no-disabled-tests
void config.todo;
// expect-clean: bun-test-hygiene/no-disabled-tests
void config.todoIf;
// expect-clean: bun-test-hygiene/no-disabled-tests, typescript/dot-notation
// oxlint-disable-next-line typescript/dot-notation -- the computed form is the case under test
void config["skip"];
