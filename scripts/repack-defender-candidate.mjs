// Controlled packaging experiment: preserve every byte of the released app.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require("electron-builder");
const builderRequire = createRequire(require.resolve("electron-builder"));
const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = libraryRequire("@electron/asar");
const payload = path.resolve(process.argv[2]);
const variant = process.argv[3];
if (!["normal", "store", "zip"].includes(variant)) throw new Error("Unknown experiment variant");
const project = path.resolve(`defender-repack-${variant}`);
await mkdir(project);
const archive = path.join(payload, "resources", "app.asar");
const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
await writeFile(path.join(project, "package.json"), JSON.stringify(metadata));
await writeFile(
  path.join(project, "icon.ico"),
  asar.extractFile(archive, "apps/desktop/prod-resources/icon.ico"),
);

async function inventory() {
  const result = {};
  for (const entry of await readdir(payload, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    result[path.relative(payload, file)] = hash.digest("hex");
  }
  return result;
}

const before = await inventory();
await build({
  projectDir: project,
  prepackaged: payload,
  targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
  publish: "never",
  config: {
    appId: "com.emanueledipietro.synara",
    productName: "Synara",
    electronVersion: "43.4.1",
    artifactName: `Synara-0.9.2-x64-${variant}.exe`,
    directories: { output: path.resolve(`defender-candidates/${variant}`) },
    compression: variant === "store" ? "store" : "normal",
    publish: null,
    win: { target: ["nsis"], icon: "icon.ico" },
    nsis: {
      guid: "368107a8-afe6-5db5-ab3b-d4f331684868",
      ...(variant === "zip" ? { useZip: true, differentialPackage: false } : {}),
    },
  },
});
const after = await inventory();
await writeFile(path.join(project, "payload-before.json"), JSON.stringify(before, null, 2));
await writeFile(path.join(project, "payload-after.json"), JSON.stringify(after, null, 2));
if (
  Object.keys(before).length !== Object.keys(after).length ||
  Object.entries(before).some(([file, hash]) => after[file] !== hash)
) {
  throw new Error("Repackaging changed the released application payload.");
}
