import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const clientDir = join(import.meta.dirname, "..", "build", "client");
const laborDir = join(clientDir, "labor");

if (!existsSync(clientDir)) {
  console.error("build/client not found — run react-router build first");
  process.exit(1);
}

mkdirSync(laborDir, { recursive: true });

for (const dir of ["assets", ".vite"]) {
  const src = join(clientDir, dir);
  if (existsSync(src)) {
    cpSync(src, join(laborDir, dir), { recursive: true });
    console.log(`  ✓ Copied ${dir}/ → labor/${dir}/`);
  }
}

console.log("  ✓ Asset fix complete — labor/ subdirectory ready for Cloudflare");
