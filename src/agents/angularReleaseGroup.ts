import { readFile } from "node:fs/promises";
import path from "node:path";
import { gt, major, minVersion, minor, prerelease, valid } from "semver";
import { z } from "zod";

import type { DependabotAlert } from "../types.js";

// Angular CLI, devkit and Material have independent release schedules.
const frameworkPackages = new Set([
  "@angular/animations", "@angular/common", "@angular/compiler", "@angular/compiler-cli",
  "@angular/core", "@angular/elements", "@angular/forms", "@angular/localize",
  "@angular/platform-browser", "@angular/platform-browser-dynamic", "@angular/platform-server",
  "@angular/router", "@angular/service-worker", "@angular/upgrade"
]);

const versions = z.record(z.string(), z.string());

export async function planAngularReleaseGroupUpdate(
  directory: string,
  alerts: DependabotAlert[]
): Promise<string[]> {
  const targets = alerts.filter(alert => frameworkPackages.has(alert.dependencyName) && alert.patchedVersion);
  if (targets.length === 0) return [];

  const manifest = z.object({
    dependencies: versions.optional(),
    devDependencies: versions.optional()
  }).parse(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")));
  const direct = { ...manifest.dependencies, ...manifest.devDependencies };
  const members = Object.keys(direct).filter(name => frameworkPackages.has(name));
  if (!targets.some(alert => members.includes(alert.dependencyName))) return [];

  // Do not rewrite aliases, workspace protocols or complex repository version policies.
  if (members.some(name => !/^[~^]?\d+\.\d+\.\d+$/.test(direct[name] ?? ""))) {
    throw new Error("Angular release-group update requires plain, caret or tilde dependency versions; manual review required");
  }
  const lock = z.object({
    packages: z.record(z.string(), z.object({ version: z.string().optional() }))
  }).parse(JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8")));
  const installed = members.map(name => lock.packages[`node_modules/${name}`]?.version);
  const patched = targets.map(alert => alert.patchedVersion);
  const declared = members.map(name => minVersion(direct[name] ?? "")?.version);
  const candidates = [...installed, ...patched, ...declared];
  if (candidates.some(version => !version || !valid(version) || prerelease(version))) {
    throw new Error("Angular release-group update requires stable, valid installed and patched versions; manual review required");
  }
  const stable = z.array(z.string()).parse(candidates);
  const first = stable[0];
  if (!first) return [];
  if (stable.some(version => major(version) !== major(first) || minor(version) !== minor(first))) {
    throw new Error("Angular release-group update would cross a major/minor boundary; manual review required");
  }
  const target = stable.reduce((highest, version) => gt(version, highest) ? version : highest);
  if (installed.every(version => version === target)) return [];

  return members.map(name => `${name}@${target}`);
}
