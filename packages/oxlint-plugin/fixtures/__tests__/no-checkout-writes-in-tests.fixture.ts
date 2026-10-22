import fs, {
  appendFile,
  appendFileSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createWriteStream,
  mkdir,
  mkdirSync,
  promises as fsp,
  rename,
  renameSync,
  rm,
  rmdir,
  rmdirSync,
  rmSync,
  symlink,
  symlinkSync,
  unlink,
  unlinkSync,
  writeFile,
  writeFileSync,
} from "node:fs";
import { unlink as unlinkPromise, writeFile as save } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const fixtureId = "fixture";
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync(`fixtures/${fixtureId}.txt`, "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(`/tmp/${fixtureId}`, "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync(`${import.meta.dir}/x`, "x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFile(`${import.meta.dir}/fixture.txt`, "x", () => {});
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
mkdir(`${process.cwd()}/fixture`);
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await Bun.write(`${__dirname}/fixture.txt`, "x");
const checkoutRoot = __dirname;
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync(path.join(checkoutRoot, "x"), "x");
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

// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
appendFileSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
copyFile("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
copyFile("/tmp/a", "fixture.txt");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
copyFile("fixture.txt", "/tmp/b");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
copyFileSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
cp("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
cpSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
mkdirSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
rename("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
renameSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
rmSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
rmdir("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
rmdirSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
symlink("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
symlinkSync("fixture", "target");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
createWriteStream("out.log");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
unlink("/tmp/x");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
unlinkSync("fixture.txt");
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
await unlinkPromise("fixture.txt");
import path from "node:path";
// oxlint-disable-next-line no-checkout-writes-in-tests/no-checkout-writes-in-tests -- fixture
writeFileSync(path.join("fixture", crypto.randomUUID()), "x");
await withTestTmpDir((dir) => {
  // expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
  writeFileSync(path.join(dir, "fixture.txt"), "x");
});
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(join(tmpdir(), "x"), "x");
// expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
writeFileSync(resolve("/tmp", "x"), "x");
{
  const shadowFs = {
    writeFileSync: (_path: string, _data: string) => undefined,
  };
  // expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
  shadowFs.writeFileSync("fixture.txt", "x");
}
{
  const __dirname = "/tmp";
  const outsideRoot = __dirname;
  // expect-clean: no-checkout-writes-in-tests/no-checkout-writes-in-tests
  writeFileSync(path.join(outsideRoot, "x"), "x");
}
