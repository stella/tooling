import fs, {
  appendFile,
  mkdir,
  promises as fsp,
  rm,
  writeFile,
  writeFileSync,
} from "node:fs";
import { writeFile as save } from "node:fs/promises";

import { withTestTmpDir } from "@stll/test-kit";
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
fs.writeFileSync("fixture.txt", "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await fsp.writeFile(`${import.meta.dir}/fixture.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
fs.writeFileSync("/tmp/stll-fixture", "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync("fixture.txt", "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync(`fixture.txt`, "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFile(`${import.meta.dir}/fixture.txt`, "x", () => {});
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
mkdir(`${process.cwd()}/fixture`);
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await Bun.write(`${__dirname}/fixture.txt`, "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await save(`${import.meta.dir}/saved.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
await withTestTmpDir((dir) => writeFile(`${dir}/fixture.txt`, "x", () => {}));
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
appendFile("/tmp/stll-fixture", "x", () => {});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
rm("/tmp/stll-fixture", { force: true }, () => {});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
mkdir("/tmp/stll-fixture", () => {});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
fixture.writeFile(`${import.meta.dir}/fixture.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
virtualFilesystem.mkdir(`${process.cwd()}/fixture`);
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync("C:\\temp\\fixture.txt", "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync("C:/temp/fixture.txt", "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync("\\\\server\\share\\fixture.txt", "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(`/tmp/stll-template-fixture`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(`C:\\temp\\fixture.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(`\\\\server\\share\\fixture.txt`, "x");
