import { createAdaptorServer } from '@hono/node-server';
import { chmodSync, rmSync } from 'node:fs';
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
  routesFile: env.ROUTES_FILE ?? '/opt/agicloud/run/routes.json',
  rootDomain: env.PLATFORM_ROOT_DOMAIN ?? 'agicloud.dev',
  user: env.RUNNER_USER ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
});
// Niente rete: l'orchestratore parla con la piattaforma solo su un socket Unix (montato nel suo container).
// Accesso comunque protetto dal segreto; il socket e' apribile a tutti perche' il container gira con un altro uid.
const socketPath = env.ORCHESTRATOR_SOCKET ?? '/opt/agicloud/run/orchestrator.sock';
rmSync(socketPath, { force: true });
const server = createAdaptorServer({ fetch: createApp(runners, secret).fetch });
server.listen(socketPath, () => {
  runners.writeRoutes().catch((err) => console.error('Rotte non scritte:', err));
  chmodSync(socketPath, 0o666);
  console.log(`Orchestratore su ${socketPath}`);
});
