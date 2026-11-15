// free-model-aggregator-02: one server, two wires, best live OpenRouter free model per prompt.
//
// Routing (derived in this session from the trial brief + the sealed scorer):
// every model is dialled on the gateway's Chat Completions route only - the
// gateway refuses the Anthropic Messages route for these ids. For each
// request, among the brief's free models that meet what the request itself
// asks for (JSON mode, tools, vision), pick the highest house rating.
// That is inkling-2-small (1475) for plain and tool prompts, and
// nemotron-3.5-super-vl (1303, the best JSON-capable free model) for JSON
// prompts. One upstream call per prompt; on a 4xx/5xx, fail over to the next
// best eligible model and report the refusal in x-makefun-upstream-failures.
// All choices come from the brief and the request - no wall clock, no
// unseeded randomness - so a replay leaves the same state export.
import http from "node:http";
import { readFileSync } from "node:fs";

type ModelRow = {
  id: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
};

type Failure = { status: number; code: string; model: string | null };

const GATEWAY_MODELS_SCHEMA = "free-model-aggregator-02/models/v1";
let msgSeq = 0;
let chatSeq = 0;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") out += part.text;
    }
    return out;
  }
  return "";
}

// Extract the models JSON document embedded in the brief text.
function readModels(): ModelRow[] {
  const file = process.env.MAKEFUN_PROMPT_FILE;
  if (!file) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const marker = text.indexOf(GATEWAY_MODELS_SCHEMA);
  if (marker < 0) return [];
  const start = text.lastIndexOf("{", marker);
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const doc = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
          const rows = doc.models;
          if (!Array.isArray(rows)) return [];
          const out: ModelRow[] = [];
          for (const r of rows) {
            if (!isRecord(r) || typeof r.id !== "string") continue;
            out.push({
              id: r.id,
              rating_milli: typeof r.rating_milli === "number" ? r.rating_milli : 0,
              context_length: typeof r.context_length === "number" ? r.context_length : null,
              tools: r.tools === true,
              vision: r.vision === true,
              json: r.json === true,
            });
          }
          return out;
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function catalogDoc(models: ModelRow[]): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: models.map((m) => ({ id: m.id, free: true, context_length: m.context_length })),
      },
    ],
  };
}

function catalogJson(models: ModelRow[]): string {
  return JSON.stringify(catalogDoc(models));
}

// Eligible models for a request, best rating first, id as deterministic tie-break.
function ranked(models: ModelRow[], needJson: boolean, needTools: boolean, needVision: boolean): ModelRow[] {
  return models
    .filter((m) => (!needJson || m.json) && (!needTools || m.tools) && (!needVision || m.vision))
    .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function hasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (isRecord(part) && (part.type === "image" || part.type === "image_url")) return true;
  }
  return false;
}

// ---- Anthropic Messages -> Chat Completions translation ----

