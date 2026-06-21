// Cloudflare Worker — прокси для OpenAI, Google Gemini и Groq
// Секреты хранятся как переменные окружения воркера, в браузер не утекают.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

const MODELS = {
  'gemini-2.0-flash': { provider: 'gemini', label: 'Gemini 2.0 Flash (free, fast)' },
  'gemini-1.5-pro':   { provider: 'gemini', label: 'Gemini 1.5 Pro (free tier)' },
  'gemini-1.5-flash': { provider: 'gemini', label: 'Gemini 1.5 Flash (free tier)' },
  'gpt-4o-mini':      { provider: 'openai', label: 'GPT-4o mini' },
  'gpt-4o':           { provider: 'openai', label: 'GPT-4o' },
  'gpt-3.5-turbo':    { provider: 'openai', label: 'GPT-3.5 Turbo' },
  'llama-3.3-70b':    { provider: 'groq',   label: 'Llama 3.3 70B (Groq, free tier)' },
  'llama-3.1-8b':     { provider: 'groq',   label: 'Llama 3.1 8B Instant (Groq, free)' },
  'mixtral-8x7b':     { provider: 'groq',   label: 'Mixtral 8x7B (Groq, free)' },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function callGemini(model, messages, apiKey) {
  // Склеиваем историю в один prompt для простоты (Gemini поддерживает system + contents)
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system');
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
    generationConfig: { temperature: 0.7 },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { text, usage: data.usageMetadata };
}

async function callOpenAI(model, messages, apiKey) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: data.usage,
  };
}

async function callGroq(modelId, messages, apiKey) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelId, messages, temperature: 0.7 }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Groq HTTP ${r.status}`);
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    // Простой GET для проверки работоспособности
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'chat-ai-proxy',
        models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
      });
    }

    if (url.pathname === '/v1/models') {
      return json({ models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })) });
    }

    if (url.pathname === '/v1/chat' && req.method === 'POST') {
      let payload;
      try { payload = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400); }

      const modelId = payload.model || 'gemini-2.0-flash';
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return json({ error: 'messages_required' }, 400);

      const meta = MODELS[modelId];
      if (!meta) return json({ error: 'unknown_model', model: modelId }, 400);

      try {
        let result;
        if (meta.provider === 'gemini') {
          if (!env.GEMINI_API_KEY) return json({ error: 'gemini_key_missing' }, 500);
          result = await callGemini(modelId, messages, env.GEMINI_API_KEY);
        } else if (meta.provider === 'openai') {
          if (!env.OPENAI_API_KEY) return json({ error: 'openai_key_missing' }, 500);
          result = await callOpenAI(modelId, messages, env.OPENAI_API_KEY);
        } else if (meta.provider === 'groq') {
          if (!env.GROQ_API_KEY) return json({ error: 'groq_key_missing' }, 500);
          result = await callGroq(modelId, messages, env.GROQ_API_KEY);
        }
        return json({ model: modelId, provider: meta.provider, ...result });
      } catch (e) {
        return json({ error: 'provider_error', message: String(e.message || e) }, 502);
      }
    }

    return json({ error: 'not_found', path: url.pathname }, 404);
  },
};
