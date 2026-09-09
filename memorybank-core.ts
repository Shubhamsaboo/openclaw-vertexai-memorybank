import { v1beta1 } from "@google-cloud/aiplatform";

export interface MemoryBankConfig {
  projectId: string;
  location: string;
  reasoningEngineId: string;
  scope?: Record<string, string>;
  topK?: number;
  maxDistance?: number;
}

export interface MemoryBankClient {
  retrieveMemories(request: unknown): Promise<[any]>;
  createMemory(request: unknown): Promise<[any]>;
  deleteMemory(request: unknown): Promise<[any]>;
  updateMemory(request: unknown): Promise<[any]>;
  getMemory(request: unknown): Promise<[any]>;
  generateMemories(request: unknown): Promise<[any]>;
  listMemories(request: unknown, options?: unknown): Promise<[any[], unknown?, any?]>;
}

export type CorrectionResult =
  | { corrected: true; method: "patch" | "delete-regenerate"; replacementMemoryName?: string }
  | { corrected: false; method: "delete-regenerate"; recovered: boolean; error: string; restoredMemoryName?: string };

const clients = new Map<string, MemoryBankClient>();
let createClient = (cfg: MemoryBankConfig): MemoryBankClient =>
  new v1beta1.MemoryBankServiceClient({ apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` }) as unknown as MemoryBankClient;

/** Reuse SDK clients only for identical Agent Platform API endpoints. */
export function getMemoryBankClient(cfg: MemoryBankConfig): MemoryBankClient {
  const endpoint = `${cfg.location}-aiplatform.googleapis.com`;
  let client = clients.get(endpoint);
  if (!client) {
    client = createClient(cfg);
    clients.set(endpoint, client);
  }
  return client;
}

/** Test-only seam; production callers always use the Google SDK factory. */
export function setMemoryBankClientFactoryForTests(factory?: (cfg: MemoryBankConfig) => MemoryBankClient): void {
  createClient = factory || ((cfg) => new v1beta1.MemoryBankServiceClient({ apiEndpoint: `${cfg.location}-aiplatform.googleapis.com` }) as unknown as MemoryBankClient);
  clients.clear();
}

export function resetMemoryBankClientsForTests(): void {
  clients.clear();
}

export function parentName(cfg: MemoryBankConfig): string {
  return `projects/${cfg.projectId}/locations/${cfg.location}/reasoningEngines/${cfg.reasoningEngineId}`;
}

export function effectiveScope(cfg: MemoryBankConfig, fallback: Record<string, string> = { agent_name: "openclaw" }): Record<string, string> {
  return cfg.scope ? { ...cfg.scope } : fallback;
}

function scopeFilter(scope: Record<string, string>): string {
  return `scope="${JSON.stringify(scope).replace(/"/g, '\\"')}"`;
}

export function memoryName(cfg: MemoryBankConfig, id: string): string {
  return id.includes("/") ? id : `${parentName(cfg)}/memories/${id}`;
}

export function formatMemory(m: any, index?: number): Record<string, unknown> {
  const memory = m.memory || m;
  return {
    ...(index === undefined ? {} : { index }),
    id: memory.name || memory.id || null,
    fact: memory.fact || JSON.stringify(memory),
    score: m.score ?? m.similarity ?? m.distance ?? null,
    topic: memory.topics || memory.topic || memory.memoryTopic || null,
    created: memory.createTime || memory.createdAt || null,
    updated: memory.updateTime || memory.updatedAt || null,
  };
}

async function waitForOperation(operation: any): Promise<any> {
  const [result] = await operation.promise();
  return result;
}

export class MemoryBankService {
  public constructor(
    private readonly cfg: MemoryBankConfig,
    private readonly client: MemoryBankClient = getMemoryBankClient(cfg),
    private readonly fallbackScope: Record<string, string> = { agent_name: "openclaw" },
  ) {}

  public async search(query: string, topK?: number): Promise<Record<string, unknown>[]> {
    const [response] = await this.client.retrieveMemories({
      parent: parentName(this.cfg),
      scope: effectiveScope(this.cfg, this.fallbackScope),
      similaritySearchParams: { searchQuery: query, topK: topK || this.cfg.topK || 10 },
    });
    let memories = response?.retrievedMemories || [];
    if (this.cfg.maxDistance != null) {
      memories = memories.filter((memory: any) => memory.distance != null && memory.distance <= this.cfg.maxDistance!);
    }
    return memories.map((memory: any, index: number) => formatMemory(memory, index + 1));
  }

  public async remember(fact: string): Promise<void> {
    const [operation] = await this.client.createMemory({
      parent: parentName(this.cfg),
      memory: { fact, scope: effectiveScope(this.cfg, this.fallbackScope) },
    });
    await waitForOperation(operation);
  }

  public async forget(id: string): Promise<void> {
    const [operation] = await this.client.deleteMemory({ name: memoryName(this.cfg, id) });
    await waitForOperation(operation);
  }

