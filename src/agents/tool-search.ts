import { spawn } from "node:child_process";
import os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  type HookContext,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { asToolParamsRecord, jsonResult, ToolInputError } from "./tools/common.js";
import type { AnyAgentTool } from "./tools/common.js";

export const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
export const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export const TOOL_CALL_RAW_TOOL_NAME = "tool_call";

const TOOL_SEARCH_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

const DEFAULT_CODE_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;

type ToolSearchMode = "code" | "tools";
type CatalogSource = "openclaw" | "mcp" | "client";
type CatalogTool = AnyAgentTool | ToolDefinition;

export type ToolSearchConfig = {
  enabled: boolean;
  mode: ToolSearchMode;
  codeTimeoutMs: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

export type ToolSearchToolContext = {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  tool: CatalogTool;
};

type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  searchCount: number;
  describeCount: number;
  callCount: number;
};

type CodeModeBridgeMethod = "search" | "describe" | "call";

type CodeModeChildMessage =
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error?: string }
  | { type: "log"; items?: unknown[] }
  | { type: "bridge"; id?: unknown; method?: unknown; args?: unknown };

type CodeModeBridgeResultMessage = {
  type: "bridge-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

const TOOL_SEARCH_CODE_MODE_CHILD_SOURCE = String.raw`
import vm from "node:vm";

const pending = new Map();
let nextBridgeId = 1;

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function toJsonSafe(value) {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

function formatLogItem(value) {
  if (typeof value === "string") {
    return value;
  }
  const safe = toJsonSafe(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}

function bridge(method, args) {
  const id = String(nextBridgeId++);
  send({ type: "bridge", id, method, args });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function settleBridge(message) {
  const id = typeof message?.id === "string" ? message.id : "";
  const waiter = pending.get(id);
  if (!waiter) {
    return;
  }
  pending.delete(id);
  if (message.ok) {
    waiter.resolve(message.value);
  } else {
    waiter.reject(new Error(typeof message.error === "string" ? message.error : "tool bridge failed"));
  }
}

async function runModelCode(code, timeoutMs) {
  const sandbox = Object.create(null);
  const consoleBridge = Object.freeze({
    log: (...items) => send({ type: "log", items: items.map(formatLogItem) }),
    warn: (...items) => send({ type: "log", items: items.map(formatLogItem) }),
    error: (...items) => send({ type: "log", items: items.map(formatLogItem) }),
  });
  const openclaw = Object.freeze({
    tools: Object.freeze({
      search: (query, options) => bridge("search", [query, options]),
      describe: (id) => bridge("describe", [id]),
      call: (id, input) => bridge("call", [id, input]),
    }),
  });
  Object.defineProperties(sandbox, {
    console: { value: consoleBridge, enumerable: true },
    openclaw: { value: openclaw, enumerable: true },
  });
  const context = vm.createContext(sandbox, {
    name: "tool_search_code",
    codeGeneration: { strings: false, wasm: false },
  });
  const wrappedCode =
    '"use strict";\n(async (openclaw, console) => {\n' +
    code +
    "\n})(openclaw, console)";
  const script = new vm.Script(wrappedCode, { filename: "tool_search_code:model.js" });
  const value = await script.runInContext(context, {
    timeout: Math.max(1, Math.min(Number(timeoutMs) || 1, 2147483647)),
    breakOnSigint: false,
  });
  send({ type: "result", ok: true, value: toJsonSafe(value) });
}

process.on("message", (message) => {
  if (message?.type === "bridge-result") {
    settleBridge(message);
    return;
  }
  if (message?.type !== "run") {
    return;
  }
  const code = typeof message.code === "string" ? message.code : "";
  runModelCode(code, message.timeoutMs).catch((error) => {
    send({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    process.exit(0);
  });
});
`;

const SESSION_CATALOGS_KEY = Symbol.for("openclaw.toolSearch.sessionCatalogs");
const globalToolSearchState = globalThis as typeof globalThis & {
  [SESSION_CATALOGS_KEY]?: Map<string, ToolSearchCatalogSession>;
};
const sessionCatalogs =
  globalToolSearchState[SESSION_CATALOGS_KEY] ??
  (globalToolSearchState[SESSION_CATALOGS_KEY] = new Map<string, ToolSearchCatalogSession>());

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readToolSearchConfig(config?: OpenClawConfig): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const toolSearch = tools?.toolSearch;
  if (toolSearch === true) {
    return { enabled: true };
  }
  if (toolSearch === false) {
    return { enabled: false };
  }
  return isRecord(toolSearch) ? toolSearch : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig {
  const raw = readToolSearchConfig(config);
  const rawMode = typeof raw.mode === "string" ? raw.mode : "code";
  const mode: ToolSearchMode = rawMode === "tools" || rawMode === "code" ? rawMode : "code";
  const configured = Object.keys(raw).some((key) => key !== "enabled");
  const maxSearchLimit = Math.max(
    1,
    Math.min(50, readInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT)),
  );
  return {
    enabled: readBoolean(raw.enabled, configured),
    mode,
    codeTimeoutMs: Math.max(
      1000,
      Math.min(60_000, readInteger(raw.codeTimeoutMs, DEFAULT_CODE_TIMEOUT_MS)),
    ),
    searchDefaultLimit: Math.max(
      1,
      Math.min(maxSearchLimit, readInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT)),
    ),
    maxSearchLimit,
  };
}

