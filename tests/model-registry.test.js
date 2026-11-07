const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createModelRegistry,
  findLive2dModelFile,
  modelKindFromFile,
  safeId
} = require("../src/main/model-registry");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "daidai-live2d-pet-"));
}

test("findLive2dModelFile prefers model3 json", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "avatar.model.json"), "{}", "utf8");
  fs.writeFileSync(path.join(dir, "avatar.model3.json"), "{}", "utf8");

  const modelFile = findLive2dModelFile(dir);

  assert.equal(path.basename(modelFile), "avatar.model3.json");
  assert.equal(modelKindFromFile(modelFile), "cubism3+");
});

test("registry imports a model directory into userData", () => {
  const source = tempDir();
  const textureDir = path.join(source, "textures");
  fs.mkdirSync(textureDir);
  fs.writeFileSync(path.join(source, "demo.model3.json"), "{}", "utf8");
  fs.writeFileSync(path.join(textureDir, "texture_00.png"), "fake", "utf8");

  const userDataDir = tempDir();
  const registry = createModelRegistry({ userDataDir });
  const record = registry.importDirectory(source);

  assert.equal(record.kind, "cubism3+");
  assert.ok(fs.existsSync(record.modelPath));
  assert.ok(fs.existsSync(path.join(record.directory, "textures", "texture_00.png")));
  assert.equal(registry.list().length, 1);
});

test("safeId strips unsafe characters", () => {
  assert.equal(safeId(" My Live2D Model! "), "my-live2d-model");
});
