/*
 * `npm version <x.y.z>` 的時候跟著更新 manifest.json 與 versions.json。
 *
 * versions.json 的用途：讓舊版 Obsidian 的使用者裝到「還支援他那版」的最後一版，
 * 而不是裝到新版然後壞掉。所以只有在 minAppVersion 真的往上調時才需要新增一筆，
 * 但每一版都寫進去最省事，也不會出錯。
 */
import { readFileSync, writeFileSync } from "fs";

const target = process.env.npm_package_version;
if (!target) {
  console.error("這支要由 npm version 呼叫（需要 npm_package_version）");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log("manifest.json 與 versions.json 已更新為 " + target + "（minAppVersion " + minAppVersion + "）");
