# lsm-node

агент-сервис, устанавливаемый на каждый VPN-узел (рядом с 3x-ui).

получает команды от LSM-мастера и выполняет их локально, обращаясь к 3x-ui по `localhost` - без необходимости открывать порт панели наружу.

```
LSM-мастер ──HTTP──▶ lsm-node :9000 ──HTTP──> 3x-ui :2053 (localhost)
```

- порт 3x-ui остаётся закрытым для внешнего мира
- lsm-node принимает команды только с авторизацией по `SHARED_SECRET`
- рекомендуется закрыть порт lsm-node файрволом от всех, кроме IP LSM-мастера

## Установка (Docker)

1. клонировать репозиторий lsm на сервер-узел (или скопировать папку `lsmnode/` и файлы `src/3x-ui.ts`, `src/logger.ts`, `package.json`, `bun.lockb`)

2. настроить `.env`:
    ```bash
    cp lsmnode/.env.example lsmnode/.env
    ```

3. запустить:
    ```bash
    cd lsmnode
    docker compose up -d
    ```

4. закрыть порт файрволом:
    ```bash
    # разрешить только с IP LSM-мастера
    ufw allow from <LSM_MASTER_IP> to any port 9000
    ```

## Установка (Bun, без Docker)

```bash
# из корня репозитория lsm
bun install
cp lsmnode/.env.example lsmnode/.env
# отредактировать lsmnode/.env
cd lsmnode
bun run start
```

### systemd

пример `/etc/systemd/system/lsm-node.service`:

```ini
[Unit]
Description=lsm-node
After=network.target

[Service]
Type=simple
User=username
WorkingDirectory=/home/username/lsm/lsmnode
EnvironmentFile=/home/username/lsm/lsmnode/.env
ExecStart=/home/username/.bun/bin/bun run /home/username/lsm/lsmnode/src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now lsm-node
```

## Конфигурация `.env`

| Переменная | Описание | По умолчанию |
|---|---|---|
| `PORT` | Порт lsm-node | `9000` |
| `SHARED_SECRET` | Токен авторизации (должен совпадать с LSM-мастером) | - |
| `XUI_HOST` | URL 3x-ui панели (обычно `http://127.0.0.1:2053`) | - |
| `XUI_USER` | Логин 3x-ui | - |
| `XUI_PASSWORD` | Пароль 3x-ui | - |
| `PROVIDER` | Провайдер узла: `xui` \| `naive` | `xui` |
| `CADDY_USERS_FILE` | (naive) файл с управляемыми `basic_auth`-строками, импортируемый в Caddyfile | - |
| `CADDY_CONTAINER` | (naive) имя docker-контейнера с Caddy | `naive` |

## API

Все эндпоинты требуют заголовок:
```
Authorization: Bearer <SHARED_SECRET>
```

### `GET /health`

Проверка доступности. Возвращает `{ "ok": true }`.

### `POST /sync-user`

Добавить пользователя в 3x-ui inbound.

Тело запроса:
```json
{
  "email": "username",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "inboundId": 1,
  "onConflict": "skip"
}
```

| Поле | Тип | Описание |
|---|---|---|
| `email` | string | Имя клиента в 3x-ui |
| `uuid` | string | UUID пользователя |
| `inboundId` | number | ID inbound в 3x-ui |
| `onConflict` | `"skip"` \| `"overwrite"` \| `"keep-both"` | Действие при конфликте (по умолчанию `"skip"`) |

Ответ:
```json
{ "result": "added" }
```

Возможные значения `result`: `added`, `skipped`, `overwritten`, `kept-both`, `failed`.

### `POST /sync-users` (PROVIDER=naive)

Декларативный синк: принимает **весь** целевой список и перерендеривает конфиг Caddy.
Отсутствующие в списке юзеры тем самым отзываются.

```json
{ "users": [{ "user": "alice", "pass": "nvKH4m6a6jel8z3yb0nBb8" }] }
```

Ответ: `{ "synced": 1 }` либо `{ "synced": 1, "error": "caddy reload failed: ..." }`.

⚠️ Управляемый файл — не единственный источник авторизации: статическая строка `basic_auth`
в основном Caddyfile обязана остаться, иначе пустой список сделает `forward_proxy` открытым.
