#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = process.env.PAPERCLIP_KUBERNETES_PLUGIN_ROOT
  ?? "/app/packages/plugins/sandbox-providers/kubernetes";
const expectedCommit = process.env.EXPECTED_PAPERCLIP_COMMIT;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`);
}

const packageJsonPath = path.join(pluginRoot, "package.json");
const distRoot = path.join(pluginRoot, "dist");
assertFile(packageJsonPath, "plugin package.json");
const packageJson = readJson(packageJsonPath);
assertFile(path.join(distRoot, "manifest.js"), "plugin manifest");
assertFile(path.join(distRoot, "worker.js"), "plugin worker");
assertFile(path.join(distRoot, "index.js"), "plugin index");
assertFile(path.join(pluginRoot, "node_modules"), "standalone plugin dependencies");

const sdkPackageJson = path.join(pluginRoot, "node_modules", "@paperclipai", "plugin-sdk", "package.json");
assertFile(sdkPackageJson, "resolved SDK package.json");
const sdk = readJson(sdkPackageJson);
if (!packageJson.dependencies?.["@paperclipai/plugin-sdk"]) {
  throw new Error("final plugin package does not declare its packaged SDK dependency");
}
const sourceSdkPackageJson = "/app/packages/plugins/sdk/package.json";
if (fs.existsSync(sourceSdkPackageJson)) {
  const sourceSdk = readJson(sourceSdkPackageJson);
  if (sourceSdk.version !== sdk.version) {
    throw new Error(`resolved SDK ${sdk.version} differs from source SDK ${sourceSdk.version}`);
  }
}

const manifest = (await import(pathToFileURL(path.join(distRoot, "manifest.js")).href)).default;
const plugin = (await import(pathToFileURL(path.join(distRoot, "index.js")).href)).plugin;
// Importing the worker exercises the final image's module resolution without
// starting its RPC host: runWorker only starts when worker.js is the entrypoint.
await import(pathToFileURL(path.join(distRoot, "worker.js")).href);

if (manifest.id !== "paperclip.kubernetes-sandbox-provider") {
  throw new Error(`unexpected plugin manifest id: ${manifest.id}`);
}
if (manifest.entrypoints?.worker !== "./dist/worker.js") {
  throw new Error(`unexpected worker entrypoint: ${manifest.entrypoints?.worker}`);
}
const requiredHandlers = [
  "onEnvironmentAcquireLease",
  "onEnvironmentExecute",
  "onEnvironmentDestroyLease",
  "onEnvironmentRealizeWorkspace",
];
if (!requiredHandlers.every((handler) => typeof plugin?.definition?.[handler] === "function")) {
  throw new Error("Kubernetes environment driver handlers did not load from the final image");
}

if (expectedCommit) {
  const buildInfoPath = "/app/server/dist/build-info.json";
  assertFile(buildInfoPath, "Paperclip build stamp");
  const buildInfo = readJson(buildInfoPath);
  if (buildInfo.commit !== expectedCommit) {
    throw new Error(`image build commit ${buildInfo.commit ?? "<missing>"} != ${expectedCommit}`);
  }
}

console.log(JSON.stringify({
  pluginRoot,
  manifestId: manifest.id,
  manifestVersion: manifest.version,
  worker: path.join(distRoot, "worker.js"),
  sdkVersion: sdk.version,
  sdkPackageJson,
  buildCommit: expectedCommit ?? null,
}));
