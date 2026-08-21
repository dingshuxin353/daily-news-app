import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileThemeCss,
  createThemeDefinition,
} from "../scripts/lib/theme-compiler.js";
import {
  activateTheme,
  listThemes,
  processTheme,
  rollbackTheme,
  switchTheme,
  validateActiveTheme,
  validateConfiguredTheme,
  validateThemeStressFixture,
} from "../scripts/lib/theme-pipeline.js";
import {
  ThemeValidationError,
  loadPreset,
  resolveThemeCandidate,
  validateThemeCandidate,
  validateThemeReadability,
} from "../scripts/lib/theme-validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const target = await mkdtemp(path.join(os.tmpdir(), "daily-news-theme-"));
  for (const entry of ["config", "data", "themes"]) {
    await cp(path.join(rootDir, entry), path.join(target, entry), { recursive: true });
  }
  return target;
}

function candidate(id = "custom-editorial") {
  return {
    schemaVersion: 1,
    id,
    name: "自定义编辑主题",
    description: "用于自动化测试的安全主题候选。",
    extends: "swiss-editorial",
    tokens: {
      colors: { accent: "#A52A1A" },
      density: "balanced",
    },
    recipes: { lead: "stacked" },
  };
}

async function writeCandidate(target, value) {
  const filePath = path.join(target, "themes", "candidates", `${value.id}.json`);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

test("三个官方 Preset 完整解析并通过可读性校验", async () => {
  for (const id of ["newspaper-default", "swiss-editorial", "midnight-tech"]) {
    const preset = await loadPreset(rootDir, id);
    assert.equal(preset.id, id);
    assert.equal(Object.keys(preset.tokens.colors).length, 5);
    assert.equal(Object.keys(preset.recipes).length, 4);
    assert.equal(validateThemeReadability(preset), preset);
  }
});

test("候选严格拒绝未知字段、任意 CSS、远程资源和非法 Recipe", async () => {
  const target = await fixture();
  const value = candidate();
  value.css = "body { display: none }";
  let filePath = await writeCandidate(target, value);
  await assert.rejects(() => validateThemeCandidate(filePath), /\.css.*不是允许的主题字段/);

  delete value.css;
  value.tokens.colors.background = "url(https://example.com/a.png)";
  await writeCandidate(target, value);
  await assert.rejects(() => validateThemeCandidate(filePath), /六位十六进制颜色/);

  value.tokens.colors.background = "#FFFFFF";
  value.recipes.lead = "free-layout";
  await writeCandidate(target, value);
  await assert.rejects(() => validateThemeCandidate(filePath), /recipes\.lead.*只能是/);
});

test("候选只能位于 themes/candidates，且低对比度与循环继承会被拒绝", async () => {
  const target = await fixture();
  const value = candidate();
  value.tokens.colors = { background: "#FFFFFF", text: "#EEEEEE", muted: "#DDDDDD" };
  const candidatePath = await writeCandidate(target, value);
  await assert.rejects(() => resolveThemeCandidate(target, candidatePath), /对比度.*低于 4\.5:1/);

  const outsidePath = path.join(target, `${value.id}.json`);
  await writeFile(outsidePath, JSON.stringify(candidate()), "utf8");
  await assert.rejects(() => resolveThemeCandidate(target, outsidePath), /必须位于 themes\/candidates/);

  const presetsDir = path.join(target, "themes", "presets");
  const first = { ...candidate("cycle-a"), extends: "cycle-b" };
  const second = { ...candidate("cycle-b"), extends: "cycle-a" };
  await writeFile(path.join(presetsDir, "cycle-a.json"), JSON.stringify(first), "utf8");
  await writeFile(path.join(presetsDir, "cycle-b.json"), JSON.stringify(second), "utf8");
  await assert.rejects(() => loadPreset(target, "cycle-a"), /继承存在循环/);
});

test("与父 Preset 语义相同的字段不算实际覆盖", async () => {
  const target = await fixture();
  const value = candidate();
  value.tokens = { density: "compact" };
  value.recipes = { lead: "editorial" };
  const candidatePath = await writeCandidate(target, value);
  await assert.rejects(() => resolveThemeCandidate(target, candidatePath), /必须实际改变/);
});

test("Theme Compiler 对相同输入生成稳定 CSS 并记录版本元数据", async () => {
  const preset = await loadPreset(rootDir, "midnight-tech");
  const first = compileThemeCss(preset, 3);
  const second = compileThemeCss(structuredClone(preset), 3);
  assert.equal(first, second);
  assert.match(first, /schemaVersion=1.*id=midnight-tech.*revision=3.*compiler=1/);
  assert.doesNotMatch(first, /@import|url\(|https?:\/\//);
  assert.equal(createThemeDefinition(preset, 3).revision, 3);
});

test("预览不修改 Active；激活必须明确确认且过期预览不能使用", async () => {
  const target = await fixture();
  const value = candidate();
  const candidatePath = await writeCandidate(target, value);
  const activePath = path.join(target, "themes", "active.json");
  const activeBefore = await readFile(activePath, "utf8");

  const preview = await processTheme(target, candidatePath);
  assert.equal(preview.result, "preview-ready");
  assert.equal(await readFile(activePath, "utf8"), activeBefore);
  assert.equal((await processTheme(target, candidatePath)).result, "unchanged");
  await assert.rejects(() => activateTheme(target, value.id), /必须使用 --confirm/);

  value.tokens.density = "spacious";
  await writeCandidate(target, value);
  await assert.rejects(
    () => activateTheme(target, value.id, { confirm: value.id }),
    /预览不存在、已过期/,
  );
  assert.equal(await readFile(activePath, "utf8"), activeBefore);
});

test("激活按语义维护 Revision，且可回滚到上一已激活版本", async () => {
  const target = await fixture();
  const value = candidate();
  const candidatePath = await writeCandidate(target, value);
  await processTheme(target, candidatePath);
  const first = await activateTheme(target, value.id, { confirm: value.id });
  assert.deepEqual({ result: first.result, revision: first.revision }, { result: "activated", revision: 1 });
  assert.equal((await validateConfiguredTheme(target)).themeId, value.id);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, "config", "theme.json"), "utf8")).activeTheme,
    { id: value.id, revision: 1 },
  );
  assert.equal((await activateTheme(target, value.id, { confirm: value.id })).result, "unchanged");

  value.recipes.normal = "compact";
  await writeCandidate(target, value);
  await processTheme(target, candidatePath);
  const second = await activateTheme(target, value.id, { confirm: value.id });
  assert.equal(second.revision, 2);

  const rollback = await rollbackTheme(target, { confirm: true });
  assert.deepEqual(
    { result: rollback.result, themeId: rollback.themeId, revision: rollback.revision },
    { result: "rolled-back", themeId: value.id, revision: 1 },
  );
  assert.equal((await validateConfiguredTheme(target)).revision, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, "config", "theme.json"), "utf8")).activeTheme,
    { id: value.id, revision: 1 },
  );
});

