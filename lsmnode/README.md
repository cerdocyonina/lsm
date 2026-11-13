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
| `PROVIDER` | Провайдер узла (одно-бэкендовый режим): `xui` \| `naive` | `xui` |
| `BACKENDS_CONFIG` | Путь к `backends.json` — мультибэкенд-режим (naive, shadowsocks, mieru, xui на одном агенте). Если задан, `PROVIDER` игнорируется | - |
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

### `POST /sync-clients` (3x-ui, lsmnode ≥ 2.0)

Пакетный синк одного инбаунда; им пользуется мастер 2.0+. Агент один раз читает список
клиентов панели и решает по **UUID**: добавить, переименовать (клиент со старым именем —
например голым `client1` до префиксов профилей — переименовывается на месте, со статистикой),
прикрепить к инбаунду, или конфликт. Клиенты, которых нет в запросе, не трогаются.

```json
{
  "inboundId": 1,
  "clients": [{ "email": "main.client1", "uuid": "550e8400-…", "legacyEmail": "client1" }],
  "remove": [{ "email": "par.client7", "uuid": "1b4e28ba-…" }],
  "onConflict": "skip",
  "dryRun": false
}
```

`onConflict` — что делать, если клиент с таким email уже есть с другим UUID: `skip` (оставить),
`overwrite` (поставить UUID из LSM), `keep-both` (добавить рядом как `email_1`). `dryRun: true`
возвращает план без изменений. `remove` удаляет только клиента с совпадающим UUID; если клиент
прикреплён к нескольким инбаундам, он только открепляется от этого.

Ответ: `{ "results": [{ "kind": "rename", "email": "main.client1", "from": "client1", "uuid": "…", "ok": true }, …] }`.
`kind`: `add`, `rename`, `attach`, `overwrite`, `keep-both`, `conflict`, `unchanged`, `delete`, `detach`, `not-found`.

`/sync-user`, `/delete-user` и `/check-conflicts` ниже оставлены для старых мастеров.

### `POST /sync-users` (naive / shadowsocks / mieru)

Декларативный синк: принимает **весь** целевой список и перерендеривает конфиг провайдера
(Caddy, Xray или mita).
Отсутствующие в списке юзеры тем самым отзываются.

```json
{ "users": [{ "user": "alice", "pass": "nvKH4m6a6jel8z3yb0nBb8" }] }
```

Ответ: `{ "synced": 1 }` либо `{ "synced": 1, "error": "caddy reload failed: ..." }`.

⚠️ Управляемый файл — не единственный источник авторизации: статическая строка `basic_auth`
в основном Caddyfile обязана остаться, иначе пустой список сделает `forward_proxy` открытым.

## mieru (mita)

[mieru](https://github.com/enfein/mieru) — свой протокол поверх TCP/UDP без TLS (как shadowsocks).
Сервер называется `mita` и ставится **нативно** (deb/rpm + systemd), не в docker. Агент управляет
им через CLI `mita`, который ходит в unix-сокет `/var/run/mita/mita.sock`.

Синк декларативный: агент рендерит **полный** конфиг (`baseConfig` + все юзеры) и делает
`mita replace config` → `mita reload` → `mita start`. `reload` подменяет юзеров без обрыва живых
соединений; `start` идемпотентен и нужен только на свежей установке, где прокси ещё в `IDLE`.
`apply config` не используется: он мёржит юзеров по имени, и удалённый юзер остался бы жить.
Пустой список — `users: []`, mita никого не пускает.

### Установка на узле

```bash
# 1. mita (версию брать из https://github.com/enfein/mieru/releases)
curl -fLO https://github.com/enfein/mieru/releases/download/v3.39.0/mita_3.39.0_amd64.deb
sudo dpkg -i mita_3.39.0_amd64.deb      # ставит systemd-юнит mita и группу mita

# 2. доступ агента к сокету mita: юзер, под которым крутится lsm-node, — в группу mita
sudo usermod -aG mita "$(whoami)"
sudo systemctl restart lsmnode          # systemd подхватит новую группу при рестарте

# 3. точное время обязательно: ключ шифрования выводится из времени (окно ±4 минуты)
timedatectl status | grep -i synchronized

# 4. порты (docker тут не участвует, так что ufw действительно решает)
sudo ufw allow 8444:8453/tcp
```

### `backends.json`

```json
{
  "default": "naive",
  "backends": {
    "naive":  { "kind": "naive", "usersFile": "/opt/naive/managed/naive-users.caddy", "container": "naive" },
    "mieru": {
      "kind": "mieru",
      "baseConfig": {
        "portBindings": [{ "portRange": "8444-8453", "protocol": "TCP" }],
        "mtu": 1400
      }
    }
  }
}
```

- `baseConfig` — серверный конфиг mita **без** `users` (их владелец — агент). Обязательны
  `portBindings`; остальное (`mtu`, `trafficPattern`, `egress`, `dns`, ...) передаётся как есть,
  формат — [server-install.md](https://github.com/enfein/mieru/blob/main/docs/server-install.md).
- `mitaBin` — путь к бинарю, если `mita` не в `PATH` (по умолчанию `mita`).
- Смена `portBindings`: поправить `backends.json`, рестартнуть агент, синкнуть. Если `reload`
  не сможет пересоздать listeners, ошибка вернётся в ответе синка — тогда `mita stop && mita start`.

### На мастере

- нода: тип **mieru (mita)**, URL `http://<host>:9000/mieru` (имя бэкенда из `backends.json`);
- шаблон сервера (простая ссылка mieru):
  `mierus://{user}:{mpass}@{ip}?profile=default&port=8444-8453&protocol=TCP#mieru-node`.
  `{user}` = `<профиль>.<клиент>` (как у naive), `{mpass}` — отдельный пароль mieru;
- HTTP-пинг mieru требует клиент `mieru` в `PATH` мастера (поднимается временно с конфигом из
  `MIERU_CONFIG_JSON_FILE`, socks5 → curl). Часы мастера тоже должны быть точными.