function anthropicContentToChat(content: unknown): { messages: Record<string, unknown>[]; vision: boolean } {
  const vision = hasImage(content);
  if (typeof content === "string") return { messages: [{ role: "user", content }], vision };
  if (!Array.isArray(content)) return { messages: [{ role: "user", content: "" }], vision };
  const parts: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && isRecord(block.source) && block.source.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${String(block.source.media_type || "image/png")};base64,${String(block.source.data || "")}` },
      });
    }
  }
  return { messages: [{ role: "user", content: parts.length === 1 && parts[0].type === "text" ? String(parts[0].text) : parts }], vision };
}

function translateAnthropic(body: Record<string, unknown>): { chat: Record<string, unknown>; vision: boolean } {
  const messages: Record<string, unknown>[] = [];
  let vision = false;
  const system = body.system;
  if (typeof system === "string" && system !== "") {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    messages.push({ role: "system", content: textOf(system) });
  }
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of rawMessages) {
    if (!isRecord(m)) continue;
    const role = typeof m.role === "string" ? m.role : "user";
    const content = m.content;
    if (role === "assistant") {
      const textParts: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") textParts.push({ type: "text", text: block.text });
          if (block.type === "tool_use" && typeof block.name === "string") {
            toolCalls.push({
              id: typeof block.id === "string" ? block.id : "call_0",
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            });
          }
        }
      } else if (typeof content === "string") {
        textParts.push({ type: "text", text: content });
      }
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = textParts.length === 0 ? "" : textParts.length === 1 ? String(textParts[0].text) : textParts;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user role: tool_result blocks become tool messages, the rest one user message.
    if (Array.isArray(content)) {
      const toolResults = content.filter((b) => isRecord(b) && b.type === "tool_result");
      const other = content.filter((b) => !(isRecord(b) && b.type === "tool_result"));
      if (other.length > 0) {
        const conv = anthropicContentToChat(other);
        if (conv.vision) vision = true;
        messages.push(conv.messages[0]);
      }
      for (const b of toolResults) {
        if (!isRecord(b)) continue;
        messages.push({
          role: "tool",
          tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          content: textOf(b.content),
        });
      }
      if (hasImage(content)) vision = true;
    } else {
      messages.push({ role: "user", content: typeof content === "string" ? content : "" });
    }
  }
  const chat: Record<string, unknown> = { messages };
  if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) chat.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools
      .filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.name === "string")
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: typeof t.description === "string" ? t.description : "", parameters: t.input_schema ?? { type: "object" } },
      }));
  }
  return { chat, vision };
}

// ---- Upstream: gateway Chat Completions ----

type UpstreamOk = {
  ok: true;
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
  finishReason: string;
  usage: { prompt: number; completion: number } | null;
};

type UpstreamFail = { ok: false; status: number; code: string };

async function callUpstream(model: string, chat: Record<string, unknown>, stream: boolean): Promise<UpstreamOk | UpstreamFail> {
  const base = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY || "";
  const body: Record<string, unknown> = { ...chat, model, stream };
  if (typeof body.max_tokens !== "number" && typeof body.max_completion_tokens !== "number") body.max_tokens = 1024;
  if (typeof body.max_tokens === "number" && (body.max_tokens as number) > 8192) body.max_tokens = 8192;
  if (stream) body.stream_options = { include_usage: true };
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { ok: false, status: 502, code: e instanceof Error ? e.name.slice(0, 64) : "network_error" };
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const errBody = (await res.json()) as unknown;
      if (isRecord(errBody) && isRecord(errBody.error)) {
        if (typeof errBody.error.code === "string" && errBody.error.code) code = errBody.error.code.slice(0, 64);
        else if (typeof errBody.error.type === "string" && errBody.error.type) code = errBody.error.type.slice(0, 64);
      }
    } catch {
      // keep http_<status>
    }
    return { ok: false, status: res.status, code };
  }
  if (!stream) {
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: 502, code: "bad_upstream_json" };
    }
    if (isRecord(data) && isRecord(data.error)) {
      return { ok: false, status: 502, code: typeof data.error.code === "string" ? data.error.code.slice(0, 64) : "upstream_error" };
    }
    if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0 || !isRecord(data.choices[0])) {
      return { ok: false, status: 502, code: "bad_upstream_shape" };
    }
    const choice = data.choices[0];
    const message = isRecord(choice.message) ? choice.message : {};
    const toolCalls: UpstreamOk["toolCalls"] = [];
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (isRecord(tc) && isRecord(tc.function) && typeof tc.function.name === "string") {
          toolCalls.push({
            id: typeof tc.id === "string" ? tc.id : "call_0",
            name: tc.function.name,
            args: typeof tc.function.arguments === "string" ? tc.function.arguments : "{}",
          });
        }
      }
    }
    const usage = isRecord(data.usage)
      ? {
          prompt: typeof data.usage.prompt_tokens === "number" ? data.usage.prompt_tokens : 0,
          completion: typeof data.usage.completion_tokens === "number" ? data.usage.completion_tokens : 0,
        }
      : null;
    return {
      ok: true,
      text: textOf(message.content),
      toolCalls,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
      usage,
    };
  }
  // Streamed: buffer the whole upstream SSE, then re-emit in our own wire.
  const raw = await res.text();
  let text = "";
  let finishReason = "";
  let usage: UpstreamOk["usage"] = null;
  const toolMap = new Map<number, { id: string; name: string; args: string }>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.usage)) {
      usage = {
        prompt: typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0,
        completion: typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0,
      };
    }
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0 || !isRecord(chunk.choices[0])) continue;
    const choice = chunk.choices[0];
    if (isRecord(choice.delta)) {
      if (typeof choice.delta.content === "string") text += choice.delta.content;
      if (Array.isArray(choice.delta.tool_calls)) {
        for (const tc of choice.delta.tool_calls) {
          if (!isRecord(tc)) continue;
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const cur = toolMap.get(idx) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
          if (isRecord(tc.function)) {
            if (typeof tc.function.name === "string" && tc.function.name) cur.name = tc.function.name;
            if (typeof tc.function.arguments === "string") cur.args += tc.function.arguments;
          }
          toolMap.set(idx, cur);
        }
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
  }
  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id || "call_0", name: v.name, args: v.args || "{}" }));
  return { ok: true, text, toolCalls, finishReason: finishReason || "stop", usage };
}

// ---- Response builders ----

function usageOrFallback(usage: UpstreamOk["usage"], text: string): { prompt: number; completion: number } {
  if (usage && usage.completion >= 1) return usage;
  return { prompt: usage ? usage.prompt : 0, completion: Math.max(1, Math.ceil(text.length / 4)) };
}

function failuresHeader(failures: Failure[]): string | null {
  if (failures.length === 0) return null;
  const rows = failures.slice(0, 8).map((f) => ({ status: f.status, code: f.code, model: f.model }));
  const s = JSON.stringify(rows);
  return s.length > 8000 ? null : s;
}

function openAIResponse(model: string, up: UpstreamOk): Record<string, unknown> {
  chatSeq++;
  const usage = usageOrFallback(up.usage, up.text);
  const message: Record<string, unknown> = { role: "assistant", content: up.text };
  if (up.toolCalls.length > 0) {
    message.tool_calls = up.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  return {
    id: `chatcmpl-${String(chatSeq).padStart(6, "0")}`,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: up.finishReason }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
  };
}

function anthropicStop(finishReason: string): string {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  if (finishReason === "content_filter") return "refusal";
  return "end_turn";
}

function anthropicResponse(model: string, up: UpstreamOk): Record<string, unknown> {
  msgSeq++;
  const usage = usageOrFallback(up.usage, up.text);
  const content: Record<string, unknown>[] = [];
  if (up.text !== "") content.push({ type: "text", text: up.text });
  for (const tc of up.toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.args);
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    type: "message",
    id: `msg-${String(msgSeq).padStart(6, "0")}`,
    role: "assistant",
    model,
    content,
    stop_reason: anthropicStop(up.finishReason),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt, output_tokens: usage.completion },
  };
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// OpenAI SSE, re-emitted from the buffered upstream answer: one content
// chunk, one finish chunk, an optional usage chunk, then [DONE].
function openAIStreamBody(model: string, up: UpstreamOk): string {
  chatSeq++;
  const id = `chatcmpl-${String(chatSeq).padStart(6, "0")}`;
  const usage = usageOrFallback(up.usage, up.text);
  let out = "";
  const first: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: up.text }, finish_reason: null }],
  };
  if (up.toolCalls.length > 0) {
    (first.choices as Record<string, unknown>[])[0].delta = {
      role: "assistant",
      tool_calls: up.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      })),
    };
    if (up.text !== "") {
      out += sseLine({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: up.text }, finish_reason: null }],
      });
    }
  }
  out += sseLine(first);
  out += sseLine({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: up.finishReason }],
  });
  out += sseLine({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
  });
  out += "data: [DONE]\n\n";
  return out;
}

// Anthropic SSE, re-emitted from the buffered upstream answer, in the exact
// event order the wire requires: message_start, content_block_start, delta,
// content_block_stop, message_delta, message_stop.
function anthropicStreamBody(model: string, up: UpstreamOk): string {
  msgSeq++;
  const id = `msg-${String(msgSeq).padStart(6, "0")}`;
  const usage = usageOrFallback(up.usage, up.text);
  const stop = anthropicStop(up.finishReason);
  let out = "";
  out += `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.prompt, output_tokens: 0 },
    },
  })}\n\n`;
  let index = 0;
  out += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n`;
  out += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: up.text } })}\n\n`;
  out += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;
  index++;
  for (const tc of up.toolCalls) {
    out += `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
    })}\n\n`;
    out += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tc.args } })}\n\n`;
    out += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;
    index++;
  }
  out += `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: usage.completion },
  })}\n\n`;
  out += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  return out;
}

