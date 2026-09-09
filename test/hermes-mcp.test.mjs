import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createMcpRequestHandler, TOOL_DEFINITIONS } from "../dist/hermes-mcp.js";
import { getMemoryBankClient, hermesConfigFromEnv, MemoryBankService, resetMemoryBankClientsForTests, setMemoryBankClientFactoryForTests } from "../dist/memorybank-core.js";

const operation = (value = {}) => ({ promise: async () => [value] });
const config = { projectId: "project", location: "us-central1", reasoningEngineId: "engine", scope: { shared_scope: "team" } };
const validEnv = {
  MEMORYBANK_PROJECT_ID: "project",
  MEMORYBANK_LOCATION: "us-central1",
  MEMORYBANK_REASONING_ENGINE_ID: "engine",
};

function mockClient(overrides = {}) {
  return {
    retrieveMemories: async () => [{ retrievedMemories: [{ memory: { name: "memories/one", fact: "Use tests", topics: ["engineering"] }, distance: 0.1 }] }],
    createMemory: async () => [operation()],
    deleteMemory: async () => [operation()],
    updateMemory: async () => [operation({ name: "memories/one", fact: "Correct" })],
    getMemory: async () => [{ fact: "Old fact" }],
    generateMemories: async () => [operation()],
    listMemories: async () => [[{ name: "memories/one", topics: ["engineering"] }], undefined, {}],
    ...overrides,
  };
}

async function request(handler, id, method, params) {
  return handler({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
}

function callText(response) {
  return JSON.parse(response.result.content[0].text);
}

test("lists annotated MCP tools", async () => {
  const handler = createMcpRequestHandler(new MemoryBankService(config, mockClient(), { agent_name: "hermes" }));
  const response = await request(handler, 1, "tools/list", {});
  assert.deepEqual(response.result.tools.map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.name));
  const byName = Object.fromEntries(response.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.memorybank_search.annotations.readOnlyHint, true);
  assert.equal(byName.memorybank_stats.annotations.readOnlyHint, true);
  assert.equal(byName.memorybank_forget.annotations.destructiveHint, true);
  assert.equal(byName.memorybank_forget.annotations.idempotentHint, true);
  assert.equal(byName.memorybank_remember.annotations.idempotentHint, false);
});

test("echoes all Hermes mcp_types handshake versions and counter-offers the latest", async () => {
  const handler = createMcpRequestHandler(new MemoryBankService(config, mockClient()));
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    const response = await request(handler, 1, "initialize", { protocolVersion });
    assert.equal(response.result.protocolVersion, protocolVersion);
    assert.equal(response.result.serverInfo.name, "agent-platform-memorybank");
  }
  const counterOffer = await request(handler, 2, "initialize", { protocolVersion: "2099-01-01" });
  assert.equal(counterOffer.result.protocolVersion, "2025-11-25");
});

test("calls all memory tools through the mocked Agent Platform client", async () => {
  const calls = [];
  const client = mockClient({
    retrieveMemories: async (input) => { calls.push(["search", input]); return [{ retrievedMemories: [] }]; },
    createMemory: async (input) => { calls.push(["remember", input]); return [operation()]; },
    deleteMemory: async (input) => { calls.push(["forget", input]); return [operation()]; },
    updateMemory: async (input) => { calls.push(["correct", input]); return [operation()]; },
    listMemories: async (input) => { calls.push(["stats", input]); return [[], undefined, {}]; },
  });
  const handler = createMcpRequestHandler(new MemoryBankService(config, client, { agent_name: "hermes" }));
  await request(handler, 1, "tools/call", { name: "memorybank_search", arguments: { query: "test", top_k: 2 } });
  await request(handler, 2, "tools/call", { name: "memorybank_remember", arguments: { fact: "Remember this" } });
  await request(handler, 3, "tools/call", { name: "memorybank_forget", arguments: { memory_id: "one" } });
  await request(handler, 4, "tools/call", { name: "memorybank_correct", arguments: { memory_id: "one", new_fact: "Corrected" } });
  await request(handler, 5, "tools/call", { name: "memorybank_stats", arguments: {} });
  assert.deepEqual(calls.map(([name]) => name), ["search", "remember", "forget", "correct", "stats"]);
  assert.deepEqual(calls[0][1].scope, { shared_scope: "team" });
});

