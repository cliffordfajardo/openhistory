import { listPackage } from "@electron/asar";
import {
  flipFuses,
  FuseV1Options,
  FuseVersion
} from "@electron/fuses";
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch as hostArchitecture } from "node:os";
import { resolve } from "node:path";

const PRODUCT_NAME = "OpenHistory Focus";
const BUNDLE_IDENTIFIER = "io.github.cliffordfajardo.openhistory-focus";
const root = resolve(import.meta.dirname, "..");
const architecture = hostArchitecture();
if (process.platform !== "darwin" || (architecture !== "arm64" && architecture !== "x64")) {
  throw new Error("Local OpenHistory Focus packaging supports ARM64 and Intel macOS hosts only");
}
const hostOnly = process.argv.includes("--host");
const signingIdentity = process.env.OPENHISTORY_FOCUS_SIGN_IDENTITY?.trim() || "-";

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};
const outputRoot = resolve(root, ".todesktop", "local");
const applicationPaths = await packager({
  dir: root,
  name: PRODUCT_NAME,
  platform: "darwin",
  arch: architecture,
  out: outputRoot,
  overwrite: true,
  asar: true,
  prune: true,
  appBundleId: BUNDLE_IDENTIFIER,
  appCategoryType: "public.app-category.productivity",
  appVersion: packageJson.version,
  buildVersion: packageJson.version,
  icon: resolve(root, "resources", "OpenHistory.icns"),
  extraResource: [
    resolve(root, "resources", "openhistory-icon.png"),
    resolve(root, "LICENSE"),
    resolve(root, "NOTICE")
  ],
  ignore: ignoreOutsideRuntimeAllowlist,
  osxSign: undefined
});

if (applicationPaths.length !== 1) {
  throw new Error(`Expected one local application but Electron Packager returned ${applicationPaths.length}`);
}
const packagedDirectory = applicationPaths[0];
const application = resolve(packagedDirectory, `${PRODUCT_NAME}.app`);
const nativeDirectory = resolve(application, "Contents", "Resources", "native");
if (hostOnly) {
  embedHostNativeComponents(nativeDirectory);
} else {
  const toDesktopArchitecture = architecture === "arm64" ? 3 : 1;
  const require = createRequire(import.meta.url);
  const afterPack = require("./todesktop-after-pack.cjs") as (context: object) => Promise<void>;
  await afterPack({
    appDir: root,
    appOutDir: packagedDirectory,
    arch: toDesktopArchitecture,
    pkgJson: packageJson,
    packager: { appInfo: { productFilename: PRODUCT_NAME } }
  });
}

const mainExecutable = resolve(application, "Contents", "MacOS", PRODUCT_NAME);
await flipFuses(mainExecutable, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
});

const nativeComponents = [
  "libOpenHistoryCollector.dylib",
  "openhistory-native.node",
  "foundation-model-worker"
].map((name) => resolve(nativeDirectory, name));
for (const component of nativeComponents) {
  execFileSync("codesign", ["--force", "--sign", signingIdentity, "--timestamp=none", component], {
    stdio: "inherit"
  });
}
execFileSync("codesign", ["--force", "--deep", "--sign", signingIdentity, "--timestamp=none", application], {
  stdio: "inherit"
});

verifyApplication(application);
process.stdout.write(`Local application ready: ${application}\n`);

function embedHostNativeComponents(destination: string): void {
  const hostDirectory = resolve(root, ".todesktop", "native", architecture);
  const sources: Record<string, string> = {
    "openhistory-native.node": resolve(hostDirectory, "openhistory-native.node"),
    "libOpenHistoryCollector.dylib": resolve(hostDirectory, "libOpenHistoryCollector.dylib"),
    "foundation-model-worker": resolve(
      hostDirectory,
      "OpenHistory Collector.app",
      "Contents",
      "MacOS",
      "foundation-model-worker"
    )
  };
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const [name, source] of Object.entries(sources)) {
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`Host native component is missing: ${name}. Run npm run package:native:release first.`);
    }
    cpSync(source, resolve(destination, name));
  }
}

function ignoreOutsideRuntimeAllowlist(candidate: string): boolean {
  const path = candidate.replaceAll("\\", "/");
  if (path === "" || path === "/package.json") return false;
  const allowedDirectory = ["/out", "/node_modules"].some(
    (directory) => path === directory || path.startsWith(`${directory}/`)
  );
  return !allowedDirectory;
}

function verifyApplication(applicationPath: string): void {
  const infoPlist = resolve(applicationPath, "Contents", "Info.plist");
  const bundleIdentifier = execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    infoPlist
  ], { encoding: "utf8" }).trim();
  if (bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new Error(`Unexpected local bundle identifier: ${bundleIdentifier}`);
  }

  for (const component of nativeComponents) {
    if (!statSync(component).isFile() || (statSync(component).mode & 0o111) === 0) {
      throw new Error(`Local package is missing native component: ${component}`);
    }
  }
  for (const notice of ["LICENSE", "NOTICE"]) {
    const path = resolve(applicationPath, "Contents", "Resources", notice);
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`Local package is missing ${notice}`);
    }
  }

  const asarPath = resolve(applicationPath, "Contents", "Resources", "app.asar");
  const entries = listPackage(asarPath, { isPack: false });
  const unexpectedTopLevels = new Set(
    entries
      .map((entry) => entry.replace(/^\//, "").split("/")[0])
      .filter((entry) => entry && !["node_modules", "out", "package.json"].includes(entry))
  );
  if (unexpectedTopLevels.size > 0) {
    throw new Error(`Unexpected files in local application ASAR: ${[...unexpectedTopLevels].join(", ")}`);
  }
  const privateEntries = entries.filter((entry) =>
    /(?:^|\/)(?:activity-data|\.audit|\.env(?:\.local)?|focus\.json|events-\d{4}-\d{2}-\d{2}\.jsonl)(?:\/|$)/.test(entry)
  );
  if (privateEntries.length > 0) {
    throw new Error(`Private or scratch data found in local application ASAR: ${privateEntries.slice(0, 5).join(", ")}`);
  }

  execFileSync("codesign", ["--verify", "--deep", "--strict", applicationPath], {
    stdio: "inherit"
  });
  execFileSync("plutil", ["-lint", infoPlist], { stdio: "inherit" });
}