function sessionCatalogKeys(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): string[] {
  const keys: string[] = [];
  if (input.sessionId?.trim()) {
    keys.push(`session:${input.sessionId.trim()}`);
  }
  if (input.sessionKey?.trim()) {
    keys.push(`key:${input.sessionKey.trim()}`);
  }
  if (input.agentId?.trim()) {
    keys.push(`agent:${input.agentId.trim()}`);
  }
  return [...new Set(keys)];
}

function sessionCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  return sessionCatalogKeys(input)[0];
}

function classifyTool(tool: CatalogTool): { source: CatalogSource; sourceName?: string } {
  const meta = getPluginToolMeta(tool as AnyAgentTool);
  const pluginId = meta?.pluginId?.trim();
  if (pluginId === "bundle-mcp") {
    return { source: "mcp", sourceName: pluginId };
  }
  if (pluginId) {
    return { source: "openclaw", sourceName: pluginId };
  }
  return { source: "openclaw", sourceName: "core" };
}

function makeCatalogId(tool: CatalogTool, source: CatalogSource, sourceName?: string): string {
  const owner = sourceName?.trim() || "core";
  return `${source}:${owner}:${tool.name}`;
}

function wrapCatalogTool(tool: AnyAgentTool, hookContext?: HookContext): AnyAgentTool {
  if (!hookContext || isToolWrappedWithBeforeToolCallHook(tool)) {
    return tool;
  }
  return wrapToolWithBeforeToolCallHook(tool, hookContext);
}

function toCatalogEntry(
  tool: CatalogTool,
  sourceOverride?: CatalogSource,
  hookContext?: HookContext,
): ToolSearchCatalogEntry {
  const classified = classifyTool(tool);
  const source = sourceOverride ?? classified.source;
  const sourceName = sourceOverride === "client" ? "client" : classified.sourceName;
  const catalogTool =
    source === "client" ? tool : wrapCatalogTool(tool as AnyAgentTool, hookContext);
  return {
    id: makeCatalogId(tool, source, sourceName),
    source,
    sourceName,
    name: tool.name,
    label: tool.label,
    description: tool.description ?? "",
    parameters: tool.parameters,
    tool: catalogTool,
  };
}

function shouldCatalogTool(tool: AnyAgentTool): boolean {
  if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
    return false;
  }
  return true;
}

