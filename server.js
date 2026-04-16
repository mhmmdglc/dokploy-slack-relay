const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3232;
const DEBUG = process.env.DEBUG === "true";

// --- commit store ---
// GitHub push arrives first, Dokploy build event arrives later.
// Store commit info per route so the Dokploy handler can merge it
// into a single Slack message.

const commitStore = new Map();
const COMMIT_TTL = 10 * 60 * 1000; // 10 minutes

function storeCommit(routeName, data) {
  commitStore.set(routeName, { ...data, ts: Date.now() });
}

function consumeCommit(routeName) {
  const entry = commitStore.get(routeName);
  if (!entry) return undefined;
  commitStore.delete(routeName);
  if (Date.now() - entry.ts > COMMIT_TTL) return undefined;
  return entry;
}

// --- config ---

function loadConfig() {
  if (process.env.CONFIG) {
    try {
      return JSON.parse(process.env.CONFIG);
    } catch (err) {
      console.error("Failed to parse CONFIG env var:", err.message);
      process.exit(1);
    }
  }

  const configPath =
    process.env.CONFIG_PATH || path.join(__dirname, "config.json");

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error(
      "Create config.json from config.example.json or set the CONFIG env var."
    );
    process.exit(1);
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error("Failed to parse config file:", err.message);
    process.exit(1);
  }
}

function validateConfig(config) {
  if (
    !config.routes ||
    !Array.isArray(config.routes) ||
    !config.routes.length
  ) {
    console.error("config: at least one route is required");
    process.exit(1);
  }

  const paths = new Set();

  for (const [i, route] of config.routes.entries()) {
    const label = route.name || `routes[${i}]`;

    if (!route.slackWebhookUrl) {
      console.error(`config: "${label}" is missing "slackWebhookUrl"`);
      process.exit(1);
    }
    if (!route.dokployPath && !route.githubPath) {
      console.error(
        `config: "${label}" needs at least one of "dokployPath" or "githubPath"`
      );
      process.exit(1);
    }

    for (const key of ["dokployPath", "githubPath"]) {
      const p = route[key];
      if (!p) continue;
      if (!p.startsWith("/")) {
        console.error(`config: "${label}" ${key} must start with /`);
        process.exit(1);
      }
      if (paths.has(p)) {
        console.error(`config: duplicate path "${p}"`);
        process.exit(1);
      }
      paths.add(p);
    }
  }
}

// --- helpers ---

