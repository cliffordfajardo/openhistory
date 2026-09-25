const config = {
  schemaVersion: 1,
  id: process.env.OPENHISTORY_FOCUS_TODESKTOP_ID?.trim() ?? "",
  appId: "io.github.cliffordfajardo.openhistory-focus",
  productName: "OpenHistory Focus",
  icon: "./resources/OpenHistory.icns",
  appPath: ".",
  packageManager: "npm",
  nodeVersion: "22.19.0",
  npmVersion: "10.9.3",
  asar: true,
  fuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableCookieEncryption: true,
    onlyLoadAppFromAsar: true
  },
  appFiles: [
    "out/**",
    "!out/**/.DS_Store",
    ".todesktop/native/universal/**",
    "scripts/todesktop-before-build.cjs",
    "scripts/todesktop-after-pack.cjs",
    "todesktop.ts",
    "LICENSE",
    "NOTICE"
  ],
  filesForDistribution: [
    "!.todesktop/**",
    "!native/**",
    "!scripts/**",
    "!resources/**",
    "!todesktop.ts"
  ],
  extraResources: [
    {
      from: "./resources/openhistory-icon.png"
    },
    {
      from: "./LICENSE"
    },
    {
      from: "./NOTICE"
    }
  ],
  mac: {
    category: "public.app-category.productivity",
    extendInfo: {
      NSScreenCaptureUsageDescription:
        "OpenHistory Focus reads the screen only while an optional grayscale Focus reminder is showing, to display it in gray. Frames stay in memory and are never saved or sent."
    }
  }
};

export default config;
