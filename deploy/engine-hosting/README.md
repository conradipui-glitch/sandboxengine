# Engine hosting (B13 preview integration)

Недостающий ресурс для пункта 3 acceptance: постоянно доступный HTTPS endpoint движка.

## Конфигурация

- Движок live-author-studio (Node >=24.19, SQLite) в Docker (`node:24.19-slim`), порт 8742 loopback;
- nginx vhost на 8743 ssl (существующий certbot-сертификат 85.137.95.104.sslip.io) → proxy на 8742;
- после запуска в sandbox (conradipui-glitch/sandbox) устанавливаются:
  - secret/var `ENGINE_RUNTIME_URL=https://85.137.95.104.sslip.io:8743`
  - `ENGINE_FLORENCE_PROJECT_ID=<project>`, `ENGINE_FLORENCE_QUEST_ID=quest`
  (проект/квест создаются в движке seed-скриптом или через Studio), после чего
  `POST /api/games {runtime:"engine"}` в приложении идёт в этот движок через BFF.

## Применение (на VPS conradipui.fvds.ru, docker 29.6.1 уже установлен)

    git clone <engine repo> /opt/sandboxengine && cd /opt/sandboxengine
    docker compose -f deploy/engine-hosting/docker-compose.yml up -d --build
    cp deploy/engine-hosting/nginx-engine.conf /etc/nginx/conf.d/engine.conf && nginx -t && systemctl reload nginx

Требует явного разрешения оператора: использует VPS-инфраструктуру и открывает внешний HTTPS-порт.
