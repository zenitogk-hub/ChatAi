// Cloudflare Worker — прокси для OpenAI, Google Gemini и Groq.
// Особенность: на /v1/models сам дёргает Google и мержит whitelist с реально доступными моделями.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

// Whitelist — наш "каталог" с человеческими названиями и метаданными.
// Если модель тут есть, она гарантированно попадёт в список. Если её нет —
// но она доступна твоему ключу (по /v1/gemini-models) — тоже попадёт, с автолейблом.
const MODELS = {
  // Google Gemini
  'gemini-2.5-flash':        { provider: 'gemini', label: 'Gemini 2.5 Flash (быстрая, новая)' },
  'gemini-2.5-pro':          { provider: 'gemini', label: 'Gemini 2.5 Pro (умная)' },
  'gemini-2.0-flash':        { provider: 'gemini', label: 'Gemini 2.0 Flash (стабильная, бесплатная)' },
  'gemini-2.0-flash-lite':   { provider: 'gemini', label: 'Gemini 2.0 Flash Lite (самая быстрая)' },
  'gemini-2.0-pro':          { provider: 'gemini', label: 'Gemini 2.0 Pro' },
  'gemini-1.5-flash':        { provider: 'gemini', label: 'Gemini 1.5 Flash (стабильная)' },
  'gemini-1.5-flash-8b':     { provider: 'gemini', label: 'Gemini 1.5 Flash-8B (облегчённая)' },

  // OpenAI
  'gpt-4o-mini':             { provider: 'openai', label: 'GPT-4o mini' },
  'gpt-4o':                  { provider: 'openai', label: 'GPT-4o' },
  'gpt-4.1-mini':            { provider: 'openai', label: 'GPT-4.1 mini' },
  'gpt-3.5-turbo':           { provider: 'openai', label: 'GPT-3.5 Turbo' },

  // Groq (бесплатный, очень быстрый)
  'llama-3.3-70b-versatile': { provider: 'groq',   label: 'Llama 3.3 70B (Groq, free)' },
  'llama-3.1-8b-instant':    { provider: 'groq',   label: 'Llama 3.1 8B Instant (Groq)' },
  'mixtral-8x7b-32768':      { provider: 'groq',   label: 'Mixtral 8x7B (Groq, free)' },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

// Тянет реальный список моделей Google, доступных по ключу.
async function listGeminiModelsLive(apiKey) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return (data.models || [])
    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      displayName: m.displayName || m.name,
      inputTokenLimit: m.inputTokenLimit,
    }));
}

// Мердж whitelist + реальные модели Google.
async function buildModels(env) {
  const out = Object.entries(MODELS).map(([id, m]) => ({ id, ...m }));
  if (!env.GEMINI_API_KEY) return out;

  let live = null;
  try { live = await listGeminiModelsLive(env.GEMINI_API_KEY); } catch { live = null; }
  if (!live) {
    // Не смогли дотянуться — отдаём как есть, без пометки доступности
    for (const m of out) m.available = null;
    return out;
  }

  const liveIds = new Set(live.map(m => m.id));
  // Помечаем whitelist-модели
  for (const m of out) {
    if (m.provider === 'gemini') m.available = liveIds.has(m.id);
  }
  // Добавляем модели, которые есть у ключа, но нет в whitelist
  for (const lm of live) {
    if (!MODELS[lm.id]) {
      out.push({
        id: lm.id,
        provider: 'gemini',
        label: lm.displayName || lm.id,
        available: true,
        discovered: true,
      });
    }
  }
  return out;
}

async function callGemini(modelId, messages, apiKey) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system');
  const contents = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // Пробуем v1beta — там максимум моделей. Если 404 — fallback на v1.
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${apiKey}`,
  ];
  const body = {
    contents,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
    generationConfig: { temperature: 0.7 },
  };
  let lastErr = null;
  for (const url of urls) {
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
    if (r.status !== 404) break;
  }
  throw new Error(lastErr || 'gemini failed');
}

async function callOpenAI(modelId, messages, apiKey) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages, temperature: 0.7 }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

async function callGroq(modelId, messages, apiKey) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, messages, temperature: 0.7 }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Groq HTTP ${r.status}`);
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      const models = await buildModels(env);
      return json({ ok: true, service: 'chat-ai-proxy', count: models.length });
    }

    if (url.pathname === '/v1/models') {
      // Пробуем закэсировать на 60 секунд через Cache API (если рантайм поддерживает).
      let cache = null;
      try { if (typeof caches !== 'undefined' && caches?.default) cache = caches.default; } catch {}
      if (cache) {
        const cacheKey = new Request(url.toString(), { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) return json(await cached.json());
        const models = await buildModels(env);
        const payload = { models };
        const resp = new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return json(payload, 200, { 'Cache-Control': 'public, max-age=60' });
      }
      const models = await buildModels(env);
      return json({ models });
    }

    // Ручной refresh — без кэша
    if (url.pathname === '/v1/gemini-models') {
      if (!env.GEMINI_API_KEY) return json({ error: 'gemini_key_missing' }, 500);
      const live = await listGeminiModelsLive(env.GEMINI_API_KEY).catch(e => null);
      if (!live) return json({ error: 'list_failed' }, 502);
      return json({ count: live.length, models: live });
    }

    if (url.pathname === '/v1/chat' && req.method === 'POST') {
      let payload;
      try { payload = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400); }

      const modelId = payload.model || 'gemini-2.0-flash';
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return json({ error: 'messages_required' }, 400);

      const meta = MODELS[modelId] || { provider: 'gemini' };

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
        } else {
          return json({ error: 'unknown_provider', model: modelId }, 400);
        }
        return json({ model: modelId, provider: meta.provider, ...result });
      } catch (e) {
        return json({ error: 'provider_error', message: String(e.message || e) }, 502);
      }
    }

    return json({ error: 'not_found', path: url.pathname }, 404);
  },
};
