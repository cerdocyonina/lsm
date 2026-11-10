# lsm

менеджер подписок VLESS, NaïveProxy, Shadowsocks-2022 и mieru с веб-интерфейсом

ну навайбкодил и что

## Описание

Серверы настраиваются один раз: **хост → сервисы → подключения**. Профиль выбирает подключения из общего каталога, хранит своих пользователей, порядок и необязательные имена ссылок. Один хост может содержать NaïveProxy, SS2022, mieru и несколько инбаундов 3x-ui.

Добавьте хост в **Servers**, настройте несколько сервисов или обнаружьте их кнопкой **Discover services**, выберите профили и нажмите **Save and sync**. Существующие пользователи выбранных профилей синхронизируются сразу. Новые сервисы не добавляются в профили автоматически.

В **Profiles** можно выбрать любые подключения, изменить их порядок и имена ссылок. **Edit shared** меняет подключение во всех профилях; **Create variant** создаёт отдельный вариант шаблона. Подключения без агента также поддерживаются.

Миграция старой базы выполняется автоматически. Перед обновлением остановите оба процесса и сохраните копию SQLite. Подробности и проверка существующего агента: [MIGRATION.md](./MIGRATION.md).

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

Импорт и экспорт доступны в веб-интерфейсе. **Export all** сохраняет общий каталог, хосты, сервисы и профили, включая подключения без назначенных профилей. Старые JSON-дампы поддерживаются. CLI удалён.

ссылки на подписки будут иметь вид `<BASE_URL>/<KEY>`, где `BASE_URL` берется из `.env` и `KEY` генерируется автоматически при создании пользователя

## Пинг серверов

можно проверить доступность серверов двумя способами:

- **ICMP** — обычный `ping` по хосту из темплейта
- **HTTP** — реальный запрос через VLESS-прокси к `http://www.google.com/generate_204` (требует `xray` и `curl` в PATH). проверяется каждая пара клиент × сервер (NxM запросов)

### Веб-панель

кнопка **Ping all** в разделе Connection diagnostics выбранного профиля. после завершения:
- рядом с каждым сервером появляется ICMP-бейдж с задержкой или ошибкой
- ниже списка серверов появляется таблица HTTP-результатов (строки — клиенты, столбцы — серверы)

## lsm-node

агент-сервис, устанавливаемый на каждый VPN-узел рядом с 3x-ui. позволяет LSM-мастеру автоматически добавлять пользователей в 3x-ui сразу при их создании — без ручного `sync`.

**зачем:** порт 3x-ui обычно не открыт наружу. lsm-node работает на том же хосте и обращается к 3x-ui по `localhost`, принимая команды от LSM-мастера через единственный открытый порт.

### быстрый старт

1. на каждом VPN-узле:

    ```bash
    cd lsmnode
    cp .env.example .env
    # отредактировать .env: XUI_HOST, XUI_USER, XUI_PASSWORD, SHARED_SECRET
    docker compose up -d
    ```

2. закрыть порт от всех, кроме LSM-мастера:

    ```bash
    ufw allow from <LSM_MASTER_IP> to any port 9000
    ```

3. В LSM-мастере откройте **Servers → Add host**: задайте URL агента и секрет, добавьте сервисы с путями бэкендов и шаблонами подключений, выберите профили. Несколько сервисов одного агента используют общие URL и секрет хоста.

подробнее — [`lsmnode/README.md`](lsmnode/README.md).
