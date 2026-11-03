// Rasterizes the master SVGs in assets/icon/ into assets/icon/build/ and
// packs the app icons into build/ (icon.icns for macOS, icon.ico for Windows).
// Rendered in headless Chromium because the art relies on mix-blend-mode,
// isolation and feDropShadow, which most SVG rasterizers get wrong.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = path.join(ROOT, "assets", "icon");
const OUT_DIR = path.join(ICON_DIR, "build");
const APP_DIR = path.join(ROOT, "build");

// Desktop app first; the web favicons and manifest icons get added here later.
const TARGETS = [
  { src: "icon-tan.svg", out: "icon-1024.png", size: 1024 },
  // Dock icon while developing; the packaged app uses icon.icns instead.
  { src: "icon-macos.svg", out: "icon-macos-1024.png", size: 1024 },
];

// Standard macOS iconset: each point size at 1x and 2x.
const ICNS_SIZES = [16, 32, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function render(page, svgFile, size) {
  const svg = readFileSync(path.join(ICON_DIR, svgFile), "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  return page.screenshot({ omitBackground: true });
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function packIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((img) => img.png)]);
}

function report(file) {
  console.log(`${path.relative(ROOT, file)}  ${(statSync(file).size / 1024).toFixed(1)} KB`);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(APP_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  for (const { src, out, size } of TARGETS) {
    const outFile = path.join(OUT_DIR, out);
    writeFileSync(outFile, await render(page, src, size));
    report(outFile);
  }

  if (process.platform === "darwin") {
    const iconset = path.join(mkdtempSync(path.join(os.tmpdir(), "stem-icon-")), "icon.iconset");
    mkdirSync(iconset);
    for (const size of ICNS_SIZES) {
      writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), await render(page, "icon-macos.svg", size));
      writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), await render(page, "icon-macos.svg", size * 2));
    }
    const icns = path.join(APP_DIR, "icon.icns");
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
    rmSync(path.dirname(iconset), { recursive: true, force: true });
    report(icns);
  } else {
    console.log("skipping icon.icns (iconutil needs macOS)");
  }

  const icoImages = [];
  for (const size of ICO_SIZES) icoImages.push({ size, png: await render(page, "icon-tan.svg", size) });
  const ico = path.join(APP_DIR, "icon.ico");
  writeFileSync(ico, packIco(icoImages));
  report(ico);
} finally {
  await browser.close();
}