test("主题库列出三个官方主题，并可在没有 Candidate 时切换已有主题", async () => {
  const target = await fixture();
  const catalog = await listThemes(target);
  assert.deepEqual(catalog.activeTheme, { id: "newspaper-default", revision: 1 });
  assert.deepEqual(
    catalog.themes.map(({ id, latestRevision, revisions }) => ({ id, latestRevision, revisions })),
    [
      { id: "midnight-tech", latestRevision: 1, revisions: [1] },
      { id: "newspaper-default", latestRevision: 1, revisions: [1] },
      { id: "swiss-editorial", latestRevision: 1, revisions: [1] },
    ],
  );

  const definitionsBefore = await readdir(path.join(target, "themes", "definitions", "swiss-editorial"));
  await assert.rejects(() => switchTheme(target, "swiss-editorial"), /必须使用 --confirm/);
  const switched = await switchTheme(target, "swiss-editorial", { confirm: "swiss-editorial" });
  assert.deepEqual(
    { result: switched.result, themeId: switched.themeId, revision: switched.revision },
    { result: "switched", themeId: "swiss-editorial", revision: 1 },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, "config", "theme.json"), "utf8")).activeTheme,
    { id: "swiss-editorial", revision: 1 },
  );
  assert.equal((await validateConfiguredTheme(target)).themeId, "swiss-editorial");
  assert.deepEqual(
    await readdir(path.join(target, "themes", "definitions", "swiss-editorial")),
    definitionsBefore,
  );
  assert.equal(
    (await switchTheme(target, "swiss-editorial", { confirm: "swiss-editorial" })).result,
    "unchanged",
  );
});

test("主题切换支持指定历史 Revision，失败时保持配置和 Active 不变", async () => {
  const target = await fixture();
  const value = candidate();
  const candidatePath = await writeCandidate(target, value);
  await processTheme(target, candidatePath);
  await activateTheme(target, value.id, { confirm: value.id });

  value.recipes.normal = "compact";
  await writeCandidate(target, value);
  await processTheme(target, candidatePath);
  await activateTheme(target, value.id, { confirm: value.id });

  await switchTheme(target, "newspaper-default", { confirm: "newspaper-default" });
  const latest = await switchTheme(target, value.id, { confirm: value.id });
  assert.deepEqual(
    { result: latest.result, revision: latest.revision },
    { result: "switched", revision: 2 },
  );

  const historical = await switchTheme(target, value.id, { revision: 1, confirm: value.id });
  assert.deepEqual(
    { result: historical.result, revision: historical.revision },
    { result: "switched", revision: 1 },
  );

  const activePath = path.join(target, "themes", "active.json");
  const configPath = path.join(target, "config", "theme.json");
  const activeBefore = await readFile(activePath, "utf8");
  const configBefore = await readFile(configPath, "utf8");
  await assert.rejects(
    () => switchTheme(target, "not-installed", { confirm: "not-installed" }),
    /Theme Revision 不存在/,
  );
  await assert.rejects(
    () => switchTheme(target, value.id, { revision: 99, confirm: value.id }),
    /Theme Revision 不存在/,
  );
  assert.equal(await readFile(activePath, "utf8"), activeBefore);
  assert.equal(await readFile(configPath, "utf8"), configBefore);
});

test("主题配置与 Active 不一致时拒绝启动和构建使用", async () => {
  const target = await fixture();
  const configPath = path.join(target, "config", "theme.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.activeTheme.id = "swiss-editorial";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await assert.rejects(() => validateConfiguredTheme(target), /与 Active Theme 不一致/);
});

test("固定压力测试覆盖所有行型、多来源、无分类和未填满末行", async () => {
  const result = await validateThemeStressFixture(rootDir);
  assert.deepEqual(result.signatures, ["L", "MM", "MSS", "SSSS", "SS"]);
});

test("Active Pointer 不能指向远程或非对应 Revision 的 CSS", async () => {
  const target = await fixture();
  const activePath = path.join(target, "themes", "active.json");
  const active = JSON.parse(await readFile(activePath, "utf8"));
  active.cssPath = "https://example.com/theme.css";
  await writeFile(activePath, JSON.stringify(active), "utf8");
  await assert.rejects(() => validateActiveTheme(target), /active\.cssPath.*受控编译产物/);
});

test("没有 Active Theme 时返回空指针，由前端回退站点强调色", async () => {
  const target = await fixture();
  await unlink(path.join(target, "themes", "active.json"));
  assert.equal(await validateActiveTheme(target), null);
});
