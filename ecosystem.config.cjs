const path = require("path");
// Loads DASHBOARD_AUTH_USER / DASHBOARD_AUTH_PASS (and anything else) from the
// repo-root .env, same file the bot itself reads, so credentials live in one
// gitignored place instead of being typed into this committed config file.
require("dotenv").config();

const repoRoot = __dirname;

// PUBLIC EXPOSURE: charon-dashboard binds to 0.0.0.0 below — reachable from
// outside this machine, not just localhost (matches the bot's own default
// choice, see dashboard/server.js). Set DASHBOARD_AUTH_USER + DASHBOARD_AUTH_PASS
// in .env before starting it, or anyone who finds the port sees your live
// trading data with zero login. No TLS here either — Basic Auth over plain
// HTTP is not encrypted, only a deterrent against casual/opportunistic
// access. See dashboard/server.js for the full caveat. Set DASHBOARD_HOST=127.0.0.1
// in .env to go back to loopback-only instead.
const dashboardAuthEnv = {
  DASHBOARD_AUTH_USER: process.env.DASHBOARD_AUTH_USER || "",
  DASHBOARD_AUTH_PASS: process.env.DASHBOARD_AUTH_PASS || "",
};

module.exports = {
  apps: [
    {
      name: "charonsol",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
