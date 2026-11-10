// MiniMax text API client (OpenAI-compatible endpoint).
//
// The executor needs three things the Claude Agent SDK used to provide:
// a chat call, a tool-calling loop and structured output. This module owns only
// the transport; the loop lives in agent.js.
//
// Base URL for the international region is https://api.minimax.io (NOT the China
// region). The key goes in `Authorization: Bearer <key>`.

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';

export class MiniMaxError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'MiniMaxError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class MiniMaxClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('MINIMAX_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.fetch = fetchImpl;
  }

  async request(path, body, { signal, method = 'POST' } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // Never echo the key: only the server's own message reaches the log.
      const message = parsed?.error?.message || parsed?.message || `HTTP ${response.status}`;
      throw new MiniMaxError(`MiniMax ${method} ${path}: ${message}`, {
        status: response.status,
        code: parsed?.error?.code || parsed?.code || null,
        body: parsed,
      });
    }
    return parsed;
  }

  // One chat turn. Returns the raw assistant message so the caller can echo it
  // back unchanged on the next turn: MiniMax reasoning models put bookkeeping
  // fields (reasoning_content) next to the content, and dropping them breaks
  // multi-step tool calls.
  async chat({
    messages,
    system,
    tools,
    model,
    temperature,
    maxTokens,
    reasoningEffort,
    toolChoice,
    responseFormat,
    signal,
  } = {}) {
    const body = {
      model: model || this.model,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      stream: false,
    };
    if (tools?.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (typeof temperature === 'number') body.temperature = temperature;
    if (maxTokens) body.max_completion_tokens = maxTokens;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (responseFormat) body.response_format = responseFormat;

    const data = await this.request('/chat/completions', body, { signal });
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    const toolCalls = (message.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
    }));
    return {
      content: typeof message.content === 'string' ? message.content : '',
      reasoning: message.reasoning_content || '',
      toolCalls,
      finishReason: choice?.finish_reason || 'stop',
      usage: data?.usage || null,
      raw: message,
      model: data?.model || body.model,
    };
  }
}

// Tool definitions travel as plain JSON Schema. MiniMax expects the OpenAI shape.
export const toolDefinition = ({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters: parameters || { type: 'object', properties: {} } },
});

// Tool arguments come back as a JSON string. A model can emit a truncated or
// wrapped fragment, so parse defensively instead of throwing the whole run away.
export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    return {};
  }
}
