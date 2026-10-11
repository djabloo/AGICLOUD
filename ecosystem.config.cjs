// PM2: pm2 start ecosystem.config.cjs  (dopo npm run build)
// Il token sta in un file fuori dalla repo, letto da Node con --env-file.
const envFile = process.env.AGICLOUD_ENV_FILE || '/home/user/.secrets/agicloud-app.env';

module.exports = {
  apps: [
    {
      name: 'agicloud-app',
      cwd: __dirname,
      script: 'apps/server/src/index.ts',
      interpreter: 'node',
      node_args: `--env-file=${envFile} --import tsx`,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3095',
        TRUST_PROXY: '1',
      },
      max_memory_restart: '600M',
    },
  ],
};
