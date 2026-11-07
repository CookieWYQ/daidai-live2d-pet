const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/main/main.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/app.js",
  "src/renderer/vendor/pixi.min.js",
  "src/renderer/vendor/live2d.min.js",
  "src/renderer/vendor/cubism2.min.js",
  "src/renderer/vendor/cubism4.min.js"
];

let ok = true;
for (const relative of requiredFiles) {
  const file = path.join(root, relative);
  if (fs.existsSync(file)) {
    console.log(`[ok] ${relative}`);
  } else {
    ok = false;
    console.error(`[missing] ${relative}`);
  }
}

process.exitCode = ok ? 0 : 1;
