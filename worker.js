// Cloudflare Worker — прокси для OpenAI, Google Gemini и Groq
// Секреты хранятся как переменные окружения воркера, в браузер не утекают.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

// Актуальные на 2025-2026 модели (имя -> {provider, label, hint})
// Если какая-то модель перестанет работать — Google/Groq/OpenAI просто вернут ошибку,
// фронтенд её покажет, и ты сможешь выбрать другую.
const MODELS = {
  // Google Gemini (через Google AI Studio, бесплатный tier)
  'gemini-2.5-flash':       { provider: 'gemini', label: 'Gemini 2.5 Flash (быстрая, новая)',          family: 'gemini' },
  'gemini-2.5-pro':         { provider: 'gemini', label: 'Gemini 2.5 Pro (умная)',                     family: 'gemini' },
  'gemini-2.0-flash':       { provider: 'gemini', label: 'Gemini 2.0 Flash (стабильная, бесплатная)',  family: 'gemini' },
  'gemini-2.0-flash-lite':  { provider: 'gemini', label: 'Gemini 2.0 Flash Lite (самая быстрая)',      family: 'gemini' },
  'gemini-2.0-pro':         { provider: 'gemini', label: 'Gemini 2.0 Pro',                              family: 'gemini' },
  'gemini-1.5-flash':       { provider: 'gemini', label: 'Gemini 1.5 Flash (стабильная)',              family: 'gemini' },
  'gemini-1.5-flash-8b':    { provider: 'gemini', label: 'Gemini 1.5 Flash-8B (облегчённая)',          family: 'gemini' },

  // OpenAI
  'gpt-4o-mini':            { provider: 'openai', label: 'GPT-4o mini',   family: 'openai' },
  'gpt-4o':                 { provider: 'openai', label: 'GPT-4o',        family: 'openai' },
  'gpt-4.1-mini':           { provider: 'openai', label: 'GPT-4.1 mini',  family: 'openai' },
  'gpt-3.5-turbo':          { provider: 'openai', label: 'GPT-3.5 Turbo', family: 'openai' },

  // Groq (бесплатный tier, очень быстрый)
  'llama-3.3-70b-versatile':{ provider: 'groq',   label: 'Llama 3.3 70B (Groq, free)',     family: 'groq' },
  'llama-3.1-8b-instant':   { provider: 'groq',   label: 'Llama 3.1 8B Instant (Groq)',   family: 'groq' },
  'mixtral-8x7b-32768':     { provider: 'groq',   label: 'Mixtral 8x7B (Groq, free)',      family: 'groq' },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

async function callGemini(modelId, messages, apiKey) {
  // system -> systemInstruction, остальное в contents
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system');
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // Пробуем v1beta — там больше всего моделей. Если 404 — fallback на v1.
  const tryEndpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${apiKey}`,
  ];

  const body = {
    contents,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
    generationConfig: { temperature: 0.7 },
  };

  let lastErr = null;
  for (const url of tryEndpoints) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return { text, usage: data.usageMetadata };
    }
    lastErr = data?.error?.message || `HTTP ${r.status}`;
    // Если не "not found" — нет смысла пробовать v1
    if (r.status !== 404) break;
  }
  throw new Error(lastErr || 'gemini failed');
}

async function callOpenAI(modelId, messages, apiKey) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: modelId, messages, temperature: 0.7 }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
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
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Groq HTTP ${r.status}`);
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    // Health
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'chat-ai-proxy',
        models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
      });
    }

    // Список моделей (наш whitelist)
    if (url.pathname === '/v1/models') {
      return json({ models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })) });
    }

    // РЕАЛЬНЫЙ список Gemini, который видит твой ключ. Открой в браузере:
    //   https://ТВОЙ_ВОРКЕР.workers.dev/v1/gemini-models
    // Он дёрнет Google и покажет все доступные тебе модели — даже те, которых нет в нашем whitelist.
    if (url.pathname === '/v1/gemini-models') {
      if (!env.GEMINI_API_KEY) return json({ error: 'gemini_key_missing' }, 500);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`);
        const data = await r.json();
        if (!r.ok) return json({ error: 'list_failed', message: data?.error?.message }, r.status);
        // Оставляем только те, что поддерживают generateContent
        const models = (data.models || [])
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
          .map(m => ({
            id: m.name.replace('models/', ''),
            label: m.displayName || m.name,
            inputTokenLimit: m.inputTokenLimit,
            outputTokenLimit: m.outputTokenLimit,
          }));
        return json({ count: models.length, models });
      } catch (e) {
        return json({ error: 'list_failed', message: String(e.message || e) }, 502);
      }
    }

    // Чат
    if (url.pathname === '/v1/chat' && req.method === 'POST') {
      let payload;
      try { payload = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400); }

      const modelId = payload.model || 'gemini-2.0-flash';
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return json({ error: 'messages_required' }, 400);

      const meta = MODELS[modelId];
      if (!meta) {
        return json({
          error: 'unknown_model',
          model: modelId,
          hint: 'Модели нет в whitelist. Открой /v1/gemini-models чтобы увидеть реальные доступные. Если нужна именно эта — добавь её в MODELS в коде воркера.',
        }, 400);
      }

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
