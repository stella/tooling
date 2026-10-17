import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

import { generateRustPolicy, parseRustPolicy } from "./rust-policy";

const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rust-policy-"));
  try {
    await writeFile(
      join(root, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nserde = "1"\n',
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const single = { kind: "single-crate" };
const read = async (root: string, file: string) =>
  parse(await readFile(join(root, file), "utf8"));

test("templates merge without losing unrelated values, and converge in write/check modes", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, ".cargo"));
    await writeFile(
      join(root, ".cargo/config.toml"),
      '[build]\ntarget-dir = "custom"\n[alias]\nlocal = "test"\n',
    );
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toHaveLength(4);
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).not.toContain(
      "profile",
    );
    await generateRustPolicy({ root, input: single, mode: "write" });
    const templates = fileURLToPath(new URL("../../../rust", import.meta.url));
    for (const [file, source] of [
      ["Cargo.toml", "cargo-root.toml"],
      [".cargo/config.toml", "cargo-config.toml"],
      ["rustfmt.toml", "rustfmt.toml"],
      ["clippy.toml", "clippy.toml"],
    ]) {
      if (file === undefined || source === undefined)
        throw new Error("missing fixture mapping");
      expect(await read(root, file)).toMatchObject(
        await read(templates, source),
      );
    }
    const cargo = await read(root, "Cargo.toml");
    expect(cargo["dependencies"]).toEqual({ serde: "1" });
    expect(cargo["profile"]).toEqual(
      (
        await read(
          fileURLToPath(new URL("../../../rust", import.meta.url)),
          "cargo-root.toml",
        )
      )["profile"],
    );
    expect(await read(root, ".cargo/config.toml")).toMatchObject({
      build: { "target-dir": "custom" },
      alias: { local: "test", "ci-fmt": "fmt --all -- --check" },
    });
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toEqual([]);
    expect(
      await generateRustPolicy({ root, input: single, mode: "write" }),
    ).toEqual([]);
    await writeFile(join(root, "rustfmt.toml"), 'edition = "2021"\n');
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toEqual(["rustfmt.toml"]);
  });
});

test("workspace roots and members receive valid inheritance, with reasoned exceptions", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "crate"));
    await writeFile(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crate"]\nresolver = "3"\n',
    );
    await writeFile(
      join(root, "crate/Cargo.toml"),
      '[package]\nname = "crate"\nversion = "0.1.0"\n',
    );
    const input = {
      kind: "workspace",
      exceptions: [
        {
          file: "rustfmt.toml",
          path: ["edition"],
          value: "2021",
          reason: "Migration pending",
        },
      ],
    };
    await generateRustPolicy({ root, input, mode: "write" });
    expect(await read(root, "crate/Cargo.toml")).toMatchObject({
      lints: { workspace: true },
    });
    expect(await read(root, "Cargo.toml")).toMatchObject({
      workspace: {
        members: ["crate"],
        resolver: "3",
        lints: { rust: { unsafe_code: "deny" } },
      },
    });
    expect(await generateRustPolicy({ root, input, mode: "check" })).toEqual(
      [],
    );
  });
});