function shouldExposeControlTool(name: string, mode: ToolSearchMode): boolean {
  if (name === TOOL_SEARCH_CODE_MODE_TOOL_NAME) {
    return mode === "code";
  }
  if (
    name === TOOL_SEARCH_RAW_TOOL_NAME ||
    name === TOOL_DESCRIBE_RAW_TOOL_NAME ||
    name === TOOL_CALL_RAW_TOOL_NAME
  ) {
    return mode === "tools";
  }
  return false;
}

export function applyToolSearchCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  toolHookContext?: HookContext;
}): { tools: AnyAgentTool[]; compacted: boolean; catalogToolCount: number } {
  const config = resolveToolSearchConfig(params.config);
  if (!config.enabled) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  const hasControlTool = params.tools.some(
    (tool) =>
      TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) &&
      shouldExposeControlTool(tool.name, config.mode),
  );
  const key = sessionCatalogKey(params);
  if (!hasControlTool || !key) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }

  const visible: AnyAgentTool[] = [];
  const catalog: ToolSearchCatalogEntry[] = [];
  for (const tool of params.tools) {
    if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
      if (shouldExposeControlTool(tool.name, config.mode)) {
        visible.push(tool);
      }
      continue;
    }
    if (shouldCatalogTool(tool)) {
      catalog.push(toCatalogEntry(tool, undefined, params.toolHookContext));
      continue;
    }
    visible.push(tool);
  }
  registerToolSearchCatalog({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    entries: catalog,
    append: false,
  });
  return { tools: visible, compacted: catalog.length > 0, catalogToolCount: catalog.length };
}

export function addClientToolsToToolSearchCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const config = resolveToolSearchConfig(params.config);
  const key = sessionCatalogKey(params);
  if (!config.enabled || !key) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  const existing = sessionCatalogs.get(key);
  if (!existing) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  registerToolSearchCatalog({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
    append: true,
  });
  return { tools: [], compacted: params.tools.length > 0, catalogToolCount: params.tools.length };
}

export function registerToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  entries: ToolSearchCatalogEntry[];
  append?: boolean;
}): void {
  const keys = sessionCatalogKeys(params);
  if (keys.length === 0) {
    return;
  }
  const primaryKey = keys[0];
  if (!primaryKey) {
    return;
  }
  const prior = params.append ? sessionCatalogs.get(primaryKey) : undefined;
  const byId = new Map<string, ToolSearchCatalogEntry>();
  for (const entry of prior?.entries ?? []) {
    byId.set(entry.id, entry);
  }
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
    byId.set(entry.name, entry);
  }
  const next = {
    entries: [...new Set(byId.values())].toSorted((a, b) => a.id.localeCompare(b.id)),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  for (const key of keys) {
    sessionCatalogs.set(key, next);
  }
}

export function clearToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): void {
  for (const key of sessionCatalogKeys(params)) {
    sessionCatalogs.delete(key);
  }
}

function resolveCatalog(ctx: ToolSearchToolContext): ToolSearchCatalogSession {
  for (const key of sessionCatalogKeys({
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
  })) {
    const catalog = sessionCatalogs.get(key);
    if (catalog) {
      return catalog;
    }
  }
  const uniqueCatalogs = [...new Set(sessionCatalogs.values())];
  if (uniqueCatalogs.length === 1) {
    const catalog = uniqueCatalogs[0];
    if (catalog) {
      return catalog;
    }
  }
  throw new ToolInputError("Tool Search catalog is unavailable for this run.");
}

function compactEntry(entry: ToolSearchCatalogEntry) {
  return {
    id: entry.id,
    source: entry.source,
    sourceName: entry.sourceName,
    name: entry.name,
    label: entry.label,
    description: entry.description,
  };
}

function describeEntry(entry: ToolSearchCatalogEntry) {
  return {
    ...compactEntry(entry),
    parameters: entry.parameters ?? {},
  };
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreEntry(entry: ToolSearchCatalogEntry, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term || id === term) {
      score += 20;
    }
    if (name.includes(term)) {
      score += 8;
    }
    if (id.includes(term)) {
      score += 6;
    }
    if (label.includes(term)) {
      score += 4;
    }
    if (description.includes(term)) {
      score += 2;
    }
  }
  return score;
}

