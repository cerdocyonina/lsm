# lsm

CLI-managed subscription server with a Bun admin panel.

## Install dependencies

```bash
bun install
```

## Configure env

```bash
cp .env.example .env
```

Set these values in `.env`:

- `PORT`
- `ADMIN_PORT`
- `BASE_URL`
- `DATABASE_PATH`
- `SUB_LINK_SECRET`
- `ADMIN_PATH`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

## Run the public subscription server

```bash
bun run dev
```

## Run the private admin server

```bash
bun run dev:admin
```

The admin server binds to `127.0.0.1:<ADMIN_PORT>` only.

## Run the frontend in Vite dev mode

```bash
bun run dev:web
```

The admin panel is available at `http://127.0.0.1:5173/<ADMIN_PATH>/` in Vite dev mode.

## Build production assets

```bash
bun run build
```

## Run production servers

```bash
bun run start
bun run start:admin
```

- Public subscription server: `http://127.0.0.1:<PORT>`
- Private admin server: `http://127.0.0.1:<ADMIN_PORT>/<ADMIN_PATH>`

For remote access to the private admin panel, use SSH port forwarding:

```bash
ssh -L 3001:127.0.0.1:<ADMIN_PORT> your-server
```

Then open `http://127.0.0.1:3001/<ADMIN_PATH>` locally.

## Existing CLI

```bash
bun run src/cli.ts help
```
