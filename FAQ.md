# FAQ — Vertex AI Memory Bank for OpenClaw and Hermes

Answers to common questions about Vertex AI Memory Bank, its OpenClaw plugin and Hermes MCP adapter, pricing, scoping, and design decisions.

> **Official docs:** [Vertex AI Agent Engine Memory Bank overview](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview)

---

## Table of Contents

- [What is Memory Bank?](#what-is-memory-bank)
- [Pricing & Free Tier](#pricing--free-tier)
- [How Memory Generation Works](#how-memory-generation-works)
- [Scoping — Who Sees What](#scoping--who-sees-what)
- [Deduplication & Contradictions](#deduplication--contradictions)
- [Noise Filtering](#noise-filtering)
- [Debouncing & Efficiency](#debouncing--efficiency)
- [Pre-Compaction Safety](#pre-compaction-safety)
- [Retrieval & Caching](#retrieval--caching)
- [Counting Memories](#counting-memories)
- [Agent Tools](#agent-tools)
- [Glossary / Jargon Entries](#glossary--jargon-entries)
- [SDK & API](#sdk--api)
- [Links & Resources](#links--resources)
- [Hermes Agent MCP](#hermes-agent-mcp)

---

## What is Memory Bank?

Vertex AI Agent Engine Memory Bank is a **fully managed service** for generating, storing, and retrieving long-term memories from agent conversations. It uses an LLM to extract facts, preferences, and key events, then automatically consolidates them with existing memories (dedup, update, resolve contradictions).

**Status:** Public preview (billing started Feb 11, 2026)

**Core endpoints:**

| Endpoint | Description |
|----------|-------------|
| `memories:generate` | Extract & consolidate memories from conversation content |
| `memories:retrieve` | Fetch memories by scope (all or similarity search) |
| `memories.get` | Get a single memory by name |
| `memories.list` | List all memories for an engine instance |
| `memories.create` | Directly write a memory |
| `memories.update` | Update an existing memory |
| `memories.delete` | Delete a memory |
| `memories.rollback` | Roll back a memory to a previous revision |
| `memories.purge` | Purge all memories matching a scope |

---

## Pricing & Free Tier

> **Full pricing page:** [Vertex AI pricing — Agent Engine section](https://cloud.google.com/vertex-ai/pricing#vertex-ai-agent-engine)

| Resource | Price | Free Tier |
|----------|-------|-----------|
| **Memory Storage** | $0.25 per 1,000 memories / month | — |
| **Memory Retrieval** | $0.50 per 1,000 memories returned | **First 1,000 retrievals/month free** |
| **Memory Generation** | No per-call fee — you pay underlying Gemini token costs only | Covered by Gemini free tier if applicable |

**What does generation actually cost?** Each `generate` call invokes ~2K–10K input tokens + ~500 output tokens for extraction and consolidation. At Gemini 2.0 Flash rates, that's roughly **$0.0003–$0.001 per call**.

**Example monthly cost (single user, 50 turns/day):**

| Strategy | Generate calls/day | Est. monthly cost |
|----------|-------------------|-------------------|
| Every turn (no batching) | 50 | ~$0.75 |
| Every 5 turns (batched) | 10 | ~$0.15 |
| Batched + content filter | ~6 | ~$0.09 |

Storage is cheap (~$0.25/1K memories/month). **Retrieval** is the cost to watch at scale — if you retrieve on every turn with 100 users, it adds up fast. Caching helps (see [Retrieval & Caching](#retrieval--caching)).

---

## How Memory Generation Works

1. You send conversation content to `memories:generate`
2. An LLM extracts facts matching configured **topics** (personal info, preferences, key events, explicit instructions)
3. Extracted facts are **consolidated** against existing memories in the same scope
4. New memories are created, existing ones updated or removed as needed
5. The call returns an async **Operation** — generation is fire-and-forget by design

**Default extraction topics:**
- `USER_PERSONAL_INFO` — names, relationships, hobbies, dates
- `USER_PREFERENCES` — likes, dislikes, preferred styles
- `KEY_CONVERSATION_DETAILS` — milestones, task outcomes
- `EXPLICIT_INSTRUCTIONS` — "remember that I..."

You can also define **custom topics** for domain-specific extraction.

---

## Scoping — Who Sees What

Memories are scoped by arbitrary key-value pairs. **Scope matching is exact** — all keys and values must match for retrieval and consolidation.

**Recommended: scope by `user_id` only.**

```json
{ "user_id": "alan" }
```

**Why not include agent name or channel?** If you scope as `{user_id: "alan", agent_name: "zaf"}`, then memories created by agent "zaf" won't be found when agent "helper" retrieves for the same user. Memories fragment across agents/channels.

**For agent-specific tagging**, use `metadata` (not scope). The Memory resource has a `metadata` field (`map<string, MemoryMetadataValue>`) that doesn't affect consolidation boundaries:

```json
{
  "metadata": {
    "source_agent": { "stringValue": "zaf" },
    "channel": { "stringValue": "discord" }
  }
}
```

> **⚠️ Limitation:** Metadata can only be set via `memories.create` (direct write) or `memories.patch` (update). The `memories:generate` consolidation pipeline — which is what this plugin uses for auto-capture, file sync, and `memorybank-remember` — does **not** propagate metadata to the memories it creates. To tag generated memories, you'd need a post-generate step: list newly created memories and patch them with the desired metadata. This plugin does not implement that today.

Scope is **immutable** once set on a memory — choose wisely.

---

## Deduplication & Contradictions

**Memory Bank handles this automatically.** This is a core feature.

During consolidation, each extracted fact is compared against existing memories:

| Action | When |
|--------|------|
| **CREATED** | Entirely new concept → new memory |
| **UPDATED** | Overlapping or contradictory info → existing memory updated |
| **DELETED** | Existing memory fully contradicted → removed |

**Example:**
- Turn 1: "I live in Louisville" → Memory: *"User lives in Louisville"*
- Turn 50: "I just moved to Portland" → Memory **updated**: *"User lives in Portland (moved from Louisville)"*

No explicit update/delete calls needed. Just keep sending conversations and consolidation handles the rest.

**Verify changes:** Use `memories.revisions.list` to inspect how a memory evolved over time.

---

## Noise Filtering

**Does the API filter trivial messages?** Partially — extraction only persists information matching configured topics. A conversation of just "ok" / "sure" / "thanks" would likely extract zero memories.

**However**, you still pay LLM token costs for the extraction attempt even when nothing is extracted.

**Recommendation: client-side pre-filter before calling the API.**

Skip generation when:
- Total user content is under ~50 characters
- All user messages match trivial patterns ("ok", "thanks", "yes", "👍")
- Average message length is under ~20 characters

This is **defense in depth** — the API's topic-based extraction is the second layer.

---

## Debouncing & Efficiency

Calling `generate` on every single turn is wasteful. Most short exchanges contain nothing memorable, and overlapping message windows re-extract already-processed content.

**Recommended strategies:**

1. **Turn-count batching** — accumulate N turns (e.g., 5) before generating. Flush on session end or idle timeout.
2. **Sliding window** — track what's already been processed. Only send NEW messages since the last generation call.
3. **Content filter** — skip if the batch has no substantive content (see [Noise Filtering](#noise-filtering)).
4. **Time-based minimum interval** — don't generate more than once per minute regardless of turn count.

**Impact:** 5–10× fewer generate calls with zero data loss.

---

## Pre-Compaction Safety

OpenClaw compacts older conversation history into a summary when approaching the context window limit. **If Memory Bank hasn't processed those messages yet, the raw conversation is lost forever** — the compaction summary won't contain the granular facts that Memory Bank would extract.

**Solution:** Hook `session:compact:before` as an emergency flush.

When compaction is about to fire:
1. Immediately flush ALL buffered/unprocessed turns to `generate`
2. Make this call **blocking** (wait for API acknowledgment, not full extraction)
3. Only then allow compaction to proceed

This is the most critical safety net — all the batching/debouncing in the world is useless if compaction destroys unprocessed conversation data.

---

## Retrieval & Caching

**How retrieval works:**
- `memories:retrieve` with `similaritySearchParams` does semantic search (top-K, max 100)
- `memories:retrieve` with `simpleRetrievalParams` does paginated listing (max 100 per page)
- Both require exact scope match

**Caching recommendation:** In a multi-turn conversation about the same topic, the same memories get fetched repeatedly. Cache retrieval results for ~30 seconds or until the query changes significantly. This cuts retrieval API calls by ~50%.

**Retrieval quality gate:** Skip retrieval for very short queries (< ~15 chars) like "hi" or "thanks" — they won't produce useful similarity matches.

---

## Counting Memories

**Can I get a total memory count without listing them all?**

No. As of March 2026, the `memories.list` API does **not** return a `totalSize` field, and there is no `memories:count` RPC. We verified this by:

1. Requesting `$fields=totalSize` — returns "Cannot find matching fields for path 'totalSize'"
2. Checking the API discovery document — no count method exists
3. Testing `v1alpha1` — returns 404 (only `v1beta1` is available)
4. Max `pageSize` is **100** even when requesting 1,000

**Workaround:** The plugin uses field-masked pagination (`$fields=memories/name,nextPageToken`) to count only resource names (~120 bytes per memory, no fact text, no LLM). Results are cached in-memory with a 5-minute TTL and auto-adjusted on create/delete. The `memorybank-list --count-only` CLI command uses this approach.

This is a known gap per [AIP-132](https://google.aip.dev/132) — standard List responses should include `totalSize`. If Google adds it, the pagination loop can be replaced with a single API call.

---

## Agent Tools

**What tools does the plugin register?**

Four tools via `api.registerTool()`, available to the agent during conversation:

| Tool | What it does |
|------|-------------|
| `memorybank_search` | Semantic similarity search — returns facts, scores, topics, timestamps, and memory IDs |
| `memorybank_forget` | Delete a memory by ID. Agent can clean up outdated/incorrect information |
| `memorybank_correct` | Update with `updateMemory`; if unavailable, fetch the old fact, delete, and regenerate. A failed regeneration attempts restoration and reports any replacement/restored resource name. |
| `memorybank_stats` | Total count, topic breakdown, scope info. Uses lightweight field-masked counting |

**When would the agent use these?**

- *"What do you remember about my project setup?"* → `memorybank_search`
- *"That's wrong, I moved to us-east1"* → `memorybank_correct`
- *"Forget everything about the old deployment"* → `memorybank_forget`
- *"How many memories do you have?"* → `memorybank_stats`

**Can I disable the tools?** Not individually — they're registered when the plugin loads. If you don't want the agent to use them, the model won't call them unless the conversation context makes them relevant.

**What about `memory_inspect`?** It was removed as overbuilt — `memorybank_search` already returns full details (ID, fact, score, topic, timestamps). Raw inspection by ID is a developer/debug concern, not an agent need.

---

## Glossary / Jargon Entries

Memory Bank isn't designed for structured reference data, but can be repurposed for glossary entries.

**Approach: use `directMemoriesSource`** to upload crafted entries:

```json
{
  "directMemoriesSource": {
    "directMemories": [{
      "fact": "ADK: Agent Development Kit, the open-source framework for building AI agents. Also known as: google/adk-python. Related: agents, tools, orchestration",
      "topics": [{ "customMemoryTopicId": { "label": "glossary" } }]
    }]
  }
}
```

**Why this works:**
- Synonyms embedded in the fact text make them searchable via similarity search
- Metadata `{type: "glossary"}` allows filtering glossary vs. conversational memories
- `REQUIRE_EXACT_MATCH` merge strategy prevents glossary entries from being consolidated with conversational memories
- Custom topic `glossary_jargon` enables auto-extraction from natural conversation too

---

## SDK & API

**Node.js SDK:** This plugin uses the official `@google-cloud/aiplatform` v1beta1 clients for Memory Bank and Reasoning Engine operations. Verify SDK surface availability against the installed package version when upgrading.

**Python SDK:** Official support via `google-cloud-aiplatform>=1.111.0`:
```python
import vertexai
client = vertexai.Client(project="...", location="...")
client.agent_engines.memories.generate(...)
client.agent_engines.memories.retrieve(...)
```

**Authentication:** Google Cloud Application Default Credentials (ADC). In this plugin, auth tokens are obtained via `gcloud auth application-default print-access-token` and cached for 55 minutes.

**Base URL format:**
```
https://{LOCATION}-aiplatform.googleapis.com/v1beta1/projects/{PROJECT}/locations/{LOCATION}/reasoningEngines/{ENGINE_ID}/memories:{action}
```

---

## Links & Resources

### Official Documentation
- [Memory Bank Overview](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview)
- [REST API Reference — Memories](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.reasoningEngines.memories)
- [REST API Reference — Generate](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.reasoningEngines.memories/generate)
- [REST API Reference — Retrieve](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.reasoningEngines.memories/retrieve)
- [Vertex AI Pricing (Agent Engine section)](https://cloud.google.com/vertex-ai/pricing#vertex-ai-agent-engine)
- [Memory Bank Public Preview Blog Post](https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview)

### Sample Notebooks
- [Memory Bank on ADK](https://github.com/GoogleCloudPlatform/generative-ai/blob/main/agents/agent_engine/memory_bank/get_started_with_memory_bank_on_adk.ipynb)
- [Memory Bank with LangGraph](https://github.com/GoogleCloudPlatform/generative-ai/blob/main/gemini/agent-engine/memory/get_started_with_memory_bank_langgraph.ipynb)
- [Memory on GKE](https://github.com/GoogleCloudPlatform/generative-ai/blob/main/agents/gke/agents_with_memory/get_started_with_memory_for_adk_in_gke.ipynb)

### Plugin Repository
- [openclaw-vertexai-memorybank](https://github.com/Shubhamsaboo/openclaw-vertexai-memorybank)

## Hermes Agent MCP

### Can I use this without OpenClaw?

Yes. `vertexai-memorybank-hermes` is a standalone MCP JSON-RPC-over-stdio entry point. Configure it in `~/.hermes/config.yaml` under `mcp_servers`; the OpenClaw plugin remains unchanged and is not required at runtime.

```yaml
mcp_servers:
  vertex_memorybank:
    command: "node"
    args: ["/absolute/path/openclaw-vertexai-memorybank/bin/hermes-mcp.js"]
    env:
      MEMORYBANK_PROJECT_ID: "${MEMORYBANK_PROJECT_ID}"
      MEMORYBANK_LOCATION: "${MEMORYBANK_LOCATION}"
      MEMORYBANK_REASONING_ENGINE_ID: "${MEMORYBANK_REASONING_ENGINE_ID}"
      # Hermes filters stdio child environments: choose one ADC route.
      GOOGLE_APPLICATION_CREDENTIALS: "/absolute/path/service-account.json"
      # Alternative: omit the line above and use gcloud user ADC:
      # HOME: "${HOME}"
      MEMORYBANK_SCOPE: '{"user_id":"your-user-id"}'
    trust: untrusted
    tools:
      include: [memorybank_search, memorybank_remember, memorybank_forget, memorybank_correct, memorybank_stats]
```

Hermes expands `${ENV_VAR}` values when connecting the server, but filters the environment of stdio children. Pass an absolute `GOOGLE_APPLICATION_CREDENTIALS` service-account JSON path, or pass `HOME` so the Google SDK can find user ADC created with `gcloud auth application-default login`. Do not leave an unresolved `${...}` value in required Memory Bank settings: Hermes preserves it literally and this server rejects it. Use `hermes mcp test vertex_memorybank` to test the connection and `/reload-mcp` after configuration changes. Hermes names discovered tools `mcp__vertex_memorybank__memorybank_search`, etc. Server stderr is written to `~/.hermes/logs/mcp-stderr.log`.

### How do I share memories between Hermes and OpenClaw?

Configure exactly the same Vertex project, location, reasoning engine, and scope in both runtimes. For example, OpenClaw can use `{ "user_id": "your-user-id" }` and Hermes can set `MEMORYBANK_SCOPE` to `'{"user_id":"your-user-id"}'`. The Hermes default is `{ "agent_name": "hermes" }`, so it does **not** share memories until you explicitly use a common scope.

### Is the Hermes MCP configuration safe to copy?

Review the absolute command path before trusting it. A stdio MCP server is a local process. Use `tools.include` to expose only the listed tools, and consider excluding `memorybank_forget` and `memorybank_correct` in profiles that should be read-only. Keep credentials out of the YAML: Hermes supports environment interpolation, while Vertex authentication uses Application Default Credentials.

### Why does MCP output look like JSON only?

That is intentional. MCP uses stdout as its wire protocol. This server writes JSON-RPC responses only to stdout and logs configuration and operational diagnostics to stderr, so Hermes can reliably parse requests and responses.
