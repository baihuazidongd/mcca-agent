"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const file = path.join(os.tmpdir(), `mcca-pi-models-${process.pid}.json`);
fs.writeFileSync(file, JSON.stringify({
  providers: {
    demo: {
      api: "openai-responses",
      baseUrl: "https://example.com/v1/",
      apiKey: "secret-key",
      models: [{ id: "gpt-x", name: "GPT X", reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: null } }],
    },
  },
}));
process.env.MCCA_PI_MODELS = file;
const pi = require("../pi-providers.cjs");

test("catalog and overlay use the pi provider file", () => {
  const groups = pi.catalogGroups();
  assert.equal(groups[0].id, "demo");
  assert.equal(groups[0].models[0].id, "gpt-x");
  assert.deepEqual(groups[0].models[0].efforts, ["off", "low", "medium"]);
  const view = JSON.stringify(pi.publicProviders());
  assert.equal(view.includes("secret-key"), false);
  assert.equal(pi.publicProviders()[0].entry.hasKey, true);
  const overlay = pi.codexOverlay("demo");
  assert.equal(overlay.model_providers.demo.base_url, "https://example.com/v1");
  assert.equal(overlay.model_providers.demo.wire_api, "responses");
  assert.equal(overlay.model_providers.demo.experimental_bearer_token, "secret-key");
  assert.equal(overlay.model_providers.demo.requires_openai_auth, false);
  fs.rmSync(file, { force: true });
});