test("invalid policies and exceptions fail before outputs change", async () => {
  for (const input of [
    {},
    { kind: "other" },
    { ...single, extra: true },
    { ...single, members: ["crate/Cargo.toml"] },
    { kind: "workspace", members: ["../Cargo.toml"] },
    { kind: "workspace", members: ["Cargo.toml", "Cargo.toml"] },
    {
      ...single,
      exceptions: [
        { file: "rustfmt.toml", path: ["edition"], value: "2021", reason: "" },
      ],
    },
  ])
    expect(() => parseRustPolicy(input)).toThrow();
  await fixture(async (root) => {
    const before = await readFile(join(root, "Cargo.toml"), "utf8");
    for (const path of [
      ["missing"],
      ["profile"],
      ["profile", "missing", "value"],
    ]) {
      await expect(
        generateRustPolicy({
          root,
          mode: "write",
          input: {
            ...single,
            exceptions: [
              { file: "Cargo.toml", path, value: "x", reason: "fixture" },
            ],
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(before);
    }
  });
});

test("unsafe output links and ancestors are rejected without partial writes", async () => {
  for (const kind of ["symlink", "hardlink", "directory", "ancestor"])
    await fixture(async (root) => {
      const original = await readFile(join(root, "Cargo.toml"), "utf8");
      const outside = join(root, "outside");
      await writeFile(outside, "untouched");
      if (kind === "symlink")
        await symlink(outside, join(root, "rustfmt.toml"));
      if (kind === "hardlink") await link(outside, join(root, "rustfmt.toml"));
      if (kind === "directory") await mkdir(join(root, "rustfmt.toml"));
      if (kind === "ancestor") await symlink(root, join(root, ".cargo"));
      await expect(
        generateRustPolicy({ root, input: single, mode: "write" }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(original);
      expect(await readFile(outside, "utf8")).toBe("untouched");
    });
});

test("CLI covers defaults, config override, help, errors and read-only drift", async () => {
  await fixture(async (root) => {
    const cli = fileURLToPath(new URL("./rust-policy-cli.ts", import.meta.url));
    const invoke = (args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
      });
    expect(invoke(["--help"]).status).toBe(0);
    for (const args of [["--bad"], ["--config"], ["--check", "--check"]])
      expect(invoke(args).status).toBe(1);
    await writeFile(
      join(root, "stll-rust-policy.json"),
      JSON.stringify(single),
    );
    expect(invoke(["--check"]).status).toBe(1);
    const write = invoke([]);
    expect(write.status, write.stderr).toBe(0);
    expect(invoke(["--check"]).status).toBe(0);
    await writeFile(join(root, "custom.json"), JSON.stringify(single));
    expect(invoke(["--config", "custom.json", "--check"]).status).toBe(0);
  });
});

test.skipIf(process.env["CI"] !== "true")(
  "published CLI embeds templates for ESM and CommonJS",
  async () => {
    await fixture(async (root) => {
      await writeFile(
        join(root, "stll-rust-policy.json"),
        JSON.stringify(single),
      );
      for (const extension of ["mjs", "cjs"]) {
        const cli = fileURLToPath(
          new URL(`../dist/rust-policy-cli.${extension}`, import.meta.url),
        );
        const result = spawnSync("node", [cli], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(
          await generateRustPolicy({ root, input: single, mode: "check" }),
        ).toEqual([]);
      }
    });
  },
);

test("workspace discovery follows globs, exclusions, inherited target dependencies and transitive path members", async () => {
  await fixture(async (root) => {
    for (const directory of [
      "crates/a",
      "crates/excluded",
      "support/b",
      "support/c",
    ])
      await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/excluded"]\n[workspace.dependencies]\nb = { path = "support/b" }\n',
    );
    await writeFile(
      join(root, "crates/a/Cargo.toml"),
      '[package]\nname = "a"\nversion = "0.1.0"\n[target.\'cfg(unix)\'.build-dependencies]\nb = { workspace = true }\n',
    );
    await writeFile(
      join(root, "crates/excluded/Cargo.toml"),
      '[package]\nname = "excluded"\nversion = "0.1.0"\n',
    );
    await writeFile(
      join(root, "support/b/Cargo.toml"),
      '[package]\nname = "b"\nversion = "0.1.0"\n[dev-dependencies]\nc = { path = "../c" }\n',
    );
    await writeFile(
      join(root, "support/c/Cargo.toml"),
      '[package]\nname = "c"\nversion = "0.1.0"\n',
    );
    const input = { kind: "workspace" };
    await generateRustPolicy({ root, input, mode: "write" });
    for (const member of ["crates/a", "support/b", "support/c"])
      expect(await read(root, `${member}/Cargo.toml`)).toMatchObject({
        lints: { workspace: true },
      });
    expect(await read(root, "crates/excluded/Cargo.toml")).not.toHaveProperty(
      "lints",
    );
    expect(await generateRustPolicy({ root, input, mode: "check" })).toEqual(
      [],
    );
  });
});

test("workspace discovery rejects escaping paths and existing local member lint tables before writes", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "member"));
    await writeFile(
      join(root, "member/Cargo.toml"),
      '[package]\nname = "member"\nversion = "0.1.0"\n[lints.rust]\nunsafe_code = "allow"\n',
    );
    for (const members of ['["../outside"]', '["missing"]', '["member"]']) {
      const current = `[workspace]\nmembers = ${members}\n`;
      await writeFile(join(root, "Cargo.toml"), current);
      await expect(
        generateRustPolicy({
          root,
          input: { kind: "workspace" },
          mode: "write",
        }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(current);
    }
  });
});

test("ownership metadata retires removed leaves and exception defaults converge without losing unrelated values", async () => {
  await fixture(async (root) => {
    const input = {
      ...single,
      exceptions: [
        {
          file: "rustfmt.toml",
          path: ["edition"],
          value: "2021",
          reason: "Edition migration",
        },
      ],
    };
    await generateRustPolicy({ root, input, mode: "write" });
    const cargoPath = join(root, "Cargo.toml");
    const previous = await readFile(cargoPath, "utf8");
    const marker = "# stll-rust-policy-owned-v1: ";
    const oldLine = previous
      .split("\n")
      .find((line) => line.startsWith(marker));
    if (oldLine === undefined) throw new Error("ownership metadata missing");
    const historical: unknown = JSON.parse(oldLine.slice(marker.length));
    if (!Array.isArray(historical))
      throw new Error("invalid test ownership metadata");
    const retired = [
      ["profile", "release", "retired_setting"],
      ["lints", "clippy", "retired_lint"],
    ];
    const ownership = `${marker}${JSON.stringify([...historical, ...retired])}`;
    const legacy = previous
      .replace(oldLine, ownership)
      .replace(
        "[profile.release]",
        '[profile.release]\nretired_setting = true\nproject_setting = "keep"',
      )
      .replace(
        "[lints.clippy]",
        '[lints.clippy]\nretired_lint = "deny"\nproject_lint = "warn"',
      );
    await writeFile(cargoPath, legacy);
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toEqual(["Cargo.toml", "rustfmt.toml"]);
    expect(await readFile(cargoPath, "utf8")).toBe(legacy);
    await generateRustPolicy({ root, input: single, mode: "write" });
    const generated = await readFile(cargoPath, "utf8");
    expect(generated).not.toContain("retired_setting");
    expect(generated).not.toContain("retired_lint");
    expect(await read(root, "Cargo.toml")).toMatchObject({
      profile: { release: { project_setting: "keep" } },
      lints: { clippy: { project_lint: "warn" } },
    });
    expect(await read(root, "rustfmt.toml")).toMatchObject({ edition: "2024" });
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toEqual([]);
  });
});

test("malformed and out-of-scope ownership markers never discard unrelated Cargo data", async () => {
  await fixture(async (root) => {
    const current = await readFile(join(root, "Cargo.toml"), "utf8");
    const bad = [
      "null",
      "[[]]",
      '[["dependencies","serde"]]',
      '[["workspace","members"]]',
      '[["workspace","resolver"]]',
      '[["profile","custom","inherits"]]',
      '[["lints","rust"]]',
      '[["lints","rust","__proto__"]]',
      '[["lints","rust","warnings"],["lints","rust","warnings"]]',
      '[["lints","rust","warnings"],["lints","rust","warnings","level"]]',
    ];
    for (const metadata of bad) {
      const text = `# stll-rust-policy-owned-v1: ${metadata}\n${current}`;
      await writeFile(join(root, "Cargo.toml"), text);
      await expect(
        generateRustPolicy({ root, input: single, mode: "write" }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(text);
    }
  });
});

test("ownership-looking text in multiline TOML values remains ordinary project data", async () => {
  await fixture(async (root) => {
    const before = await readFile(join(root, "Cargo.toml"), "utf8");
    await writeFile(
      join(root, "Cargo.toml"),
      `${before}\n[package.metadata]\nnote = '''\n# stll-rust-policy-owned-v1: [["dependencies","serde"]]\n'''\n`,
    );
    await generateRustPolicy({ root, input: single, mode: "write" });
    expect(await read(root, "Cargo.toml")).toMatchObject({
      dependencies: { serde: "1" },
      package: {
        metadata: {
          note: '# stll-rust-policy-owned-v1: [["dependencies","serde"]]\n',
        },
      },
    });
    expect(
      await generateRustPolicy({ root, input: single, mode: "check" }),
    ).toEqual([]);
  });
});

test("workspace inheritance cannot be overridden by exceptions on members or root packages", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "member"));
    const rootText =
      '[package]\nname = "root"\nversion = "0.1.0"\n[workspace]\nmembers = ["member"]\n';
    const memberText = '[package]\nname = "member"\nversion = "0.1.0"\n';
    await writeFile(join(root, "Cargo.toml"), rootText);
    await writeFile(join(root, "member/Cargo.toml"), memberText);
    const files = ["Cargo.toml", "member/Cargo.toml"];
    for (const file of files)
      for (const value of [false, true]) {
        const input = {
          kind: "workspace",
          exceptions: [
            { file, path: ["lints", "workspace"], value, reason: "fixture" },
          ],
        };
        await expect(
          generateRustPolicy({ root, input, mode: "write" }),
        ).rejects.toThrow("inheritance is structural");
        expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(rootText);
        expect(await readFile(join(root, "member/Cargo.toml"), "utf8")).toBe(
          memberText,
        );
        expect(
          await readFile(join(root, "rustfmt.toml"), "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
        expect(
          await readFile(join(root, "clippy.toml"), "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
        expect(
          await readFile(join(root, ".cargo/config.toml"), "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
      }
  });
});

test("a symlinked intermediate glob directory fails before writes even alongside ordinary members", async () => {
  await fixture(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "rust-policy-external-"));
    try {
      await mkdir(join(root, "crates/ordinary/member"), { recursive: true });
      await mkdir(join(outside, "member"));
      const rootText = '[workspace]\nmembers = ["crates/*/*"]\n';
      const memberText = '[package]\nname = "member"\nversion = "0.1.0"\n';
      await writeFile(join(root, "Cargo.toml"), rootText);
      await writeFile(
        join(root, "crates/ordinary/member/Cargo.toml"),
        memberText,
      );
      await writeFile(join(outside, "member/Cargo.toml"), memberText);
      await symlink(outside, join(root, "crates/link"));
      await expect(
        generateRustPolicy({
          root,
          input: { kind: "workspace" },
          mode: "write",
        }),
      ).rejects.toThrow("real directories");
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(rootText);
      expect(
        await readFile(join(root, "crates/ordinary/member/Cargo.toml"), "utf8"),
      ).toBe(memberText);
      expect(await readFile(join(outside, "member/Cargo.toml"), "utf8")).toBe(
        memberText,
      );
      for (const file of ["rustfmt.toml", "clippy.toml", ".cargo/config.toml"])
        expect(
          await readFile(join(root, file), "utf8").catch(() => undefined),
        ).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("former explicit, excluded and path-dependency members retire inheritance and replay cleanup safely", async () => {
  for (const transition of ["removed", "excluded", "path-dependency"])
    await fixture(async (root) => {
      await mkdir(join(root, "keep"));
      await mkdir(join(root, "retire"));
      await writeFile(
        join(root, "Cargo.toml"),
        `[workspace]\nmembers = ${transition === "path-dependency" ? '["keep"]' : '["keep", "retire"]'}\n`,
      );
      const keep = '[package]\nname = "keep"\nversion = "0.1.0"\n';
      await writeFile(
        join(root, "keep/Cargo.toml"),
        keep +
          (transition === "path-dependency"
            ? '[dependencies]\nretire = { path = "../retire" }\n'
            : ""),
      );
      await writeFile(
        join(root, "retire/Cargo.toml"),
        '[package]\nname = "retire"\nversion = "0.1.0"\n[package.metadata]\ncustom = "preserved"\n',
      );
      const input = { kind: "workspace" };
      await generateRustPolicy({ root, input, mode: "write" });
      expect(await read(root, "retire/Cargo.toml")).toMatchObject({
        lints: { workspace: true },
      });
      let source = await readFile(join(root, "Cargo.toml"), "utf8");
      if (transition === "removed")
        source = source.replace(/members = \[[^\]]*\]/u, 'members = ["keep"]');
      if (transition === "excluded")
        source = source.replace(
          "[workspace]\n",
          '[workspace]\nexclude = ["retire"]\n',
        );
      if (transition === "path-dependency") {
        const previous = await readFile(join(root, "keep/Cargo.toml"), "utf8");
        const header = previous
          .split("\n")
          .filter((line) => line.startsWith("#"))
          .join("\n");
        await writeFile(
          join(root, "keep/Cargo.toml"),
          `${header}\n${keep}[lints]\nworkspace = true\n`,
        );
      }
      await writeFile(join(root, "Cargo.toml"), source);
      expect(
        await generateRustPolicy({ root, input, mode: "check" }),
      ).toContain("retire/Cargo.toml");
      expect(await read(root, "retire/Cargo.toml")).toMatchObject({
        lints: { workspace: true },
      });
      await generateRustPolicy({ root, input, mode: "write" });
      expect(await read(root, "retire/Cargo.toml")).not.toHaveProperty("lints");
      expect(await read(root, "retire/Cargo.toml")).toMatchObject({
        package: { metadata: { custom: "preserved" } },
      });
      expect(await generateRustPolicy({ root, input, mode: "check" })).toEqual(
        [],
      );
      // Replay a completed member cleanup with the old root journal still present.
      await writeFile(join(root, "Cargo.toml"), source);
      await generateRustPolicy({ root, input, mode: "write" });
      expect(await generateRustPolicy({ root, input, mode: "check" })).toEqual(
        [],
      );
      expect(await read(root, "retire/Cargo.toml")).not.toHaveProperty("lints");
    });
});

test("hidden member and exclude globs follow Cargo matching", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "crates/.included"), { recursive: true });
    await mkdir(join(root, "crates/.excluded"));
    await writeFile(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/*excluded"]\n',
    );
    const member = '[package]\nname = "member"\nversion = "0.1.0"\n';
    await writeFile(join(root, "crates/.included/Cargo.toml"), member);
    await writeFile(join(root, "crates/.excluded/Cargo.toml"), member);
    await generateRustPolicy({
      root,
      input: { kind: "workspace" },
      mode: "write",
    });
    expect(await read(root, "crates/.included/Cargo.toml")).toMatchObject({
      lints: { workspace: true },
    });
    expect(
      await readFile(join(root, "crates/.excluded/Cargo.toml"), "utf8"),
    ).toBe(member);
    expect(
      await generateRustPolicy({
        root,
        input: { kind: "workspace" },
        mode: "check",
      }),
    ).toEqual([]);
  });
});

test("every glob-matched directory requires Cargo.toml even alongside valid members", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "crates/valid"), { recursive: true });
    await mkdir(join(root, "crates/missing"));
    const source = '[workspace]\nmembers = ["crates/*"]\n';
    const member = '[package]\nname = "valid"\nversion = "0.1.0"\n';
    await writeFile(join(root, "Cargo.toml"), source);
    await writeFile(join(root, "crates/valid/Cargo.toml"), member);
    await expect(
      generateRustPolicy({ root, input: { kind: "workspace" }, mode: "write" }),
    ).rejects.toThrow("missing workspace member manifest");
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(source);
    expect(await readFile(join(root, "crates/valid/Cargo.toml"), "utf8")).toBe(
      member,
    );
    expect(
      await readFile(join(root, "rustfmt.toml"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  });
});

test("retired member paths retain source provenance and reject symlink substitutions before writes", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "keep"));
    await mkdir(join(root, "retire"));
    const member = '[package]\nname = "member"\nversion = "0.1.0"\n';
    await writeFile(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["keep", "retire"]\n',
    );
    await writeFile(join(root, "keep/Cargo.toml"), member);
    await writeFile(join(root, "retire/Cargo.toml"), member);
    const input = { kind: "workspace" };
    await generateRustPolicy({ root, input, mode: "write" });
    const source = (await readFile(join(root, "Cargo.toml"), "utf8")).replace(
      /members = \[[^\]]*\]/u,
      'members = ["keep"]',
    );
    await writeFile(join(root, "Cargo.toml"), source);
    const keep = await readFile(join(root, "keep/Cargo.toml"), "utf8");
    await rm(join(root, "retire"), { recursive: true });
    await symlink(join(root, "keep"), join(root, "retire"));
    await expect(
      generateRustPolicy({ root, input, mode: "write" }),
    ).rejects.toThrow("real repository directory");
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(source);
    expect(await readFile(join(root, "keep/Cargo.toml"), "utf8")).toBe(keep);
  });
});

test("write-ahead member obligations recover interrupted enrollment before or after the member write", async () => {
  for (const enrollment of ["pending", "written"])
    await fixture(async (root) => {
      await mkdir(join(root, "keep"));
      await mkdir(join(root, "new"));
      const member = '[package]\nname = "member"\nversion = "0.1.0"\n';
      await writeFile(
        join(root, "Cargo.toml"),
        '[workspace]\nmembers = ["keep", "new"]\n',
      );
      await writeFile(join(root, "keep/Cargo.toml"), member);
      await writeFile(join(root, "new/Cargo.toml"), member);
      const input = { kind: "workspace" };
      await generateRustPolicy({ root, input, mode: "write" });
      // Keep the persisted union obligation but remove the new member from Cargo.
      const source = (await readFile(join(root, "Cargo.toml"), "utf8")).replace(
        /members = \[[^\]]*\]/u,
        'members = ["keep"]',
      );
      await writeFile(join(root, "Cargo.toml"), source);
      if (enrollment === "pending")
        await writeFile(join(root, "new/Cargo.toml"), member);
      expect(
        await generateRustPolicy({ root, input, mode: "check" }),
      ).toContain("Cargo.toml");
      await generateRustPolicy({ root, input, mode: "write" });
      expect(await read(root, "new/Cargo.toml")).not.toHaveProperty("lints");
      if (enrollment === "pending")
        expect(await readFile(join(root, "new/Cargo.toml"), "utf8")).toBe(
          member,
        );
      expect(await generateRustPolicy({ root, input, mode: "check" })).toEqual(
        [],
      );
    });
});

test("member ownership indexes reject noncanonical paths and cannot erase unowned inherited policy", async () => {
  await fixture(async (root) => {
    const original = await readFile(join(root, "Cargo.toml"), "utf8");
    for (const paths of [
      ["../other/Cargo.toml"],
      ["/other/Cargo.toml"],
      ["Cargo.toml"],
      ["other//Cargo.toml"],
      ["other/Cargo.toml", "other/Cargo.toml"],
    ]) {
      const source = `# stll-rust-policy-members-v1: ${JSON.stringify(paths)}\n${original}`;
      await writeFile(join(root, "Cargo.toml"), source);
      await expect(
        generateRustPolicy({ root, input: single, mode: "write" }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(source);
    }
    await mkdir(join(root, "unowned"));
    const unowned =
      '[package]\nname = "unowned"\nversion = "0.1.0"\n[lints]\nworkspace = true\n';
    await writeFile(join(root, "unowned/Cargo.toml"), unowned);
    const source = `# stll-rust-policy-members-v1: ["unowned/Cargo.toml"]\n${original}`;
    await writeFile(join(root, "Cargo.toml"), source);
    await expect(
      generateRustPolicy({ root, input: single, mode: "write" }),
    ).rejects.toThrow("retain its generated inheritance ownership");
    expect(await readFile(join(root, "unowned/Cargo.toml"), "utf8")).toBe(
      unowned,
    );
    expect(await readFile(join(root, "Cargo.toml"), "utf8")).toBe(source);
  });
});
