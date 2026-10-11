import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { Runners } from './docker.js';

const secret = process.env.ORCHESTRATOR_SECRET ?? '';
if (secret.length < 32) {
  console.error('ORCHESTRATOR_SECRET mancante o troppo corto (min 32 caratteri)');
  process.exit(1);
}
const env = process.env;
const runners = new Runners({
  image: env.RUNNER_IMAGE ?? 'agicloud/node:latest',
  internalPort: Number(env.RUNNER_PORT ?? 3095),
  network: env.RUNNER_NETWORK ?? 'agicloud-runners',
  dataRoot: env.RUNNERS_DATA_DIR ?? '/opt/agicloud/runners',
  user: env.RUNNER_USER ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
});
const port = Number(env.ORCHESTRATOR_PORT ?? 3111);
// Mai 0.0.0.0: l'orchestratore parla solo con la piattaforma sulla stessa macchina
serve({ fetch: createApp(runners, secret).fetch, port, hostname: '127.0.0.1' }, () => console.log(`Orchestratore su 127.0.0.1:${port}`));
