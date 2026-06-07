#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const part = process.argv[2];
if (part !== "patch" && part !== "minor" && part !== "major") {
  console.error("Usage: bun scripts/bump-version.mjs patch|minor|major");
  process.exit(1);
}

const pkgPath = new URL("../package.json", import.meta.url).pathname;
const src = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(src);

const [ma, mi, pa] = pkg.version.split(".").map(Number);
const next =
  part === "major" ? `${ma + 1}.0.0` :
  part === "minor" ? `${ma}.${mi + 1}.0` :
                     `${ma}.${mi}.${pa + 1}`;

const prev = pkg.version;
pkg.version = next;

// Preserve original indentation style
const indent = src.match(/^{\n(\s+)/)?.[1] ?? "  ";
writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + "\n");

execSync(`git add ${pkgPath}`, { stdio: "inherit" });
execSync(`git commit -m "chore: bump version to ${next}"`, { stdio: "inherit" });
execSync(`git tag v${next}`, { stdio: "inherit" });

console.log(`\n  ${prev} → ${next}  (tagged v${next})\n`);
