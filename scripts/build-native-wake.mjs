import { spawnSync } from "node:child_process";
if (process.platform === "darwin") {
  const result = spawnSync("/bin/zsh", ["scripts/build-wake-helper.sh"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
console.log("Windows wake listener uses built-in PowerShell and System.Speech");
