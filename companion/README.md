# IPA Vault — FairPlay SAP Bridge (Companion)

Apple в 2026 году требует криптографическую подпись **FairPlay SAP (`X-Apple-ActionSignature` + `kbsync`)** на базе нативного ARM64-эмулятора Unicorn + Apple `CoreFP` для прямого входа в Apple ID и получения ссылок `downloaddispatch`.

Vercel Serverless (Node.js) не поддерживает нативную эмуляцию Unicorn/CoreFP, поэтому этот лёгкий Docker-контейнер на базе `majd/ipatool` выносит подпись FairPlay SAP в отдельный сервис. Пароли и токены держатся **только в оперативной памяти** на время одного запроса и никогда не записываются на диск.

## Быстрый деплой (Render / Railway / Fly.io / Docker)

### Вариант 1: Render / Railway (из этого же GitHub-репозитория)
1. Создайте новый Web Service → подключите этот репозиторий.
2. Укажите **Root Directory**: `companion` и **Runtime**: `Docker`.
3. Добавьте переменную окружения `BRIDGE_SECRET` (придумайте случайный ключ, например `openssl rand -hex 24`).
4. После деплоя скопируйте HTTPS-адрес сервиса (например, `https://ipa-sap-bridge.onrender.com`).

### Вариант 2: Свой VPS / Mac с Docker
```bash
cd companion
docker build -t ipavault-sap-bridge .
docker run -d --name ipavault-sap-bridge -p 8080:8080 -e BRIDGE_SECRET="ваш-секретный-ключ" ipavault-sap-bridge
```

## Подключение к сайту на Vercel

Добавьте в **Vercel → Settings → Environment Variables**:
- `SAP_BRIDGE_URL` = `https://ваш-сервис.onrender.com`
- `SAP_BRIDGE_SECRET` = `ваш-секретный-ключ`

Либо вставьте HTTPS-адрес моста прямо на вкладке **«Аккаунт» → «FairPlay SAP Bridge»** в интерфейсе сайта.