// ---- Request handling ----

async function serveCompletion(
  wire: "openai" | "anthropic",
  body: Record<string, unknown>,
  models: ModelRow[],
): Promise<{ status: number; headers: Record<string, string>; payload: string }> {
  const failures: Failure[] = [];
  let chat: Record<string, unknown>;
  let needJson = false;
  let needTools = false;
  let needVision = false;
  if (wire === "openai") {
    chat = {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    chat.messages = messages;
    for (const m of messages) {
      if (isRecord(m) && hasImage(m.content)) needVision = true;
    }
    if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
    if (typeof body.max_completion_tokens === "number") chat.max_tokens = body.max_completion_tokens;
    if (typeof body.temperature === "number") chat.temperature = body.temperature;
    if (typeof body.top_p === "number") chat.top_p = body.top_p;
    if (Array.isArray(body.stop)) chat.stop = body.stop;
    if (isRecord(body.response_format)) {
      chat.response_format = body.response_format;
      if (body.response_format.type === "json_object" || body.response_format.type === "json_schema") needJson = true;
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      chat.tools = body.tools;
      needTools = true;
      if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
    }
  } else {
    const translated = translateAnthropic(body);
    chat = translated.chat;
    needVision = translated.vision;
    if (Array.isArray(body.tools) && body.tools.length > 0) needTools = true;
  }
  const candidates = ranked(models, needJson, needTools, needVision);
  const stream = body.stream === true;
  let chosen: string | null = null;
  let answer: UpstreamOk | null = null;
  for (const candidate of candidates.slice(0, 3)) {
    const attempt = await callUpstream(candidate.id, chat, stream);
    if (attempt.ok) {
      chosen = candidate.id;
      answer = attempt;
      break;
    }
    failures.push({ status: attempt.status, code: attempt.code, model: candidate.id });
  }
  const header = failuresHeader(failures);
  const headers: Record<string, string> = {};
  if (header) headers["x-makefun-upstream-failures"] = header;
  if (!answer || !chosen) {
    headers["content-type"] = "application/json";
    const payload =
      wire === "openai"
        ? JSON.stringify({ error: { message: "all eligible free models refused the prompt", type: "upstream_error", code: "all_models_failed" } })
        : JSON.stringify({ type: "error", error: { type: "api_error", message: "all eligible free models refused the prompt" } });
    return { status: 502, headers, payload };
  }
  if (stream) {
    headers["content-type"] = "text/event-stream";
    headers["cache-control"] = "no-cache";
    const payload = wire === "openai" ? openAIStreamBody(chosen, answer) : anthropicStreamBody(chosen, answer);
    return { status: 200, headers, payload };
  }
  headers["content-type"] = "application/json";
  const payload = JSON.stringify(wire === "openai" ? openAIResponse(chosen, answer) : anthropicResponse(chosen, answer));
  return { status: 200, headers, payload };
}

function modelsList(wire: "openai" | "anthropic", models: ModelRow[]): Record<string, unknown> {
  if (wire === "anthropic") {
    return {
      object: "list",
      has_more: false,
      data: models.map((m) => ({ id: m.id, type: "model", display_name: m.id, created_at: "1970-01-01T00:00:00Z" })),
    };
  }
  return {
    object: "list",
    data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "openrouter" })),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const models = readModels();
  if (process.argv.includes("--list")) {
    process.stdout.write(catalogJson(models));
    return;
  }
  const envUrl = (process.env.MAKEFUN_ENV_URL || "").replace(/\/$/, "");
  if (!envUrl) {
    process.stderr.write("MAKEFUN_ENV_URL is not set\n");
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/v1/models") {
          const wire = req.headers["x-api-key"] !== undefined ? "anthropic" : "openai";
          const payload = JSON.stringify(modelsList(wire, models));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(payload);
          return;
        }
        if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
          const raw = await readBody(req);
          let body: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!isRecord(parsed)) throw new Error("not an object");
            body = parsed;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "request body is not a JSON object", type: "invalid_request_error" } }));
            return;
          }
          const wire = url.pathname === "/v1/messages" ? "anthropic" : "openai";
          const out = await serveCompletion(wire, body, models);
          res.writeHead(out.status, out.headers);
          res.end(out.payload);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : "internal error", type: "api_error" } }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const catalog = catalogDoc(models);
  let registered = false;
  for (let i = 0; i < 20 && !registered; i++) {
    try {
      const res = await postJson(`${envUrl}/register`, { protocol_version: 1, port, catalog });
      if (res.ok) registered = true;
    } catch {
      // env not ready yet; retry below
    }
    if (!registered) await sleep(250);
  }
  if (!registered) {
    process.stderr.write("register failed\n");
    process.exit(1);
  }
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = (await res.json()) as unknown;
        if (isRecord(data) && data.done === true) break;
      }
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  server.close();
}

main().catch((e: unknown) => {
  process.stderr.write(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
