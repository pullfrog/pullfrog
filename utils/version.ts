import { isValid } from "verkit";
import packageJson from "../package.json" with { type: "json" };

export function getDevDependencyVersion(name: keyof typeof packageJson.devDependencies): string {
  const version = packageJson.devDependencies[name];
  if (!isValid(version)) {
    throw new Error(`dev dependency "${name}" must be a pinned version, got "${version}"`);
  }
  return version;
}
