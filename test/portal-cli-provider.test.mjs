import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCliProviders } = require("../packages/portal/cli-provider.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcca-cli-provider-"));
}

function withPi(providers, run) {
  const file = path.join(tempRoot(), "models.json");
  fs.writeFileSync(file, JSON.stringify({ providers }));
  const previous = process.env.MCCA_PI_MODELS;
  process.env.MCCA_PI_MODELS = file;
  try { return run(); }
  finally {
    if (previous == null) delete process.env.MCCA_PI_MODELS;
    else process.env.MCCA_PI_MODELS = previous;
  }
}

test("the panel lists pi providers and their models without the key", () => {
  withPi({
    星辰: { api: "openai-completions", baseUrl: "https://example.test/v1", apiKey: "secret", models: [{ id: "a", name: "甲" }] },
  }, () => {
    const cli = createCliProviders({ root: tempRoot() });
    const rows = cli.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "星辰");
    assert.deepEqual(rows[0].models, [{ id: "a", name: "甲" }]);
    assert.equal(JSON.stringify(rows).includes("secret"), false);
  });
});

test("a chosen pi model is what a new window launches with", () => {
  withPi({
    local: { api: "openai-completions", baseUrl: "https://example.test/v1/", apiKey: "secret", models: [{ id: "m1", name: "M" }] },
  }, () => {
    const root = tempRoot();
    const cli = createCliProviders({ root });
    const saved = cli.select("openhands", "local", "m1");
    assert.equal(saved.ok, true);
    const launch = cli.launch("openhands");
    assert.deepEqual(launch.args, ["--override-with-envs"]);
    assert.equal(launch.env.LLM_MODEL, "openai/m1");
    assert.equal(launch.env.LLM_BASE_URL, "https://example.test/v1");
    assert.equal(launch.env.LLM_API_KEY, "secret");
    cli.select("codex", "local", "m1");
    const codex = cli.launch("codex");
    assert.deepEqual(codex.args.slice(0, 4), ["-m", "m1", "-c", 'model_provider="local"']);
    assert.ok(codex.args.includes('model_providers.local.base_url="https://example.test/v1"'));
    assert.ok(codex.args.includes('model_providers.local.wire_api="chat"'));
    assert.ok(codex.args.includes("model_providers.local.requires_openai_auth=false"));
    assert.ok(codex.args.includes('model_providers.local.experimental_bearer_token="secret"'));
    cli.select("hermes", "local", "m1");
    const hermes = cli.launch("hermes");
    assert.deepEqual(hermes.args, ["--provider", "local", "-m", "m1"]);
    const text = fs.readFileSync(path.join(root, "vendor", "cli", "hermes", "config.yaml"), "utf8");
    assert.match(text, /provider: "local"/);
    assert.match(text, /api: "https:\/\/example\.test\/v1"/);
  });
});

test("managing a provider writes the shared catalog and drops the key from the list", () => {
  withPi({}, () => {
    const cli = createCliProviders({ root: tempRoot() });
    const saved = cli.save("北窗", {
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      models: [{ id: "m1", name: "甲" }],
    });
    assert.equal(saved.ok, true);
    const rows = cli.list();
    assert.equal(rows[0].id, "北窗");
    assert.equal(rows[0].hasKey, true);
    assert.equal(JSON.stringify(rows).includes("secret"), false);
    assert.equal(cli.remove("北窗").ok, true);
    assert.deepEqual(cli.list(), []);
  });
});

test("an unknown model is refused and clearing returns to the cli default", () => {
  withPi({
    local: { api: "openai-completions", baseUrl: "https://example.test/v1", apiKey: "secret", models: [{ id: "m1" }] },
  }, () => {
    const cli = createCliProviders({ root: tempRoot() });
    assert.equal(cli.select("grok", "missing", "m1").ok, false);
    assert.equal(cli.select("grok", "local", "nope").ok, false);
    cli.select("grok", "local", "m1");
    assert.equal(cli.select("grok", "", "").ok, true);
    assert.deepEqual(cli.launch("grok"), { args: [], env: {} });
  });
});
