// pm2 processes for the live demo on this server (docs/DEPLOY.md):
//   pm2 start ops/ecosystem.config.cjs
// Secrets come from .env.server at the repo root (gitignored, mode 600): DATABASE_URL, SN_PROXY_SECRET.
// Nothing secret is written here.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.server');
const secrets = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) secrets[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

module.exports = {
  apps: [
    {
      name: 'sn-arb-indexer',
      cwd: root,
      script: 'npx',
      args: 'tsx services/indexer/src/main.ts',
      env: { INDEXER_CONFIG: 'deployments/server/indexer.json', DATABASE_URL: secrets.DATABASE_URL },
      restart_delay: 5000,
    },
    {
      name: 'sn-arb-api',
      cwd: root,
      script: 'npx',
      args: 'tsx services/api/src/main.ts',
      env: {
        API_CONFIG: 'deployments/server/api.json', DATABASE_URL: secrets.DATABASE_URL,
        SN_PROXY_SECRET: secrets.SN_PROXY_SECRET, PORT: '8787', HOST: '127.0.0.1',
      },
      restart_delay: 5000,
    },
    {
      name: 'sn-arb-keeper',
      cwd: root,
      script: 'scripts/keeper-loop.sh',
      interpreter: 'bash',
      restart_delay: 10000,
    },
  ],
};