function findEntry(catalog: ToolSearchCatalogSession, id: string): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entry = catalog.entries.find(
    (candidate) => candidate.id === needle || candidate.name === needle,
  );
  if (!entry) {
    throw new ToolInputError(`Unknown tool id: ${needle}`);
  }
  return entry;
}

function readId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = params.id ?? params.toolId ?? params.name;
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

function readLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readSearchArgs(args: unknown, config: ToolSearchConfig): { query: string; limit: number } {
  const params = asToolParamsRecord(args);
  const query = params.query;
  if (typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const options = isRecord(params.options) ? params.options : undefined;
  return {
    query,
    limit: readLimit(params.limit ?? options?.limit, config),
  };
}

function readCallArgs(args: unknown): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const id = readId(params);
  return {
    id,
    input: params.args ?? params.input ?? {},
  };
}

function getTelemetry(catalog: ToolSearchCatalogSession) {
  const sources: Record<CatalogSource, number> = {
    openclaw: 0,
    mcp: 0,
    client: 0,
  };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
  };
}

class ToolSearchRuntime {
  private callSequence = 0;

  constructor(
    private readonly ctx: ToolSearchToolContext,
    private readonly config: ToolSearchConfig,
  ) {}

  search = async (query: string, options?: { limit?: number }) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.searchCount += 1;
    const limit = readLimit(options?.limit, this.config);
    const terms = tokenize(query);
    return catalog.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((hit) => hit.score > 0)
      .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit)
      .map((hit) => compactEntry(hit.entry));
  };

  describe = async (id: string) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.describeCount += 1;
    return describeEntry(findEntry(catalog, id));
  };

  call = async (id: string, input?: unknown) => {
    const catalog = resolveCatalog(this.ctx);
    const entry = findEntry(catalog, id);
    catalog.callCount += 1;
    const execute = entry.tool.execute as (
      toolCallId: string,
      input: unknown,
    ) => Promise<AgentToolResult<unknown>>;
    const toolCallId = `tool_search_code:${entry.name}:${++this.callSequence}`;
    const result = await execute(toolCallId, input ?? {});
    return {
      tool: compactEntry(entry),
      result,
    };
  };

  telemetry() {
    return getTelemetry(resolveCatalog(this.ctx));
  }
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

async function runCodeMode(params: {
  ctx: ToolSearchToolContext;
  code: string;
  config: ToolSearchConfig;
}) {
  const runtime = new ToolSearchRuntime(params.ctx, params.config);
  const logs: string[] = [];
  const value = await runCodeModeChild({
    code: params.code,
    config: params.config,
    logs,
    runtime,
  });
  return {
    ok: true,
    value: toJsonSafe(value),
    logs,
    telemetry: runtime.telemetry(),
  };
}

function buildCodeModeChildArgs(): string[] {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
    throw new ToolInputError("tool_search_code requires a Node runtime with --permission support.");
  }
  return ["--permission", "--input-type=module", "--eval", TOOL_SEARCH_CODE_MODE_CHILD_SOURCE];
}

function isCodeModeBridgeMethod(value: unknown): value is CodeModeBridgeMethod {
  return value === "search" || value === "describe" || value === "call";
}

async function runCodeModeBridgeRequest(
  runtime: ToolSearchRuntime,
  method: CodeModeBridgeMethod,
  args: unknown,
): Promise<unknown> {
  const values = Array.isArray(args) ? args : [];
  switch (method) {
    case "search": {
      const query = values[0];
      if (typeof query !== "string") {
        throw new ToolInputError("search query must be a string.");
      }
      const options = isRecord(values[1]) ? values[1] : undefined;
      return await runtime.search(query, {
        limit: typeof options?.limit === "number" ? options.limit : undefined,
      });
    }
    case "describe": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("describe id must be a string.");
      }
      return await runtime.describe(id);
    }
    case "call": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("call id must be a string.");
      }
      return await runtime.call(id, values[1] ?? {});
    }
  }
  throw new ToolInputError("Unsupported tool_search_code bridge method.");
}

