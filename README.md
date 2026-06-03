# top.xedoc.ru

Публичный рейтинг AI usage по анонимному локальному отпечатку. MVP хранит снимки метрик на сервере и строит лидерборды по периодам `hour`, `day`, `week`, `month`, `all`.

## Метрики

- `tokens`, `inputTokens`, `outputTokens`, `cachedTokens`
- `requests`
- `spendUsd`
- `artifactBytes`
- `linesChanged`
- `sessions`
- `provider`, `topModel`, `source`, `proofUrl`

## API

```http
POST /api/measurements
Content-Type: application/json
```

```json
{
  "fingerprint": "public_browser_fingerprint",
  "displayName": "Wizard",
  "provider": "openai-api",
  "period": "month",
  "observedFrom": "2026-05-04T00:00:00.000Z",
  "observedTo": "2026-06-03T00:00:00.000Z",
  "tokens": 603000000000,
  "requests": 7600000,
  "spendUsd": 1305088.81,
  "topModel": "gpt-5.5-2026-04-23",
  "source": "codexbar"
}
```

Все входящие payload/query/params валидируются через Zod. WebSocket в проекте не используется.

## Реальные коннекторы

```http
POST /api/connectors/measure
Content-Type: application/json
```

Секреты используются только для одного серверного запроса и не записываются в `measurements.jsonl`.

### OpenAI Admin API

Читает organization completions usage и costs по OpenAI Admin API key.

```json
{
  "connector": "openai-admin",
  "fingerprint": "public_browser_fingerprint",
  "displayName": "Wizard",
  "period": "month",
  "adminApiKey": "sk-admin-..."
}
```

### Gemini Monitoring

Читает Gemini API quota token/request usage из Google Cloud Monitoring по OAuth access token с правом Monitoring read.

```json
{
  "connector": "gemini-monitoring",
  "fingerprint": "public_browser_fingerprint",
  "displayName": "Wizard",
  "period": "month",
  "googleProjectId": "my-project",
  "googleAccessToken": "ya29..."
}
```

### xAI / Grok response usage

xAI отдаёт usage и cost в каждом API response. Этот коннектор сохраняет такой usage object.

```json
{
  "connector": "xai-response",
  "fingerprint": "public_browser_fingerprint",
  "displayName": "Wizard",
  "period": "day",
  "model": "grok-4.3",
  "usage": {
    "prompt_tokens": 199,
    "completion_tokens": 1,
    "total_tokens": 200,
    "cost_in_usd_ticks": 158500
  }
}
```

## Локально

```bash
pnpm install
pnpm typecheck
pnpm build
HOST=127.0.0.1 PORT=4177 pnpm start
```

## Прод

Сервис слушает только `127.0.0.1:4177`, наружу его отдаёт nginx.

```bash
pnpm install --prod=false
pnpm build
NODE_ENV=production HOST=127.0.0.1 PORT=4177 DATA_DIR=/var/www/top.xedoc.ru/data pnpm start
```
