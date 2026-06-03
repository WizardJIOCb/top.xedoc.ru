# top.xedoc.ru

Публичный рейтинг AI usage по анонимному локальному отпечатку. Сервис хранит только достоверные замеры: агрегаты из провайдерских API или `usage` объекты из SDK-ответов.

## Метрики

- `tokens`, `inputTokens`, `outputTokens`, `cachedTokens`
- `requests`
- `spendUsd`, если провайдер возвращает реальные cost данные
- `provider`, `topModel`, `source`, `proofUrl`

Ручной ввод токенов, запросов и spend отключён.

## SDK endpoint

```http
POST /api/sdk/usage
Content-Type: application/json
```

```json
{
  "fingerprint": "public_browser_fingerprint",
  "displayName": "Wizard",
  "team": "xedoc",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "usage": {
    "prompt_tokens": 199,
    "completion_tokens": 1,
    "total_tokens": 200
  }
}
```

Поддерживаемые `provider`: `openai`, `xai`, `gemini`.

## Агрегатные коннекторы

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

Все входящие payload/query/params валидируются через Zod. WebSocket в проекте не используется.

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
