const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === "true";

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
  if (!config.routes || !Array.isArray(config.routes) || !config.routes.length) {
    console.error("config: at least one route is required");
    process.exit(1);
  }

  const paths = new Set();

  for (const [i, route] of config.routes.entries()) {
    const label = route.name || `routes[${i}]`;

    if (!route.path) {
      console.error(`config: "${label}" is missing "path"`);
      process.exit(1);
    }
    if (!route.path.startsWith("/")) {
      console.error(`config: "${label}" path must start with /`);
      process.exit(1);
    }
    if (!route.slackWebhookUrl) {
      console.error(`config: "${label}" is missing "slackWebhookUrl"`);
      process.exit(1);
    }
    if (paths.has(route.path)) {
      console.error(`config: duplicate path "${route.path}"`);
      process.exit(1);
    }
    paths.add(route.path);
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

// --- extract fields from payload ---

function extract(body) {
  const project =
    dig(body, "project.name", "projectName", "project") || "unknown";

  const application =
    dig(
      body,
      "application.name",
      "applicationName",
      "application",
      "service.name",
      "serviceName"
    ) || "unknown";

  const eventType =
    dig(
      body,
      "type",
      "event",
      "eventType",
      "action",
      "status",
      "deploymentStatus"
    ) || "unknown";

  const branch = normalizeBranch(
    dig(
      body,
      "branch",
      "deployment.branch",
      "application.branch",
      "ref",
      "gitBranch"
    )
  );

  const commitSha = shortSha(
    dig(
      body,
      "commitSha",
      "commit.sha",
      "deployment.commitSha",
      "sha",
      "commitHash",
      "deployment.sha"
    )
  );

  const commitMessage = dig(
    body,
    "commitMessage",
    "commit.message",
    "deployment.commitMessage",
    "message",
    "commitTitle"
  );

  return { project, application, eventType, branch, commitSha, commitMessage };
}

// --- build slack message ---

function buildSlackMessage(fields, routeName) {
  const { project, application, eventType, branch, commitSha, commitMessage } =
    fields;

  const lines = [
    `*${project}* / *${application}*`,
    `Event: \`${eventType}\``,
  ];

  if (branch) lines.push(`Branch: \`${branch}\``);
  if (commitSha) lines.push(`Commit: \`${commitSha}\``);
  if (commitMessage) lines.push(`Message: ${commitMessage}`);

  return { text: lines.join("\n") };
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

// --- register routes ---

const config = loadConfig();
validateConfig(config);

for (const route of config.routes) {
  app.post(route.path, async (req, res) => {
    const label = route.name || route.path;

    if (DEBUG) {
      console.log(`[${label}] Incoming payload:`, JSON.stringify(req.body, null, 2));
    }

    try {
      const fields = extract(req.body);
      const message = buildSlackMessage(fields, route.name);
      await postToSlack(route.slackWebhookUrl, message);
      console.log(`[${label}] Relayed ${fields.eventType} event for ${fields.application}`);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[${label}] Failed to relay:`, err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

// --- health ---

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- start ---

app.listen(PORT, () => {
  console.log(`dokploy-slack-relay listening on :${PORT}`);
  console.log(`Routes:`);
  for (const route of config.routes) {
    console.log(`  ${route.name || "(unnamed)"} -> POST ${route.path}`);
  }
});
