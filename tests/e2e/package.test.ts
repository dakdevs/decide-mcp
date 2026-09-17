import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);

test("npm tarball installs independently and exposes a working MCP executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decide-package-"));
  const client = new Client({ name: "package-test", version: "1.0.0" });
  let transport: StdioClientTransport | undefined;
  try {
    const packed = await exec(
      "npm",
      ["pack", "--json", "--pack-destination", directory],
      { cwd: resolve(import.meta.dir, "../..") },
    );
    const manifest = JSON.parse(packed.stdout) as {
      filename: string;
      files: { path: string }[];
    }[];
    const files = manifest[0]!.files.map((file) => file.path);
    expect(files).toContain("dist/cli.js");
    expect(files).toContain("license.md");
    expect(
      files.some(
        (file) =>
          file.startsWith("src/") ||
          file.startsWith("tests/") ||
          file.includes(".env"),
      ),
    ).toBe(false);
    await exec(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        join(directory, manifest[0]!.filename),
      ],
      { cwd: directory },
    );
    const executable = join(directory, "node_modules/.bin/decide-mcp");
    const metadata = JSON.parse(
      await readFile(
        join(directory, "node_modules/decide-mcp/package.json"),
        "utf8",
      ),
    );
    expect(metadata.private).not.toBe(true);
    expect(
      (await exec(executable, ["--version"], { cwd: directory })).stdout.trim(),
    ).toBe(metadata.version);
    expect(
      (await exec(executable, ["--help"], { cwd: directory })).stdout,
    ).toContain("MCP over stdio");
    transport = new StdioClientTransport({
      command: executable,
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "decide",
    ]);
  } finally {
    await client.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
