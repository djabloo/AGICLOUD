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
    {
      // Unico servizio che parla con Docker (container degli utenti). Solo 127.0.0.1.
      name: 'agicloud-orchestrator',
      cwd: __dirname,
      script: 'apps/orchestrator/src/index.ts',
      interpreter: 'node',
      node_args: `--env-file=${process.env.AGICLOUD_PLATFORM_ENV || '/opt/agicloud/.env'} --import tsx`,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '200M',
    },
  ],
};
