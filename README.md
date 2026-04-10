# lsm

менеджер подписок VLESS с CLI и веб-интерфейсом

ну навайбкодил и что

## Описание

позволяет добавлять серверы (ключи с плейсхолдером для uuid пользователя) и пользователей

по ссылке для данного пользователя раздает подписку - берет все ключи серверов и подставляет вместо плейсхолдера uuid пользователя

> N.B.: на всех серверах uuid пользователя должен быть одинаковым

## Установка

сделано при помощи bun, react и sqlite3

порядок:

1. ```bash
    bun install
    ```

2. настройка `.env`
    ```bash
    cp .env.example .env
    ```

содержимое `.env`:

- `PORT` - порт основного сервера
- `ADMIN_PORT` - порт админки. наружу лучше не показывать - для прода пробрасываем порт
- `BASE_URL` - базовый url/ip основного сервера
- `DATABASE_PATH` - путь к базе данных
- `SUB_LINK_SECRET` - секрет для генерации ссылок (рандом)
- `ADMIN_PATH` - путь к админке (рандом)
- `ADMIN_USERNAME` - логин админки
- `ADMIN_PASSWORD` - пароль админки
- `ADMIN_SESSION_SECRET` - секрет сессии админки (рандом)
- `FALLBACK_URL` - url, на который сбрасываются невалидные ссылки подписок

## Запуск

### DEV
1. основной сервер:

    ```bash
    bun run dev
    ```

2. админка:

    ```bash
    bun run dev:admin
    ```

админка слушает только `127.0.0.1:<ADMIN_PORT>`

3. веб-интерфейс админки

    ```bash
    bun run dev:web
    ```

админка доступна на `http://127.0.0.1:5173/<ADMIN_PATH>/`

### PROD

1. основной сервер:

    ```bash
    bun run start
    ```

2. админка:

    ```bash
    bun run build:web
    ```

    ```bash
    bun run start:admin
    ```

всё
- основной сервер - на `http://127.0.0.1:<PORT>`
- админка - на `http://127.0.0.1:<ADMIN_PORT>/<ADMIN_PATH>`

доступ к админке - лучше через проброс порта
```bash
ssh -L 3001:127.0.0.1:<ADMIN_PORT> your-server
```

и админка будет локально на `http://127.0.0.1:3001/<ADMIN_PATH>`

### systemd

на прод сервере можно настроить сервис через systemd. примеры конфигов:

- `/etc/systemd/system/lsm.service`:

  ```ini
  [Unit]
  Description=lsm
  After=network.target

  [Service]
  Type=simple
  User=username
  WorkingDirectory=/home/username/lsm
  Environment=NODE_ENV=production
  EnvironmentFile=/home/username/lsm/.env
  ExecStart=/home/username/.bun/bin/bun run /home/username/lsm/src/index.ts
  Restart=always
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```

- `/etc/systemd/system/lsm-admin.service`:

  ```ini
  [Unit]
  Description=lsm admin
  After=network.target

  [Service]
  Type=simple
  User=username
  WorkingDirectory=/home/username/lsm
  Environment=NODE_ENV=production
  EnvironmentFile=/home/username/lsm/.env
  ExecStart=/home/username/.bun/bin/bun run /home/username/lsm/src/admin-server.ts
  Restart=always
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```

## Использование

сервер добавляется как темплейт-ссылка, uuid пользователя подставляется вместо строки `"DUMMY"`. пример темплейта сервера:

`vless://DUMMY@localhost:443?type=tcp&encryption=none&security=reality&pbk=abcdef&fp=chrome&sni=max.ru&sid=e0&spx=%2F&flow=xtls-rprx-vision#main`

можно импортировать конфиг из json в sqlite (сам json используется только для этого импорта, в рантайме не используется) через `bun run src/cli.ts import-json config.json> - см пример [config.json](./config.json)

ссылки на подписки будут иметь вид `<BASE_URL>/<KEY>`, где `BASE_URL` берется из `.env` и `KEY` генерируется автоматически при создании пользователя

## CLI

идентичный админке функционал, см help:

```bash
bun run src/cli.ts help
```
