import { TOOLS, executeTool, type ToolContext } from './tools';
import type { AgentEvent, ChatTurn } from '../shared/types';

// One agentic loop per provider, exposing the SAME tool set so the user can
// switch models across vendors without changing what the agent can do.
// SDKs are imported dynamically so only the selected provider's package loads.
// NOTE: provider request shapes evolve — verify against the installed SDK
// version if a call signature drifts.

export interface RunArgs {
  model: string;
  apiKey: string;
  system: string;
  history: ChatTurn[];
  userMessage: string;
  ctx: ToolContext;
  emit: (e: AgentEvent) => void;
}

const MAX_STEPS = 25;

/* ------------------------- Anthropic (Claude) ------------------------- */
export async function runAnthropic(a: RunArgs): Promise<void> {
  const { default: Anthropic } = (await import('@anthropic-ai/sdk')) as any;
  // No pasted key → construct a bare client so the SDK resolves ambient credentials
  // (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / a `claude login` / `ant auth` profile),
  // the same way Claude Code authenticates.
  const client = new Anthropic(a.apiKey ? { apiKey: a.apiKey } : {});
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages: any[] = [
    ...a.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: a.userMessage },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({ model: a.model, max_tokens: 8192, system: a.system, tools, messages });
    for (const block of res.content) {
      if (block.type === 'text') a.emit({ type: 'text', text: block.text });
      else if (block.type === 'thinking' && block.thinking) a.emit({ type: 'thinking', text: block.thinking });
    }
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') return a.emit({ type: 'done', stopReason: res.stop_reason || 'end_turn' });

    const results: any[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      a.emit({ type: 'tool_start', id: block.id, name: block.name, input: block.input });
      try {
        const out = await executeTool(block.name, block.input, a.ctx);
        a.emit({ type: 'tool_result', id: block.id, ok: true, preview: out.slice(0, 400) });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      } catch (e: any) {
        a.emit({ type: 'tool_result', id: block.id, ok: false, preview: e.message });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  a.emit({ type: 'done', stopReason: 'max_steps' });
}

/* ------------------------- OpenAI (GPT) ------------------------- */
export async function runOpenAI(a: RunArgs): Promise<void> {
  const { default: OpenAI } = (await import('openai')) as any;
  const client = new OpenAI({ apiKey: a.apiKey });
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: any[] = [
    { role: 'system', content: a.system },
    ...a.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: a.userMessage },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.chat.completions.create({ model: a.model, messages, tools });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.content) a.emit({ type: 'text', text: msg.content });
    const calls = msg.tool_calls || [];
    if (!calls.length) return a.emit({ type: 'done', stopReason: res.choices[0].finish_reason || 'stop' });

    for (const tc of calls) {
      let input: any = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
      a.emit({ type: 'tool_start', id: tc.id, name: tc.function.name, input });
      let out: string;
      try {
        out = await executeTool(tc.function.name, input, a.ctx);
        a.emit({ type: 'tool_result', id: tc.id, ok: true, preview: out.slice(0, 400) });
      } catch (e: any) {
        out = `Error: ${e.message}`;
        a.emit({ type: 'tool_result', id: tc.id, ok: false, preview: e.message });
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }
  }
  a.emit({ type: 'done', stopReason: 'max_steps' });
}

/* ------------------------- Google (Gemini) ------------------------- */
export async function runGoogle(a: RunArgs): Promise<void> {
  const { GoogleGenAI } = (await import('@google/genai')) as any;
  const ai = new GoogleGenAI({ apiKey: a.apiKey });
  const tools = [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  const contents: any[] = [
    ...a.history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: a.userMessage }] },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await ai.models.generateContent({ model: a.model, contents, config: { systemInstruction: a.system, tools } });
    const parts = res.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (p.text) a.emit({ type: 'text', text: p.text });
    contents.push({ role: 'model', parts });
    const calls = parts.filter((p: any) => p.functionCall);
    if (!calls.length) return a.emit({ type: 'done', stopReason: 'stop' });

    const responseParts: any[] = [];
    for (const c of calls) {
      const { name, args } = c.functionCall;
      a.emit({ type: 'tool_start', id: name, name, input: args });
      let out: string;
      try {
        out = await executeTool(name, args || {}, a.ctx);
        a.emit({ type: 'tool_result', id: name, ok: true, preview: out.slice(0, 400) });
      } catch (e: any) {
        out = `Error: ${e.message}`;
        a.emit({ type: 'tool_result', id: name, ok: false, preview: e.message });
      }
      responseParts.push({ functionResponse: { name, response: { result: out } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  a.emit({ type: 'done', stopReason: 'max_steps' });
}
