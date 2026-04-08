import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url = .../scripts/sync-cloudflare-functions.mjs → .. = 仓库根目录
const root = fileURLToPath(new URL("..", import.meta.url));
const src = path.join(root, "apps/website/functions");
const dest = path.join(root, "functions");

if (!fs.existsSync(src)) {
  console.warn("sync-cloudflare-functions: skip (no apps/website/functions)");
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log("sync-cloudflare-functions: copied to ./functions (for Pages root = repo root)");