test("correct fallback returns a replacement memory name when generation supplies one", async () => {
  const service = new MemoryBankService(config, mockClient({
    updateMemory: async () => { throw Object.assign(new Error("unsupported"), { code: 12 }); },
    generateMemories: async () => [operation({ generatedMemories: [{ memory: { name: "memories/replacement" } }] })],
  }));
  assert.deepEqual(await service.correct("one", "New fact"), {
    corrected: true, method: "delete-regenerate", replacementMemoryName: "memories/replacement",
  });
});

test("correct fallback restores the old fact when regeneration fails", async () => {
  const calls = [];
  const service = new MemoryBankService(config, mockClient({
    updateMemory: async () => { throw Object.assign(new Error("unsupported"), { code: 12 }); },
    getMemory: async () => [{ fact: "Old fact" }],
    deleteMemory: async () => { calls.push("delete"); return [operation()]; },
    generateMemories: async () => { calls.push("generate"); throw new Error("generation failed"); },
    createMemory: async (input) => { calls.push(input.memory.fact); return [operation({ name: "memories/restored" })]; },
  }));
  assert.deepEqual(await service.correct("one", "New fact"), {
    corrected: false, method: "delete-regenerate", recovered: true, error: "generation failed", restoredMemoryName: "memories/restored",
  });
  assert.deepEqual(calls, ["delete", "generate", "Old fact"]);
});

test("correct fallback reports unrecovered failures without claiming success", async () => {
  const service = new MemoryBankService(config, mockClient({
    updateMemory: async () => { throw Object.assign(new Error("unsupported"), { code: 12 }); },
    getMemory: async () => [{ fact: "Old fact" }],
    generateMemories: async () => { throw new Error("generation failed"); },
    createMemory: async () => { throw new Error("restore failed"); },
  }));
  const handler = createMcpRequestHandler(service);
  const response = await request(handler, 1, "tools/call", { name: "memorybank_correct", arguments: { memory_id: "one", new_fact: "New" } });
  assert.equal(response.result.isError, true);
  assert.match(callText(response).error, /restore failed/);
  assert.equal(callText(response).recovered, false);
});

test("stats paginates and search applies configured distance filtering", async () => {
  const pages = [];
  const service = new MemoryBankService({ ...config, maxDistance: 0.2 }, mockClient({
    retrieveMemories: async () => [{ retrievedMemories: [
      { memory: { name: "memories/keep", fact: "keep" }, distance: 0.2 },
      { memory: { name: "memories/drop", fact: "drop" }, distance: 0.3 },
    ] }],
    listMemories: async (input) => {
      pages.push(input.pageToken);
      return input.pageToken ? [[{ topics: [{ customMemoryTopicLabel: "two" }] }], undefined, {}] : [[{ topics: [{ customMemoryTopicLabel: "one" }] }], undefined, { nextPageToken: "next" }];
    },
  }));
  assert.deepEqual((await service.search("query")).map((memory) => memory.fact), ["keep"]);
  assert.deepEqual(await service.stats(), { totalMemories: 2, byTopic: { one: 1, two: 1 }, scope: { shared_scope: "team" } });
  assert.deepEqual(pages, [undefined, "next"]);
});

