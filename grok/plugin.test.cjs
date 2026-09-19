const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const pluginPath = join(__dirname, "plugin.js");

function load(host) {
  const source = readFileSync(pluginPath, "utf8");
  const context = { host, module: { exports: {} }, exports: {} };
  new vm.Script(source, { filename: pluginPath }).runInNewContext(context);
  return context.module.exports.default;
}

function hostFor(over = {}) {
  const files = over.files || {};
  const dirs = over.dirs || {};
  return {
    homeDir: () => "/tmp/home",
    platform: () => over.platform || "linux",
    unixNowMs: () => over.nowMs || 1_000_000,
    credentialPublic: () => null,
    fetch: () => JSON.stringify({ status: 503 }),
    manifestJson: () => JSON.stringify({
      models: [{ id: "grok-4.6", displayName: "Grok 4.6", group: "xAI" }],
    }),
    exec: () => JSON.stringify({ code: 127, stdout: "" }),
    path: {
      toNative: (p) => (over.platform === "windows" ? String(p).replace(/\//g, "\\") : p),
    },
    shell: {
      quoteFor: (v) => `'${v}'`,
    },
    fs: {
      fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p) || Object.prototype.hasOwnProperty.call(dirs, p),
      readJson: (p) => {
        const value = files[p];
        if (value == null || typeof value === "string") return null;
        return value;
      },
      readFile: (p) => (typeof files[p] === "string" ? files[p] : null),
      readDir: (p) => dirs[p] || [],
    },
    ...over.host,
  };
}

const tests = [
  ["manifest versions agree with channel", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
    const entry = JSON.parse(readFileSync(join(__dirname, "..", "channel.json"), "utf8"))
      .plugins.find((item) => item.id === "grok");
    assert.equal(manifest.id, "grok");
    assert.equal(manifest.binaryName, "grok");
    assert.equal(manifest.cliBinary, "grok");
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, entry.version);
    assert.equal(manifest.minCodeterm, "1.11.4");
    assert.equal(manifest.minCodeterm, entry.minCodeterm);
    assert.deepEqual(manifest.commands.autoApproveFlags, ["--always-approve"]);
    assert.equal(manifest.spawn.systemPromptDelivery.kind, "external");
  }],

  ["launch always includes --always-approve", () => {
    const plugin = load(hostFor());
    const cmd = plugin.buildLaunchCommand({ task: "fix it" });
    assert.match(cmd, /^grok --always-approve /);
    assert.match(cmd, /'fix it'$/);
    assert.doesNotMatch(cmd, /--permission-mode/);
  }],

  ["skip-permissions adds bypassPermissions without dropping always-approve", () => {
    const plugin = load(hostFor());
    const cmd = plugin.buildLaunchCommand({ skipPermissions: true, args: ["--model", "grok-4.6"] });
    assert.match(cmd, /--always-approve/);
    assert.match(cmd, /--permission-mode 'bypassPermissions'/);
    assert.match(cmd, /--model/);
    assert.match(cmd, /grok-4.6/);
  }],

  ["UUID launch marker becomes --session-id", () => {
    const plugin = load(hostFor());
    const id = "01a0b594-144d-7670-8a36-03e39639311c";
    const cmd = plugin.buildLaunchCommand({ launchMarker: id });
    assert.match(cmd, new RegExp(`--session-id '${id}'`));
  }],

  ["resume always includes --always-approve and --resume", () => {
    const plugin = load(hostFor());
    const cmd = plugin.buildResumeCommand("01a0b594-144d-7670-8a36-03e39639311c", true);
    assert.equal(
      cmd,
      "grok --always-approve --resume '01a0b594-144d-7670-8a36-03e39639311c' --permission-mode 'bypassPermissions'",
    );
  }],

  ["session path percent-encodes the native cwd", () => {
    const cwd = "C:/Developer/almaz-admin";
    const id = "01a0b594-144d-7670-8a36-03e39639311c";
    const encoded = encodeURIComponent("C:\\Developer\\almaz-admin");
    const summary = `C:\\Users\\User\\.grok\\sessions\\${encoded}\\${id}\\summary.json`;
    const plugin = load(hostFor({
      platform: "windows",
      files: {
        [summary]: { info: { id }, current_model_id: "grok-4.6", reasoning_effort: "medium" },
      },
      host: { homeDir: () => "C:\\Users\\User" },
    }));
    assert.equal(plugin.sessionExists(cwd, id), true);
    assert.equal(plugin.detectSessionModel(cwd, id), "grok-4.6");
    assert.equal(plugin.detectSessionReasoningEffort(cwd, id), "medium");
  }],

  ["detectSessionId refuses when two sessions exist for the cwd", () => {
    const cwd = "/work/app";
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const root = `/tmp/home/.grok/sessions/${encodeURIComponent(cwd)}`;
    const plugin = load(hostFor({
      dirs: {
        [root]: [
          { name: a, isDir: true, path: `${root}/${a}` },
          { name: b, isDir: true, path: `${root}/${b}` },
        ],
      },
      files: {
        [`${root}/${a}/summary.json`]: { created_at: "2026-09-18T00:00:00Z" },
        [`${root}/${b}/summary.json`]: { created_at: "2026-09-18T00:01:00Z" },
      },
    }));
    assert.equal(plugin.detectSessionId(cwd), null);
    assert.equal(plugin.detectSessionId(cwd, [a]), b);
  }],

  ["detectLaunchSession matches the launch pid in active_sessions.json", () => {
    const plugin = load(hostFor({
      files: {
        "/tmp/home/.grok/active_sessions.json": [
          { session_id: "01a0b594-144d-7670-8a36-03e39639311c", pid: 73812 },
        ],
      },
    }));
    const found = plugin.detectLaunchSession({
      cwd: "/work/app",
      launchedAtMs: 1,
      processes: [{ pid: 73812, depth: 0, startToken: "1" }],
    });
    assert.equal(found.sessionId, "01a0b594-144d-7670-8a36-03e39639311c");
    assert.equal(found.source, "pid_registry");
  }],

  ["discoverModels reads models_cache.json and skips hidden", () => {
    const plugin = load(hostFor({
      files: {
        "/tmp/home/.grok/models_cache.json": {
          models: {
            "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", hidden: false } },
            "hidden": { info: { id: "hidden", name: "Hidden", hidden: true } },
          },
        },
      },
    }));
    const models = plugin.discoverModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "grok-4.6");
    assert.equal(models[0].displayName, "Grok 4.6");
    assert.equal(models[0].group, "xAI");
  }],

  ["structured chat maps updates.jsonl in source order with seq and epoch-ms timestamps", () => {
    const cwd = "/work/app";
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const jsonl = [
      JSON.stringify({
        timestamp: 1789796318,
        params: { update: { sessionUpdate: "hook_execution" } },
        _meta: { eventId: "skip", agentTimestampMs: 1789796318000 },
      }),
      JSON.stringify({
        timestamp: 1789796324,
        params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "йо" } } },
        _meta: { eventId: "u1", agentTimestampMs: 1789796324420 },
      }),
      JSON.stringify({
        timestamp: 1789796337,
        params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "greeting" } } },
        _meta: { eventId: "t1", agentTimestampMs: 1789796329153 },
      }),
      JSON.stringify({
        timestamp: 1789796339,
        params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Йо." } } },
        _meta: { eventId: "a1", agentTimestampMs: 1789796338236 },
      }),
    ].join("\n");
    const plugin = load(hostFor({
      files: {
        [`/tmp/home/.grok/sessions/${encodeURIComponent(cwd)}/${id}/updates.jsonl`]: jsonl,
      },
    }));
    const first = plugin.readStructuredChat(cwd, id, null);
    assert.equal(first.messages.length, 3);
    assert.equal(first.messages[0].type, "user");
    assert.equal(first.messages[0].content, "йо");
    assert.equal(first.messages[0].seq, 1);
    assert.equal(first.messages[0].timestamp, "1789796324420");
    assert.equal(first.messages[1].type, "thinking");
    assert.equal(first.messages[2].type, "assistant");
    assert.equal(first.messages[2].content, "Йо.");
    assert.equal(plugin.readStructuredChat(cwd, id, first.cursor).messages.length, 0);
  }],

  ["usage snapshot maps session costUsdTicks into spend cents", () => {
    const cwd = "/work/app";
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const root = `/tmp/home/.grok/sessions/${encodeURIComponent(cwd)}`;
    const plugin = load(hostFor({
      dirs: {
        "/tmp/home/.grok/sessions": [{ name: encodeURIComponent(cwd), isDir: true, path: root }],
        [root]: [{ name: id, isDir: true, path: `${root}/${id}` }],
      },
      files: {
        [`${root}/${id}/usage.json`]: {
          updatedAt: "2026-09-19T05:43:29Z",
          session: { costUsdTicks: 489545600 },
        },
      },
    }));
    const raw = plugin.fetchUsage(1);
    assert.equal(JSON.parse(raw).spendCents, 49);
    const snap = plugin.parseUsage(raw, 1);
    assert.equal(snap.spend_cents, 49);
    assert.equal(snap.session_pct, null);
  }],

  ["manifest declares the Grok OAuth credential and billing proxy permission", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
    const credential = manifest.credentials.find((item) => item.id === "grokAuth");
    assert.equal(credential.file, "~/.grok/auth.json");
    assert.equal(
      credential.public.userId,
      "/https:~1~1auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828/user_id",
    );
    assert.equal(
      credential.secret.accessToken,
      "/https:~1~1auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828/key",
    );
    assert.ok(manifest.permissions.network.allow.includes("cli-chat-proxy.grok.com"));
  }],

  ["weekly OAuth billing maps the percentage and reset while preserving session spend", () => {
    const cwd = "/work/app";
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const root = `/tmp/home/.grok/sessions/${encodeURIComponent(cwd)}`;
    let request;
    const plugin = load(hostFor({
      dirs: {
        "/tmp/home/.grok/sessions": [{ name: encodeURIComponent(cwd), isDir: true, path: root }],
        [root]: [{ name: id, isDir: true, path: `${root}/${id}` }],
      },
      files: {
        [`${root}/${id}/usage.json`]: {
          updatedAt: "2026-09-19T05:43:29Z",
          session: { costUsdTicks: 489545600 },
        },
      },
      host: {
        credentialPublic: () => JSON.stringify({ userId: "test-user-id" }),
        exec: () => JSON.stringify({ code: 0, stdout: "grok 1.0.34 (test-build)" }),
        fetch: (raw) => {
          request = JSON.parse(raw);
          return JSON.stringify({
            status: 200,
            body: JSON.stringify({
              config: {
                creditUsagePercent: 42.5,
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  end: "2026-09-25T19:45:46Z",
                },
              },
            }),
          });
        },
      },
    }));

    const raw = plugin.fetchUsage(1);
    const snap = plugin.parseUsage(raw, 1);
    assert.equal(snap.weekly_pct, 42.5);
    assert.equal(snap.weekly_resets_at_ms, Date.parse("2026-09-25T19:45:46Z"));
    assert.equal(snap.spend_cents, 49);
    assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    assert.equal(request.method, "GET");
    assert.equal(request.headers["X-XAI-Token-Auth"], "xai-grok-cli");
    assert.equal(request.headers["x-grok-client-version"], "1.0.34");
    assert.equal(request.headers["x-grok-client-mode"], "headless");
    assert.deepEqual(request.credential, {
      id: "grokAuth",
      headers: {
        Authorization: "Bearer {accessToken}",
        "x-userid": "{userId}",
      },
    });
    assert.equal(JSON.stringify(request).includes("test-oauth-bearer"), false);
  }],

  ["failed, malformed, absent, and non-weekly billing keep limits null and spend intact", () => {
    const cwd = "/work/app";
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const root = `/tmp/home/.grok/sessions/${encodeURIComponent(cwd)}`;
    const responses = [
      () => JSON.stringify({ status: 503 }),
      () => JSON.stringify({ status: 200, body: "not-json" }),
      () => JSON.stringify({ status: 200, body: "{}" }),
      () => JSON.stringify({
        status: 200,
        body: JSON.stringify({
          config: {
            creditUsagePercent: 80,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-10-01T00:00:00Z" },
          },
        }),
      }),
      () => { throw new Error("fetch failed"); },
    ];

    for (const fetch of responses) {
      const plugin = load(hostFor({
        dirs: {
          "/tmp/home/.grok/sessions": [{ name: encodeURIComponent(cwd), isDir: true, path: root }],
          [root]: [{ name: id, isDir: true, path: `${root}/${id}` }],
        },
        files: {
          [`${root}/${id}/usage.json`]: { session: { costUsdTicks: 489545600 } },
        },
        host: {
          credentialPublic: () => JSON.stringify({ userId: "test-user-id" }),
          exec: () => JSON.stringify({ code: 0, stdout: "grok 1.0.34" }),
          fetch,
        },
      }));
      const snap = plugin.parseUsage(plugin.fetchUsage(1), 1);
      assert.equal(snap.weekly_pct, null);
      assert.equal(snap.weekly_resets_at_ms, null);
      assert.equal(snap.spend_cents, 49);
    }
  }],

  ["detection requires a Grok TUI fingerprint", () => {
    const plugin = load(hostFor());
    assert.equal(plugin.detectFromTitle("grok"), true);
    assert.equal(plugin.detectFromTitle("codex"), false);
    assert.equal(plugin.detectFromOutput("Grok Build TUI"), true);
    assert.equal(plugin.detectFromOutput("random shell"), false);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}
if (failed) process.exit(1);
console.log(`\n${tests.length - failed}/${tests.length} passed`);