  public async correct(id: string, newFact: string): Promise<CorrectionResult> {
    const name = memoryName(this.cfg, id);
    try {
      const [operation] = await this.client.updateMemory({
        memory: { name, fact: newFact },
        updateMask: { paths: ["fact"] },
      });
      await waitForOperation(operation);
      return { corrected: true, method: "patch" };
    } catch (error: any) {
      const code = error?.code || error?.status;
      if (![3, 12, 400, 405].includes(code)) throw error;
    }

    // Preserve the old fact before destructive fallback. A failed regeneration
    // can then restore the prior memory instead of silently losing it.
    let oldFact: string | undefined;
    try {
      const [oldMemory] = await this.client.getMemory({ name });
      if (typeof oldMemory?.fact === "string" && oldMemory.fact) oldFact = oldMemory.fact;
    } catch {
      // Best effort only: delete failures still leave the original untouched.
    }

    const [deleteOperation] = await this.client.deleteMemory({ name });
    await waitForOperation(deleteOperation);
    try {
      const [generateOperation] = await this.client.generateMemories({
        parent: parentName(this.cfg),
        scope: effectiveScope(this.cfg, this.fallbackScope),
        directContentsSource: {
          events: [{ content: { role: "user", parts: [{ text: `Remember this fact: ${newFact}` }] } }],
        },
      });
      const generated = await waitForOperation(generateOperation);
      const replacementMemoryName = generated?.generatedMemories?.find((item: any) => typeof item?.memory?.name === "string")?.memory.name;
      return {
        corrected: true,
        method: "delete-regenerate",
        ...(typeof replacementMemoryName === "string" ? { replacementMemoryName } : {}),
      };
    } catch (error: any) {
      const message = error?.message || "Memory regeneration failed.";
      if (!oldFact) return { corrected: false, method: "delete-regenerate", recovered: false, error: message };
      try {
        const [restoreOperation] = await this.client.createMemory({
          parent: parentName(this.cfg),
          memory: { fact: oldFact, scope: effectiveScope(this.cfg, this.fallbackScope) },
        });
        const restored = await waitForOperation(restoreOperation);
        return {
          corrected: false,
          method: "delete-regenerate",
          recovered: true,
          error: message,
          ...(typeof restored?.name === "string" ? { restoredMemoryName: restored.name } : {}),
        };
      } catch (restoreError: any) {
        return {
          corrected: false,
          method: "delete-regenerate",
          recovered: false,
          error: `${message} Old-memory restore failed: ${restoreError?.message || "unknown error"}.`,
        };
      }
    }
  }

  public async stats(): Promise<{ totalMemories: number; byTopic: Record<string, number>; scope: Record<string, string> }> {
    const scope = effectiveScope(this.cfg, this.fallbackScope);
    const all: any[] = [];
    let pageToken: string | undefined;
    do {
      // autoPaginate must be explicitly disabled: gax's default streaming
      // auto-pagination resolves credentials/dispatches errors outside the
      // returned promise's rejection path, which previously surfaced as an
      // uncaught exception here (crashing this whole long-lived MCP server)
      // instead of a normal awaited rejection. With autoPaginate:false the
      // manual pageToken loop below is also what the SDK actually expects.
      const [memories, , response] = await this.client.listMemories(
        { parent: parentName(this.cfg), filter: scopeFilter(scope), pageSize: 100, pageToken },
        { autoPaginate: false } as any,
      );
      all.push(...(memories || []));
      pageToken = response?.nextPageToken || undefined;
    } while (pageToken);

    const byTopic: Record<string, number> = {};
    for (const memory of all) {
      const topics = memory.topics || [];
      const label = topics.length
        ? topics.map((topic: any) => topic.managedMemoryTopic || topic.customMemoryTopicLabel || JSON.stringify(topic)).join(", ")
        : "unknown";
      byTopic[label] = (byTopic[label] || 0) + 1;
    }
    return { totalMemories: all.length, byTopic, scope };
  }
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  if (/\$\{[^}]+\}/.test(value)) throw new Error(`${name} contains an unresolved environment placeholder.`);
  return value;
}

export function hermesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryBankConfig {
  const rawScope = env.MEMORYBANK_SCOPE;
  let scope: Record<string, string> = { agent_name: "hermes" };
  if (rawScope !== undefined) {
    if (!rawScope.trim()) throw new Error("Invalid MEMORYBANK_SCOPE: scope must not be empty.");
    if (/\$\{[^}]+\}/.test(rawScope)) throw new Error("Invalid MEMORYBANK_SCOPE: unresolved environment placeholder.");
    try {
      const parsed: unknown = JSON.parse(rawScope);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length === 0 || Object.values(parsed).some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error("scope must be a non-empty JSON object with non-empty string values");
      }
      scope = parsed as Record<string, string>;
    } catch (error: any) {
      throw new Error(`Invalid MEMORYBANK_SCOPE: ${error.message}`);
    }
  }
  const rawTopK = env.MEMORYBANK_TOP_K;
  if (rawTopK !== undefined && !rawTopK.trim()) throw new Error("MEMORYBANK_TOP_K must be an integer from 1 to 100.");
  const topK = rawTopK === undefined ? undefined : Number(rawTopK);
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 100)) {
    throw new Error("MEMORYBANK_TOP_K must be an integer from 1 to 100.");
  }
  return {
    projectId: requireEnv("MEMORYBANK_PROJECT_ID", env),
    location: requireEnv("MEMORYBANK_LOCATION", env),
    reasoningEngineId: requireEnv("MEMORYBANK_REASONING_ENGINE_ID", env),
    scope,
    ...(topK ? { topK } : {}),
  };
}
