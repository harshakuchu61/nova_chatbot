import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const iconsDir = path.join(tauriRoot, "icons");
const sourceSvg = path.join(__dirname, "source.svg");
const sourcePng = path.join(__dirname, "source.png");

if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

const svgBuffer = readFileSync(sourceSvg);

await sharp(svgBuffer).resize(1024, 1024).png().toFile(sourcePng);
console.log(`Generated source PNG at ${sourcePng}`);

const cliPath = path.join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const cmd = existsSync(cliPath)
  ? `node "${cliPath}" icon "${sourcePng}"`
  : `npx --yes @tauri-apps/cli icon "${sourcePng}"`;

execSync(cmd, { cwd: desktopRoot, stdio: "inherit" });
console.log("Tauri icons generated under src-tauri/icons.");
