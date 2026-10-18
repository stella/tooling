import { appendFile, mkdir, rm, writeFile, writeFileSync } from "node:fs";

import { withTestTmpDir } from "@stll/test-kit";
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync("fixture.txt", "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFile(`${import.meta.dir}/fixture.txt`, "x", () => {});
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
mkdir(`${process.cwd()}/fixture`);
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await Bun.write(`${__dirname}/fixture.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
await withTestTmpDir((dir) => writeFile(`${dir}/fixture.txt`, "x", () => {}));
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
appendFile("/tmp/stll-fixture", "x", () => {});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
rm("/tmp/stll-fixture", { force: true }, () => {});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
mkdir("/tmp/stll-fixture", () => {});
