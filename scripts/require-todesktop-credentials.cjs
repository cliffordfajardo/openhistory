const required = ["TODESKTOP_EMAIL", "TODESKTOP_ACCESS_TOKEN", "OPENHISTORY_FOCUS_TODESKTOP_ID"];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error(`Missing ToDesktop environment variables: ${missing.join(", ")}`);
  console.error("Provide credentials and the fork-owned ToDesktop app ID through the environment; this repository never stores them.");
  console.error("OpenHistory Focus must never build or release under the upstream OpenHistory ToDesktop app.");
  process.exitCode = 1;
}
