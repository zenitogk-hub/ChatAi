# 💬 Чат-АИ — личный фронтенд для Gemini / GPT / Llama

Бесплатный личный чат с ИИ в браузере. Открывается по ссылке вида:
`https://zenitogk-hub.github.io/chat-ai/`

**Архитектура:**
- **Frontend** — один `index.html` на GitHub Pages (бесплатно).
- **Backend** — Cloudflare Worker (`worker.js`), хранит твои API-ключи и проксирует запросы к моделям. Ключи **не утекают в браузер**.

**Модели:**
- Gemini 2.0 Flash — бесплатно, быстро ✅
- Gemini 1.5 Pro / Flash — бесплатный tier
- GPT-4o / GPT-4o-mini / GPT-3.5-Turbo
- Llama 3.3 70B / Llama 3.1 8B через Groq — бесплатный tier, очень быстро
- Mixtral 8x7B через Groq

---

## 🚀 Как запустить (один раз, ~10 минут)

### Шаг 1. Получи API-ключи

Тебе нужны хотя бы ключи от **Google AI Studio** (бесплатно, без карты) и опционально от **OpenAI** и **Groq**.

| Сервис | Где взять ключ | Бесплатный лимит |
|---|---|---|
| Google Gemini | https://aistudio.google.com/app/apikey | 15 RPM, 1M токенов/мин |
| OpenAI | https://platform.openai.com/api-keys | платно, но GPT-4o-mini дёшево |
| Groq (Llama, Mixtral) | https://console.groq.com/keys | щедрый free tier |

Запиши ключи где-нибудь — вставим их в Cloudflare.

### Шаг 2. Залей репозиторий

1. Зайди на https://github.com/new
2. Имя: `chat-ai`
3. Галочка **Add a README file** ✅
4. **Public** (обязательно для GitHub Pages)
5. Нажми **Create repository**

Теперь залей файлы. Проще всего через веб-интерфейс:

1. Открой `Add file` → **Upload files**
2. Перетащи `index.html`
3. Нажми **Commit changes**

### Шаг 3. Включи GitHub Pages

В репозитории:
1. **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**, папка **/(root)**
4. Сохрани

Через минуту сайт будет доступен по адресу:
**https://zenitogk-hub.github.io/chat-ai/**

🎉 Это уже будет работать, но модели пока не отвечают — нет прокси.

### Шаг 4. Задеплой Cloudflare Worker

Самый простой способ — **без терминала**, через дашборд:

1. Зайди на https://dash.cloudflare.com/sign-up (если ещё не регистрировался)
2. В левом меню: **Workers & Pages** → **Create** → **Create Worker**
3. Имя воркера: `chat-ai-proxy` (или любое, главное запомни)
4. Нажми **Deploy** (дефолтный код)
5. Теперь нажми **Edit code**, **удали весь дефолтный код** и вставь содержимое файла `worker.js` из этого репозитория
6. Нажми **Save and Deploy**

После этого у твоего воркера будет URL вида:
**`https://chat-ai-proxy.ТВОЙ-АККАУНТ.workers.dev`**

### Шаг 5. Добавь секреты в воркер

В дашборде воркера:
1. **Settings** → **Variables** → **Environment Variables**
2. Добавь переменные (тип — **Encrypt**):

| Имя переменной | Значение |
|---|---|
| `GEMINI_API_KEY` | ключ от Google AI Studio |
| `OPENAI_API_KEY` | ключ OpenAI (если есть) |
| `GROQ_API_KEY` | ключ Groq (если есть) |

3. **Save and Deploy**

### Шаг 6. Подключи воркер к сайту

1. Открой свой сайт https://zenitogk-hub.github.io/chat-ai/
2. В шапке нажми **настройки**
3. Вставь URL воркера: `https://chat-ai-proxy.ТВОЙ-АККАУНТ.workers.dev`
4. Нажми **сохранить**
5. Должен появиться статус: `прокси: ...` ✅
6. Выбери модель и спроси что-нибудь!

---

## 🧪 Проверка что воркер работает

Открой в браузере (подставив свой адрес):
```
https://chat-ai-proxy.ТВОЙ-АККАУНТ.workers.dev/health
```
Должен вернуться JSON со списком моделей.

```
https://chat-ai-proxy.ТВОЙ-АККАУНТ.workers.dev/v1/models
```

---

## 📁 Структура

```
chat-ai/
├── index.html       # фронтенд (GitHub Pages)
├── worker.js        # бэкенд (Cloudflare Worker)
├── wrangler.toml    # конфиг для деплоя через CLI (опционально)
└── README.md
```

---

## 🛠 Если хочешь деплоить воркер через терминал

```bash
npm install -g wrangler
wrangler login
cd chat-ai
wrangler secret put GEMINI_API_KEY     # вставить ключ, Enter
wrangler secret put OPENAI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler deploy
```

Выведет URL — вставляй его в настройки сайта.

---

## 🔒 Безопасность

- API-ключи **никогда** не попадают в браузер. Все запросы идут через воркер.
- Cloudflare Workers free tier: 100 000 запросов/день — за глаза.
- История чата хранится в `localStorage` твоего браузера, никуда не отправляется.
- Кнопка **⬇️ экспорт** — скачивает всю историю одним `.md` файлом.

---

## ❓ Частые проблемы

**«не указан URL прокси»** — открой «настройки» в шапке чата, вставь URL воркера.

**«gemini_key_missing»** — в воркере нет переменной `GEMINI_API_KEY`. Добавь в Settings → Variables.

**«failed to fetch»** — открой воркер по его URL напрямую, проверь что отвечает. Возможно, не задеплоился.

**Ответы режутся / 429** — у Gemini бесплатный лимит 15 запросов в минуту. Подожди минуту или возьми Groq (там щедрее).
