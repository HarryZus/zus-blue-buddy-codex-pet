#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PET_ID = "zus-blue-buddy";
const EXPECTED_WIDTH = 1536;
const EXPECTED_HEIGHT = 2288;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePetDir = join(packageRoot, "pet", PET_ID);

function usage() {
  console.log(`ZUS Blue Buddy installer

Usage:
  zus-blue-buddy-codex-pet [--no-select]
  zus-blue-buddy-codex-pet --check
  zus-blue-buddy-codex-pet --uninstall

Options:
  --no-select   Install without changing the selected Codex pet
  --check       Validate the packaged pet without installing it
  --uninstall   Move the installed pet to a recoverable removed folder
  --help        Show this help`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function webpSize(buffer) {
  if (
    buffer.length < 30 ||
    buffer.subarray(0, 4).toString() !== "RIFF" ||
    buffer.subarray(8, 12).toString() !== "WEBP"
  ) {
    throw new Error("spritesheet.webp is not a valid WebP file");
  }

  const kind = buffer.subarray(12, 16).toString();
  if (kind === "VP8X") {
    const width = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const height = buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
    return { width: width + 1, height: height + 1 };
  }

  if (kind === "VP8L") {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }

  if (kind === "VP8 ") {
    for (let index = 23; index < Math.min(60, buffer.length - 7); index += 1) {
      if (buffer[index] === 0x9d && buffer[index + 1] === 0x01 && buffer[index + 2] === 0x2a) {
        return {
          width: buffer.readUInt16LE(index + 3) & 0x3fff,
          height: buffer.readUInt16LE(index + 5) & 0x3fff,
        };
      }
    }
  }

  throw new Error("Could not read spritesheet.webp dimensions");
}

function validatePackage() {
  const metadataPath = join(sourcePetDir, "pet.json");
  const spritesheetPath = join(sourcePetDir, "spritesheet.webp");

  if (!existsSync(metadataPath) || !existsSync(spritesheetPath)) {
    throw new Error("Package is missing pet.json or spritesheet.webp");
  }

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.id !== PET_ID) throw new Error(`pet.json id must be ${PET_ID}`);
  if (metadata.spriteVersionNumber !== 2) throw new Error("spriteVersionNumber must be 2");
  if (metadata.spritesheetPath !== "spritesheet.webp") {
    throw new Error("spritesheetPath must be spritesheet.webp");
  }

  const size = webpSize(readFileSync(spritesheetPath));
  if (size.width !== EXPECTED_WIDTH || size.height !== EXPECTED_HEIGHT) {
    throw new Error(
      `Spritesheet must be ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}; found ${size.width}x${size.height}`,
    );
  }

  return metadata;
}

function upsertTomlKey(input, sectionName, key, value) {
  const newline = input.includes("\r\n") ? "\r\n" : "\n";
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const sectionPattern = new RegExp(`^\\s*\\[${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`);
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  let sectionStart = lines.findIndex((line) => sectionPattern.test(line));

  if (sectionStart === -1) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`[${sectionName}]`, `${key} = ${value}`, "");
    return lines.join(newline);
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const matches = [];
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (keyPattern.test(lines[index])) matches.push(index);
  }

  if (matches.length) {
    const indent = lines[matches[0]].match(/^\s*/)?.[0] ?? "";
    lines[matches[0]] = `${indent}${key} = ${value}`;
    for (let index = matches.length - 1; index > 0; index -= 1) lines.splice(matches[index], 1);
  } else {
    lines.splice(sectionEnd, 0, `${key} = ${value}`);
  }

  return lines.join(newline);
}

function removeMatchingTomlKey(input, sectionName, key, expectedValue) {
  const newline = input.includes("\r\n") ? "\r\n" : "\n";
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const sectionPattern = new RegExp(`^\\s*\\[${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*(?:#.*)?$`);
  const keyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*["']${expectedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*(?:#.*)?$`,
  );
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line));
  if (sectionStart === -1) return input;

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  for (let index = sectionEnd - 1; index > sectionStart; index -= 1) {
    if (keyPattern.test(lines[index])) lines.splice(index, 1);
  }
  return lines.join(newline);
}

function writeConfig(configPath, nextConfig) {
  const oldConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (nextConfig === oldConfig) return null;

  mkdirSync(dirname(configPath), { recursive: true });
  let backupPath = null;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.backup-${timestamp()}`;
    copyFileSync(configPath, backupPath);
  }
  writeFileSync(configPath, nextConfig, "utf8");
  return backupPath;
}

function codexHome() {
  return process.env.CODEX_PET_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
}

function install({ select }) {
  const metadata = validatePackage();
  const home = codexHome();
  const destination = join(home, "pets", PET_ID);
  const configPath = join(home, "config.toml");

  if (existsSync(destination)) {
    const backup = join(home, "pets", ".backups", `${PET_ID}-${timestamp()}`);
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(destination, backup, { recursive: true });
    console.log(`Backed up the previous pet to ${backup}`);
  }

  mkdirSync(destination, { recursive: true });
  copyFileSync(join(sourcePetDir, "pet.json"), join(destination, "pet.json"));
  copyFileSync(join(sourcePetDir, "spritesheet.webp"), join(destination, "spritesheet.webp"));

  let configBackup = null;
  if (select) {
    let config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    config = upsertTomlKey(config, "tui", "pet", `"${PET_ID}"`);
    config = upsertTomlKey(config, "desktop", "selected-avatar-id", `"custom:${PET_ID}"`);
    configBackup = writeConfig(configPath, config);
  }

  console.log(`Installed ${metadata.displayName} to ${destination}`);
  if (configBackup) console.log(`Backed up Codex settings to ${configBackup}`);
  console.log(select ? "Restart Codex to see your new pet." : "Select the pet in Codex when ready.");
}

function uninstall() {
  const home = codexHome();
  const destination = join(home, "pets", PET_ID);
  const configPath = join(home, "config.toml");
  let removedPath = null;

  if (existsSync(destination)) {
    removedPath = join(home, "pets", ".removed", `${PET_ID}-${timestamp()}`);
    mkdirSync(dirname(removedPath), { recursive: true });
    renameSync(destination, removedPath);
  }

  if (existsSync(configPath)) {
    let config = readFileSync(configPath, "utf8");
    config = removeMatchingTomlKey(config, "tui", "pet", PET_ID);
    config = removeMatchingTomlKey(config, "desktop", "selected-avatar-id", `custom:${PET_ID}`);
    const backup = writeConfig(configPath, config);
    if (backup) console.log(`Backed up Codex settings to ${backup}`);
  }

  if (removedPath) console.log(`Moved the pet to ${removedPath}`);
  else console.log("ZUS Blue Buddy was not installed.");
  console.log("Restart Codex to refresh the pet list.");
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) return usage();
  if (args.has("--check")) {
    const metadata = validatePackage();
    const size = statSync(join(sourcePetDir, "spritesheet.webp")).size;
    console.log(`Validated ${metadata.displayName}: ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}, ${size} bytes`);
    return;
  }
  if (args.has("--uninstall")) return uninstall();
  install({ select: !args.has("--no-select") });
}

try {
  main();
} catch (error) {
  console.error(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