test("validates JSON-RPC requests, arguments, and notification silence", async () => {
  const handler = createMcpRequestHandler(new MemoryBankService(config, mockClient()));
  const unknown = await request(handler, 1, "tools/call", { name: "nope", arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const invalid = await request(handler, 2, "tools/call", { name: "memorybank_search", arguments: { query: "", extra: true } });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /Unexpected argument/);
  const malformed = await handler({ jsonrpc: "1.0", id: 3, method: "tools/list" });
  assert.equal(malformed.error.code, -32600);
  assert.equal(await handler({ jsonrpc: "2.0", method: "tools/call", params: { name: "missing" } }), undefined);
  assert.equal(await handler({ jsonrpc: "2.0", method: "initialize", params: {} }), undefined);
  assert.equal(await handler({ jsonrpc: "2.0", method: "not/a/method", params: {} }), undefined);
});

test("reuses Agent Platform clients only for the same endpoint", () => {
  const created = [];
  setMemoryBankClientFactoryForTests((input) => {
    const client = mockClient();
    created.push([input.location, client]);
    return client;
  });
  try {
    const first = getMemoryBankClient(config);
    assert.equal(first, getMemoryBankClient({ ...config, projectId: "another-project" }));
    assert.notEqual(first, getMemoryBankClient({ ...config, location: "us-east1" }));
    assert.equal(created.length, 2);
  } finally {
    setMemoryBankClientFactoryForTests();
    resetMemoryBankClientsForTests();
  }
});

test("validates Hermes environment configuration", () => {
  assert.deepEqual(hermesConfigFromEnv(validEnv).scope, { agent_name: "hermes" });
  for (const [env, message] of [
    [{ ...validEnv, MEMORYBANK_PROJECT_ID: "${MEMORYBANK_PROJECT_ID}" }, /unresolved environment placeholder/],
    [{ ...validEnv, MEMORYBANK_LOCATION: "${env:LOCATION}" }, /unresolved environment placeholder/],
    [{ ...validEnv, MEMORYBANK_SCOPE: "" }, /scope must not be empty/],
    [{ ...validEnv, MEMORYBANK_SCOPE: "{}" }, /non-empty JSON object/],
    [{ ...validEnv, MEMORYBANK_SCOPE: "${SCOPE}" }, /unresolved environment placeholder/],
    [{ ...validEnv, MEMORYBANK_TOP_K: "0" }, /integer from 1 to 100/],
    [{ ...validEnv, MEMORYBANK_TOP_K: "1.5" }, /integer from 1 to 100/],
  ]) assert.throws(() => hermesConfigFromEnv(env), message);
});

async function runStdio(lines, { cwd = process.cwd(), env = validEnv } = {}) {
  const child = spawn(process.execPath, [resolve(process.cwd(), "bin/hermes-mcp.js")], {
    cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.end(lines);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP process timed out")); }, 5000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(Object.assign(new Error(`MCP process exited ${code}`), { stdout, stderr, code })); });
  });
  return { stdout, stderr };
}

test("stdio server ignores blank lines, handles malformed JSON, notifications, and independent cwd", async () => {
  const otherCwd = await mkdtemp(resolve(tmpdir(), "memorybank-mcp-"));
  try {
    const { stdout, stderr } = await runStdio([
      "\n",
      "not json\n",
      `${JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {} })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    ].join(""), { cwd: otherCwd });
    const responses = stdout.trim().split("\n").map(JSON.parse);
    assert.equal(responses.length, 3);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[1].result.protocolVersion, "2025-03-26");
    assert.equal(responses[2].result.tools.length, 5);
    // SDK metadata probing may emit a Node warning on stderr. Protocol data must
    // still be confined to stdout, and server diagnostics must not corrupt it.
    assert.doesNotMatch(stderr, /\"jsonrpc\"/);
  } finally {
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("out-of-band dependency rejection does not terminate the MCP process", async () => {
  const entryPoint = resolve(process.cwd(), "dist/hermes-mcp.js");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { runMcpServer } from ${JSON.stringify(entryPoint)};
    runMcpServer();
    setTimeout(() => Promise.reject(new Error("simulated google-gax credential rejection")), 40);
    // Test harness exit only; production MCP lifecycle remains stdin-driven.
    setTimeout(() => process.exit(0), 300);
  `], { cwd: process.cwd(), env: { ...process.env, ...validEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("initialize timed out")), 3000);
    const poll = () => stdout.includes('"id":1') ? (clearTimeout(timer), resolvePromise()) : setTimeout(poll, 10);
    poll();
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("tools/list timed out")), 3000);
    const poll = () => stdout.includes('"id":2') ? (clearTimeout(timer), resolvePromise()) : setTimeout(poll, 10);
    poll();
  });
  child.stdin.end();
  const code = await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  assert.equal(code, 0);
  assert.match(stderr, /handled asynchronous dependency rejection/);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).result.tools.length, 5);
});

test("stdio entry reports missing configuration only on stderr", async () => {
  const child = spawn(process.execPath, [resolve(process.cwd(), "bin/hermes-mcp.js")], { cwd: process.cwd(), env: {}, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Missing required environment variable MEMORYBANK_PROJECT_ID/);
});
