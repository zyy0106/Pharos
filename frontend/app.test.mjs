import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
  contains() { return false; }
}

class FakeElement {
  constructor({ value = "", checked = false } = {}) {
    this.value = value;
    this.checked = checked;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.innerHTML = "";
    this.dataset = {};
    this.classList = new FakeClassList();
  }

  addEventListener() {}
  setAttribute() {}
  focus() {}
  click() {}
  scrollIntoView() {}
  querySelector() { return new FakeElement(); }
  querySelectorAll() { return []; }
  insertAdjacentHTML() {}
}

async function loadApp() {
  const elements = new Map();
  const values = {
    "#problemTitle": "测试赛题",
    "#problemBrief": "测试背景与目标",
    "#outputDir": "runs/ui-latest",
    "#threadId": "default",
    "#iterationDepth": "3",
  };
  const checked = new Set(["#ragToggle", "#hitlToggle"]);

  const document = {
    body: new FakeElement(),
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, new FakeElement({
          value: values[selector] ?? "",
          checked: checked.has(selector),
        }));
      }
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    addEventListener() {},
    clearTimeout() {},
    setTimeout() { return 1; },
    location: { hash: "#workspace" },
  };
  const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
  const context = {
    console,
    document,
    window,
    EventSource: class {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ onboarding: { needed: false }, fixtures: 0 }),
    }),
    setTimeout() { return 1; },
    clearTimeout() {},
  };

  runInNewContext(
    `${source}\nglobalThis.__appTest = { handleRunEnd };`,
    context,
    { filename: "frontend/app.js" },
  );

  return {
    handleRunEnd: context.__appTest.handleRunEnd,
    artifactPreview: elements.get("#artifactPreview"),
    forceToggle: elements.get("#forceToggle"),
  };
}

test("失败任务在结果卡片中显示重新运行按钮", async () => {
  const { handleRunEnd, artifactPreview } = await loadApp();

  handleRunEnd({
    status: "failed",
    recoverable: false,
    log: "injected failure",
  });

  assert.match(artifactPreview.innerHTML, /id="retryRun"/);
  assert.match(artifactPreview.innerHTML, />重新运行</);
});

test("可恢复的失败任务同时显示 checkpoint 恢复与重新运行按钮", async () => {
  const { handleRunEnd, artifactPreview } = await loadApp();

  handleRunEnd({
    status: "failed",
    recoverable: true,
    log: "recoverable failure",
  });

  assert.match(artifactPreview.innerHTML, /id="recoverRun"/);
  assert.match(artifactPreview.innerHTML, /id="retryRun"/);
});

test("恢复达到安全上限后仍显示重新运行按钮", async () => {
  const { handleRunEnd, artifactPreview, forceToggle } = await loadApp();

  handleRunEnd({
    status: "blocked",
    recoverable: false,
    log: "same node failed 3 times",
  });

  assert.doesNotMatch(artifactPreview.innerHTML, /id="recoverRun"/);
  assert.match(artifactPreview.innerHTML, /id="retryRun"/);
  assert.equal(forceToggle.checked, true);
});