function dig(obj, ...paths) {
  for (const p of paths) {
    const keys = p.split(".");
    let val = obj;
    for (const k of keys) {
      if (val == null) break;
      val = val[k];
    }
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

function normalizeBranch(ref) {
  if (!ref) return undefined;
  return String(ref).replace(/^refs\/heads\//, "");
}

function shortSha(sha) {
  if (!sha) return undefined;
  return String(sha).slice(0, 7);
}

// --- dokploy helpers ---

function getAttachmentField(body, title) {
  const attachments = body.attachments;
  if (!Array.isArray(attachments)) return undefined;

  for (const att of attachments) {
    if (!Array.isArray(att.fields)) continue;
    for (const f of att.fields) {
      if (f.title && f.title.toLowerCase() === title.toLowerCase()) {
        return f.value;
      }
    }
  }
  return undefined;
}

function parsePretext(body) {
  const attachments = body.attachments;
  if (!Array.isArray(attachments)) return undefined;

  for (const att of attachments) {
    if (att.pretext) {
      return att.pretext
        .replace(/:[a-z_]+:/g, "")
        .replace(/\*/g, "")
        .trim();
    }
  }
  return undefined;
}

function getAttachmentColor(body) {
  const attachments = body.attachments;
  if (!Array.isArray(attachments) || !attachments[0]) return undefined;
  return attachments[0].color;
}

function getActionUrl(body) {
  const attachments = body.attachments;
  if (!Array.isArray(attachments)) return undefined;

  for (const att of attachments) {
    if (!Array.isArray(att.actions)) continue;
    for (const action of att.actions) {
      if (action.url) return action.url;
    }
  }
  return undefined;
}

// --- extract: dokploy ---

function extractDokploy(body) {
  const isDokployAttachment =
    Array.isArray(body.attachments) && body.attachments.length > 0;

  if (isDokployAttachment) {
    return {
      project: getAttachmentField(body, "Project") || "unknown",
      application: getAttachmentField(body, "Application") || "unknown",
      eventType: parsePretext(body) || "unknown",
      appType: getAttachmentField(body, "Type"),
      time: getAttachmentField(body, "Time"),
      color: getAttachmentColor(body),
      actionUrl: getActionUrl(body),
    };
  }

  return {
    project: dig(body, "projectName", "project.name", "project") || "unknown",
    application:
      dig(
        body,
        "applicationName",
        "application.name",
        "application",
        "service.name",
        "serviceName"
      ) || "unknown",
    eventType:
      dig(body, "title", "type", "event", "eventType", "status") || "unknown",
    time: dig(body, "date", "timestamp"),
    color: dig(body, "status") === "error" ? "#FF0000" : "#00FF00",
    actionUrl: dig(body, "buildLink"),
  };
}

// --- extract: github ---

function extractGithub(body) {
  const repo =
    dig(body, "repository.full_name", "repository.name") || "unknown";
  const branch = normalizeBranch(dig(body, "ref"));
  const repoUrl = dig(body, "repository.html_url");

  const headCommit = body.head_commit;
  const commits = body.commits;

  let commitSha, commitMessage, commitUrl, author;

  if (headCommit) {
    commitSha = shortSha(headCommit.id);
    commitMessage = headCommit.message;
    commitUrl = headCommit.url;
    author =
      dig(headCommit, "author.username", "author.name") ||
      dig(body, "pusher.name");
  } else if (Array.isArray(commits) && commits.length > 0) {
    const last = commits[commits.length - 1];
    commitSha = shortSha(last.id);
    commitMessage = last.message;
    commitUrl = last.url;
    author = dig(last, "author.username", "author.name");
  }

  if (commitMessage) {
    commitMessage = commitMessage.split("\n")[0];
  }

  return { repo, branch, commitSha, commitMessage, commitUrl, author, repoUrl };
}

// --- build combined slack message ---

function buildSlackMessage(dokploy, commit) {
  const { project, application, eventType, appType, time, color, actionUrl } =
    dokploy;

  const statusEmoji = color === "#00FF00" ? ":white_check_mark:" : ":x:";

  const lines = [
    `${statusEmoji} *${eventType}*`,
    `*${project}* / *${application}*`,
  ];

  if (commit) {
    if (commit.branch) lines.push(`Branch: \`${commit.branch}\``);
    if (commit.commitSha && commit.commitUrl) {
      lines.push(
        `Commit: <${commit.commitUrl}|\`${commit.commitSha}\`> — ${commit.commitMessage || ""}`
      );
    } else if (commit.commitSha) {
      lines.push(
        `Commit: \`${commit.commitSha}\` — ${commit.commitMessage || ""}`
      );
    }
    if (commit.author) lines.push(`Author: ${commit.author}`);
  }

  const slackFields = [];
  if (appType)
    slackFields.push({ title: "Type", value: appType, short: true });
  if (time) slackFields.push({ title: "Time", value: time, short: true });

  const attachment = {
    color: color || "#00FF00",
    text: lines.join("\n"),
    fields: slackFields,
    mrkdwn_in: ["text"],
  };

  if (actionUrl) {
    attachment.actions = [
      { type: "button", text: "View Details", url: actionUrl },
    ];
  }

  return { attachments: [attachment] };
}

// --- send to slack ---

function postToSlack(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const parsed = new URL(webhookUrl);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Slack returned ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// --- request handlers ---

function makeGithubHandler(route) {
  return async (req, res) => {
    const label = route.name || route.githubPath;
    const event = req.headers["x-github-event"];

    // Only handle push events, acknowledge the rest
    if (event && event !== "push") {
      console.log(`[github][${label}] Ignored event: ${event}`);
      return res.json({ ok: true, ignored: true });
    }

    if (DEBUG) {
      console.log(
        `[github][${label}] Incoming payload:`,
        JSON.stringify(req.body, null, 2)
      );
    }

    const fields = extractGithub(req.body);

    // Store commit info — Dokploy handler will pick it up later
    storeCommit(label, fields);

    console.log(
      `[github][${label}] Stored commit ${fields.commitSha || "?"} on ${fields.branch || "?"}`
    );

    res.json({ ok: true });
  };
}

function makeDokployHandler(route) {
  return async (req, res) => {
    const label = route.name || route.dokployPath;

    if (DEBUG) {
      console.log(
        `[dokploy][${label}] Incoming payload:`,
        JSON.stringify(req.body, null, 2)
      );
    }

    try {
      const dokploy = extractDokploy(req.body);

      // Try to get stored commit info from GitHub
      const commit = consumeCommit(label);

      if (commit) {
        console.log(
          `[dokploy][${label}] Merged with commit ${commit.commitSha || "?"}`
        );
      }

      const message = buildSlackMessage(dokploy, commit);
      await postToSlack(route.slackWebhookUrl, message);

      console.log(
        `[dokploy][${label}] Relayed ${dokploy.eventType} for ${dokploy.application}`
      );
      res.json({ ok: true });
    } catch (err) {
      console.error(`[dokploy][${label}] Failed to relay:`, err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  };
}

// --- register routes ---

const config = loadConfig();
validateConfig(config);

for (const route of config.routes) {
  if (route.githubPath) {
    app.post(route.githubPath, makeGithubHandler(route));
  }
  if (route.dokployPath) {
    app.post(route.dokployPath, makeDokployHandler(route));
  }
}

// --- health ---

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- start ---

app.listen(PORT, () => {
  console.log(`dokploy-slack-relay listening on :${PORT}`);
  console.log("Routes:");
  for (const route of config.routes) {
    const label = route.name || "(unnamed)";
    if (route.dokployPath)
      console.log(`  ${label} [dokploy] -> POST ${route.dokployPath}`);
    if (route.githubPath)
      console.log(`  ${label} [github]  -> POST ${route.githubPath}`);
  }
});
