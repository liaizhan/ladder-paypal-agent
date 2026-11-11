// Claude first, Llama as fallback. Every agent in this app talks to one small interface,
// AiBinding.run(model, input), in the Workers AI shape. This file gives that interface a
// Claude backend: it turns the Workers AI input into a Claude Messages API request, sends it
// with the official Anthropic SDK, and turns the answer back into the Workers AI shape
// ({ response } for text, { tool_calls } for a tool call). If there is no API key, or the
// Claude call fails for any reason, the same input goes to Llama 3.3 on Workers AI, so the
// demo never stops. The server-side guards (tool allow-lists, enums, catalog prices) stay
// the same whichever model answers.

import Anthropic from '@anthropic-ai/sdk';
import type { AiBinding } from './agent.ts';

type Msg = { role: string; content: unknown };
type ClaudeMsg = { role: 'user' | 'assistant'; content: string };
type FlatTool = { name: string; description?: string; parameters?: unknown };
/** Agents pass tools either flat or in the OpenAI shape { type: 'function', function: {...} }. */
type AnyTool = FlatTool | { type?: string; function?: FlatTool };
const flat = (t: AnyTool): FlatTool => ((t as { function?: FlatTool }).function ?? (t as FlatTool));

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMsg[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' };
  output_config?: { effort: 'low' | 'medium' | 'high' };
}

/** The one SDK method we use, so tests can pass a stub instead of a real client. */
export interface ClaudeClientLike {
  messages: { create(req: ClaudeRequest): Promise<unknown> };
}

const MIN_TOKENS = 512;
const JSON_ONLY = 'Reply with one JSON object only, no text before or after it.';

const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));

/** Workers AI input in, Claude Messages API request out. Exported for tests. */
export function toClaudeRequest(model: string, input: Record<string, unknown>): ClaudeRequest {
  const raw = (Array.isArray(input.messages) ? input.messages : []) as Msg[];
  const system: string[] = [];
  const messages: ClaudeMsg[] = [];
  let seenChat = false;
  for (const m of raw) {
    const content = text(m?.content).trim();
    if (!content) continue;
    if (m.role === 'system') {
      // Leading system messages become the system prompt; a system note later in the
      // conversation stays in place as an app note inside a user turn.
      if (!seenChat) system.push(content);
      else push(messages, 'user', `[App note] ${content}`);
      continue;
    }
    seenChat = true;
    push(messages, m.role === 'assistant' ? 'assistant' : 'user', content);
  }
  // The API wants a user turn first and last (no assistant prefill on current models).
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(The conversation starts.)' });
  if (messages[messages.length - 1].role !== 'user') push(messages, 'user', '[App note] Continue.');

  const fmt = input.response_format as { type?: string } | undefined;
  if (fmt?.type === 'json_object') system.push(JSON_ONLY);

  const req: ClaudeRequest = {
    model,
    max_tokens: Math.max(Number(input.max_tokens) || 0, MIN_TOKENS),
    messages,
    output_config: { effort: 'low' },
  };
  if (system.length) req.system = system.join('\n\n');
  const tools = (Array.isArray(input.tools) ? (input.tools as AnyTool[]) : []).map(flat).filter((t) => typeof t?.name === 'string');
  if (tools.length) {
    req.tools = tools.map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 1000),
      input_schema: schemaOf(t.parameters),
    }));
    req.tool_choice = { type: 'auto' };
  }
  // temperature is left out on purpose: current Claude models only take the default.
  return req;
}

/** The PayPal toolkit ships zod-made schemas with a "$schema" line; Claude only needs the object schema. */
function schemaOf(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== 'object') return { type: 'object', properties: {} };
  const { $schema: _drop, ...rest } = p as Record<string, unknown>;
  return { type: 'object', ...rest };
}

function push(list: ClaudeMsg[], role: 'user' | 'assistant', content: string) {
  const last = list[list.length - 1];
  if (last && last.role === role) last.content += '\n\n' + content;
  else list.push({ role, content });
}

/** Claude answer in, Workers AI shape out. Exported for tests. */
export function fromClaudeMessage(msg: unknown): { response?: string; tool_calls?: Array<{ name: string; arguments: unknown }> } {
  const blocks = ((msg as { content?: unknown })?.content ?? []) as Array<Record<string, unknown>>;
  const calls = blocks
    .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({ name: b.name as string, arguments: b.input ?? {} }));
  if (calls.length) return { tool_calls: calls };
  const out = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!out) throw new Error('Claude returned no text and no tool call');
  return { response: out };
}

export interface ClaudeBindingOptions {
  apiKey?: string;
  claudeModel: string;
  fallback: AiBinding;
  /** Called once per request that went to Llama instead, for the log line. */
  onFallback?: (reason: string) => void;
  client?: ClaudeClientLike;
}

/**
 * An AiBinding that asks Claude first and falls back to Workers AI. The `model` argument the
 * agents pass (the Llama model id) is used only for the fallback call.
 */
export function makeClaudeBinding(opts: ClaudeBindingOptions): AiBinding {
  const client: ClaudeClientLike | null =
    opts.client ?? (opts.apiKey ? (new Anthropic({ apiKey: opts.apiKey, timeout: 20_000, maxRetries: 1 }) as unknown as ClaudeClientLike) : null);
  return {
    async run(fallbackModel, input) {
      if (!client) {
        opts.onFallback?.('no ANTHROPIC_API_KEY');
        return opts.fallback.run(fallbackModel, input);
      }
      try {
        const msg = await client.messages.create(toClaudeRequest(opts.claudeModel, input));
        return fromClaudeMessage(msg);
      } catch (err) {
        opts.onFallback?.(err instanceof Error ? err.message.slice(0, 160) : 'unknown error');
        return opts.fallback.run(fallbackModel, input);
      }
    },
  };
}