function runCodeModeChild(params: {
  code: string;
  config: ToolSearchConfig;
  logs: string[];
  runtime: ToolSearchRuntime;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildCodeModeChildArgs(), {
      cwd: os.tmpdir(),
      env: {},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      settle(() => reject(new Error("tool_search_code timed out")));
    }, params.config.codeTimeoutMs);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      const suffix = stderr.join("").trim();
      const detail = suffix ? `: ${suffix.slice(0, 500)}` : "";
      settle(() =>
        reject(
          new Error(
            timedOut
              ? "tool_search_code timed out"
              : `tool_search_code child exited with ${signal ?? code}${detail}`,
          ),
        ),
      );
    });
    child.on("message", (message: CodeModeChildMessage) => {
      if (!isRecord(message) || typeof message.type !== "string") {
        return;
      }
      if (message.type === "log") {
        const items = Array.isArray(message.items) ? message.items : [];
        params.logs.push(items.map((item) => String(item)).join(" "));
        return;
      }
      if (message.type === "result") {
        if (message.ok) {
          settle(() => resolve(message.value));
        } else {
          settle(() =>
            reject(new Error(typeof message.error === "string" ? message.error : "code failed")),
          );
        }
        return;
      }
      if (message.type !== "bridge") {
        return;
      }
      const id = typeof message.id === "string" ? message.id : "";
      const method = isCodeModeBridgeMethod(message.method) ? message.method : undefined;
      if (!id || !method) {
        return;
      }
      void runCodeModeBridgeRequest(params.runtime, method, message.args)
        .then((value) => {
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: true,
            value: toJsonSafe(value),
          };
          child.send(response);
        })
        .catch((error: unknown) => {
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          child.send(response);
        });
    });

    child.send({
      type: "run",
      code: params.code,
      timeoutMs: params.config.codeTimeoutMs,
    });
  });
}

function readCode(args: unknown): string {
  const params = asToolParamsRecord(args);
  const code = params.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new ToolInputError("code must be a non-empty string.");
  }
  return code;
}

export function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[] {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const runtime = new ToolSearchRuntime(ctx, config);
  return [
    {
      name: TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      label: "Tool Search Code",
      description:
        "Run JavaScript in an isolated Node subprocess with openclaw.tools.search, openclaw.tools.describe, and openclaw.tools.call for large tool catalogs.",
      parameters: Type.Object({
        code: Type.String({
          description:
            "JavaScript body for an async function. Use return to return the final value. The openclaw.tools bridge is available.",
        }),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        jsonResult(await runCodeMode({ ctx, code: readCode(args), config })),
    },
    {
      name: TOOL_SEARCH_RAW_TOOL_NAME,
      label: "Tool Search",
      description: "Search the effective Tool Search catalog.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const search = readSearchArgs(args, config);
        return jsonResult(await runtime.search(search.query, { limit: search.limit }));
      },
    },
    {
      name: TOOL_DESCRIBE_RAW_TOOL_NAME,
      label: "Tool Describe",
      description: "Load the full schema and metadata for one search result.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        jsonResult(await runtime.describe(readId(args))),
    },
    {
      name: TOOL_CALL_RAW_TOOL_NAME,
      label: "Tool Call",
      description: "Call a selected Tool Search catalog entry through OpenClaw.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }),
        ),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const call = readCallArgs(args);
        return jsonResult(await runtime.call(call.id, call.input));
      },
    },
  ];
}

export const __testing = {
  sessionCatalogs,
  resolveToolSearchConfig,
  applyToolSearchCatalog,
  addClientToolsToToolSearchCatalog,
};
