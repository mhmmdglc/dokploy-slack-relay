# dokploy-slack-relay

Lightweight webhook relay that forwards [Dokploy](https://dokploy.com) deployment events to Slack.

Add unlimited projects — each one gets its own endpoint and Slack channel. Zero limits, zero complexity.

## How it works

```
                                    ┌───────────────────┐
 Dokploy Project A ── POST /webhook/api ──────┐         │
                                              │         │
 Dokploy Project B ── POST /webhook/frontend ─┤  relay  ├──► Slack channels
                                              │         │
 Dokploy Project C ── POST /webhook/backend ──┤         │
                                              │         │
 Dokploy Project D ── POST /webhook/worker ───┘         │
                                    └───────────────────┘
```

You define routes in a simple JSON config. Each route maps a webhook endpoint to a Slack incoming webhook URL. Dokploy sends deployment events to your relay, and the relay formats them into readable Slack messages.

**Extracted fields:**

- Project name
- Application / service name
- Event type (build, deploy, error, etc.)
- Branch (normalized — `refs/heads/preview` becomes `preview`)
- Commit SHA (shortened to 7 characters)
- Commit message

The relay tries multiple possible field paths in the payload, so it works even if Dokploy's payload structure changes between versions.

## Quick start

```bash
git clone https://github.com/muhammedgulcu/dokploy-slack-relay.git
cd dokploy-slack-relay
npm install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "routes": [
    {
      "name": "api",
      "path": "/webhook/api",
      "slackWebhookUrl": "https://hooks.slack.com/services/T.../B.../xxx"
    },
    {
      "name": "frontend",
      "path": "/webhook/frontend",
      "slackWebhookUrl": "https://hooks.slack.com/services/T.../B.../yyy"
    }
  ]
}
```

Start the server:

```bash
node server.js
```

Output:

```
dokploy-slack-relay listening on :3131
Routes:
  api -> POST /webhook/api
  frontend -> POST /webhook/frontend
```

Test with curl:

```bash
curl -X POST http://localhost:3131/webhook/api \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "my-saas",
    "applicationName": "api",
    "type": "deploy",
    "branch": "main",
    "commitSha": "abc1234567890",
    "commitMessage": "fix: resolve login bug"
  }'
```

Slack message:

```
my-saas / api
Event: deploy
Branch: main
Commit: abc1234
Message: fix: resolve login bug
```

## Configuration

### Route definition

Each route in `config.json` requires three fields:

| Field | Description |
|---|---|
| `name` | Label shown in logs (e.g. `"api"`) |
| `path` | Unique POST endpoint path (e.g. `"/webhook/api"`) |
| `slackWebhookUrl` | Slack incoming webhook URL for this route |

Add as many routes as you need. There is no limit.

### Loading config

The relay looks for configuration in this order:

1. **`CONFIG` env var** — JSON string containing the full config (best for Docker / Dokploy)
2. **`CONFIG_PATH` env var** — path to a JSON file
3. **`./config.json`** — default file in the project root

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3131` | Port to listen on |
| `DEBUG` | No | `false` | Log full incoming payloads |
| `CONFIG` | No | — | Full config as a JSON string |
| `CONFIG_PATH` | No | `./config.json` | Path to the config file |

## Deploy on Dokploy

1. Create a new application in Dokploy.
2. Point the source to your fork or clone of this repo.
3. Set the build type to **Dockerfile**.
4. Add the `CONFIG` environment variable with your routes:

```
{"routes":[{"name":"api","path":"/webhook/api","slackWebhookUrl":"https://hooks.slack.com/services/T.../B.../xxx"},{"name":"web","path":"/webhook/web","slackWebhookUrl":"https://hooks.slack.com/services/T.../B.../yyy"}]}
```

5. Deploy.

That's it. The container starts, registers all your routes, and begins relaying events.

## Connect Dokploy webhooks to the relay

For each project you want to monitor:

1. Open the project in the Dokploy dashboard.
2. Go to **Settings > Notifications** (or the webhook / notification section).
3. Add a new webhook notification pointing to the matching route:

```
https://your-relay-domain.com/webhook/api
```

4. Select the events you want to receive (deploy, build, error, etc.).
5. Save.

Repeat for every project. Each one uses its own `/webhook/...` path defined in your config.

## Create a Slack incoming webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or pick an existing one).
2. Enable **Incoming Webhooks** and click **Add New Webhook to Workspace**.
3. Choose the channel where messages should appear.
4. Copy the webhook URL and use it as `slackWebhookUrl` in your route config.

Create as many webhooks as you need — one per Slack channel, one per route, or share one across multiple routes.

## Health check

```
GET /health
→ { "status": "ok" }
```

## License

[MIT](LICENSE)
