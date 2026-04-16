# dokploy-slack-relay

Lightweight webhook relay that forwards [Dokploy](https://dokploy.com) deployment events and GitHub push events to Slack.

Add unlimited projects — each one gets its own endpoints and Slack channel. Zero limits, zero complexity.

## How it works

```
                                         ┌───────────────────┐
 Dokploy ── POST /dokploy/api ──────┐    │                   │
 GitHub  ── POST /github/api ───────┤    │                   │
                                    ├───►│   dokploy-slack   ├──► Slack channels
 Dokploy ── POST /dokploy/frontend ─┤    │       relay       │
 GitHub  ── POST /github/frontend ──┘    │                   │
                                         └───────────────────┘
```

Each project can have two webhook sources:

- **Dokploy** — build status, project name, application name, time, status link
- **GitHub** — commit SHA, commit message, branch, author, commit link

Both land in the same Slack channel so you get the full picture: who pushed what, and whether the build succeeded.

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
      "dokployPath": "/dokploy/api",
      "githubPath": "/github/api",
      "slackWebhookUrl": "YOUR_SLACK_WEBHOOK_URL_HERE"
    },
    {
      "name": "frontend",
      "dokployPath": "/dokploy/frontend",
      "githubPath": "/github/frontend",
      "slackWebhookUrl": "YOUR_SLACK_WEBHOOK_URL_HERE"
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
dokploy-slack-relay listening on :3232
Routes:
  api [dokploy] -> POST /dokploy/api
  api [github]  -> POST /github/api
  frontend [dokploy] -> POST /dokploy/frontend
  frontend [github]  -> POST /github/frontend
```

## Configuration

### Route definition

Each route in `config.json`:

| Field | Required | Description |
|---|---|---|
| `name` | No | Label shown in logs |
| `dokployPath` | At least one | POST endpoint for Dokploy webhooks |
| `githubPath` | At least one | POST endpoint for GitHub webhooks |
| `slackWebhookUrl` | Yes | Slack incoming webhook URL |

You can use only `dokployPath`, only `githubPath`, or both. Add as many routes as you need — there is no limit.

### Loading config

The relay looks for configuration in this order:

1. **`CONFIG` env var** — JSON string (best for Docker / Dokploy)
2. **`CONFIG_PATH` env var** — path to a JSON file
3. **`./config.json`** — default file in the project root

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3232` | Port to listen on |
| `DEBUG` | No | `false` | Log full incoming payloads |
| `CONFIG` | No | — | Full config as a JSON string |
| `CONFIG_PATH` | No | `./config.json` | Path to the config file |

## Deploy on Dokploy

1. Create a new application in Dokploy.
2. Point the source to your fork or clone of this repo.
3. Set the build type to **Dockerfile**.
4. Add the `CONFIG` environment variable with your routes:

```
{"routes":[{"name":"api","dokployPath":"/dokploy/api","githubPath":"/github/api","slackWebhookUrl":"YOUR_SLACK_WEBHOOK_URL_HERE"}]}
```

5. Deploy.

## Connect Dokploy webhooks

For each project you want to monitor:

1. Open the project in the Dokploy dashboard.
2. Go to **Settings > Notifications**.
3. Add a new webhook notification pointing to:

```
https://your-relay-domain.com/dokploy/api
```

4. Select the events you want to receive.
5. Save.

## Connect GitHub webhooks

For each repo you want to monitor:

1. Go to your GitHub repo > **Settings > Webhooks > Add webhook**.
2. Set the **Payload URL** to:

```
https://your-relay-domain.com/github/api
```

3. Set **Content type** to `application/json`.
4. Under **Which events**, select **Just the push event**.
5. Save.

The relay only processes `push` events and ignores everything else (ping, pull request, etc.).

## Slack message examples

**Dokploy event:**

```
✅ Build Success
kordinat / Frontend
Type: application    Time: 4/16/2026, 1:06 PM
[View Details]
```

**GitHub push event:**

```
🔀 New push
owner/my-repo
Branch: main
Commit: abc1234 — fix: resolve login bug
Author: johndoe
```

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
