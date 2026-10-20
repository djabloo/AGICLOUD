import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// config.ts legge DATA_DIR all'import: cartella temporanea prima di caricare plugins.ts
const dataDir = mkdtempSync(join(tmpdir(), 'agicloud-plugins-'));
process.env.DATA_DIR = dataDir;
const { specFromManifest } = await import('./plugins.js');

function plugin(manifest: Record<string, unknown>, files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'agicloud-plugin-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

test('manifest completo: testi per lingua, mcp con percorsi sostituiti, server e web', () => {
  const dir = plugin(
    {
      id: 'demo',
      name: { it: 'Prova', en: 'Demo' },
      description: 'Descrizione',
      section: { icon: 'tool', label: { it: 'Prova', de: 'Test' } },
      mcp: { command: 'node', args: ['${PLUGIN_DIR}/mcp.mjs'], autoAllow: true },
      server: 'server.mjs',
      web: 'web',
    },
    ['server.mjs', 'web/index.html'],
  );
  const s = specFromManifest(dir, 'catalog');
  assert.equal(s.id, 'demo');
  assert.equal(s.name, 'Prova');
  assert.deepEqual(s.section, { id: 'demo', label: 'Prova' });
  assert.deepEqual(s.routes, ['/api/x/demo', '/plugin-ui/demo']);
  assert.deepEqual(s.external?.mcp?.args, [`${dir}/mcp.mjs`]);
  assert.equal(s.external?.mcp?.env.AGICLOUD_PLUGIN_DATA, join(dataDir, 'plugin-data', 'demo'));
  assert.equal(s.external?.mcp?.autoAllow, true);
  assert.equal(s.external?.server, join(dir, 'server.mjs'));
  assert.equal(s.external?.web, join(dir, 'web'));
});

test('server e web fuori dalla cartella del plugin vengono ignorati', () => {
  const dir = plugin({ id: 'fuori', name: 'Fuori', section: { label: 'Fuori' }, server: '../../etc/passwd', web: '/etc' });
  const s = specFromManifest(dir, 'link', dir);
  assert.equal(s.external?.server, undefined);
  assert.equal(s.external?.web, undefined);
  // Senza schermata niente voce di menu
  assert.equal(s.section, undefined);
});

test('id non valido o manifest assente: errore', () => {
  assert.throws(() => specFromManifest(plugin({ id: '../x', name: 'X' }), 'link'), /id mancante/);
  assert.throws(() => specFromManifest(plugin({ name: 'X' }), 'link'), /id mancante/);
  assert.throws(() => specFromManifest(mkdtempSync(join(tmpdir(), 'vuoto-')), 'link'), /manifest.json non trovato/);
});

test('segreti: solo nomi di chiave validi dichiarati nel manifest', () => {
  const s = specFromManifest(plugin({ id: 'chiavi', name: 'Chiavi', secrets: ['HETZNER_API_TOKEN', 'minuscolo', '../X', 42] }), 'link');
  assert.deepEqual(s.external?.secrets, ['HETZNER_API_TOKEN']);
  assert.deepEqual(specFromManifest(plugin({ id: 'senza', name: 'Senza' }), 'link').external?.secrets, []);
});
