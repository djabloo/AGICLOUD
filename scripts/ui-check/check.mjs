// Prova UI via browserless (vedi run.sh): login, conversazione demo, permesso, screenshot desktop + mobile, axe
import { mkdirSync, writeFileSync } from 'node:fs';
const OUT = process.env.OUT || 'ui-check-out';
mkdirSync(OUT, { recursive: true });
const DARK = process.env.DARK === '1';
const code = `
export default async function ({ page }) {
  const out = { steps: [], shots: {}, axe: {} };
  const BASE = '${process.env.BASE || 'http://agicloud-uitest:3095/'}';
  await page.setBypassCSP(true);
  out.console = [];
  page.on('console', (m) => { if (m.type() === 'error') out.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => out.console.push('PAGEERROR ' + String(e).slice(0, 300)));
  ${DARK ? "await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);" : ''}
  const runAxe = async (label) => {
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js' });
    const r = await page.evaluate(async () => {
      const res = await axe.run(document, { runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] });
      return res.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, target: v.nodes.slice(0,3).map(n => n.target.join(' ')), detail: v.nodes.slice(0,2).map(n => (n.html || '').slice(0,120) + ' | ' + (n.any?.[0]?.message || '')) }));
    });
    out.axe[label] = r;
  };
  const shot = async (label) => { out.shots[label] = await page.screenshot({ encoding: 'base64', captureBeyondViewport: false }); };

  try {
  await page.setViewport({ width: 1366, height: 860 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=password]');
  await runAxe('login');
  await shot('login');
  await page.type('input[type=password]', '${process.env.TOKEN || 'prova-locale-123'}');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.welcome');
  out.steps.push('login ok');
  await runAxe('welcome');
  await shot('welcome');

  await page.click('.new-btn');
  await page.waitForSelector('dialog[open]');
  await page.click('input[value=demo]');
  await page.waitForSelector('.dir-btn');
  await page.click('.dir-btn');
  await page.waitForFunction(() => document.querySelector('.browser-path')?.textContent.startsWith('/'));
  await page.$eval('dialog input.mono-input', (el) => { el.value = ''; });
  await page.type('dialog input.mono-input', '/tmp/proj/demo');
  await shot('dialog');
  await runAxe('dialog');
  await page.click('dialog .btn.primary');
  await page.waitForSelector('.chat');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent.includes('Pronto'), { timeout: 20000 });
  out.steps.push('thread pronto');
  // Impostazioni dell'agente e comandi slash
  await page.waitForSelector('.config-bar select');
  out.configLabels = await page.$$eval('.config-bar .cfg-name', (els) => els.map((e) => e.textContent));
  const modelSelect = (await page.$$('.config-bar select'))[1];
  await modelSelect.select('lento');
  await page.waitForFunction(() => document.querySelectorAll('.config-bar select')[1]?.value === 'lento');
  await page.type('.composer textarea', '/pi');
  await page.waitForSelector('.suggestions [role=option]');
  out.suggestions = await page.$$eval('.suggestions .suggestion-name', (els) => els.map((e) => e.textContent));
  await shot('commands');
  await runAxe('commands');
  await page.keyboard.press('Escape');
  await page.$eval('.composer textarea', (el) => { el.focus(); });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type('.composer textarea', 'Crea un file di prova');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.permission:not(.is-resolved) button', { timeout: 20000 });
  out.steps.push('permesso richiesto');
  out.liveAssertive = await page.evaluate(() => document.querySelector('[aria-live=assertive]')?.textContent);
  await shot('permission');
  await runAxe('permission');
  await page.click('.permission .btn.primary');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent.includes('Pronto') && document.querySelectorAll('.from-assistant').length >= 2, { timeout: 20000 });
  out.steps.push('turno completato');
  out.diff = await page.evaluate(() => ({
    stat: document.querySelector('.diff-stat')?.textContent,
    add: document.querySelectorAll('.diff .dl-add').length,
    del: document.querySelectorAll('.diff .dl-del').length,
  }));
  out.livePolite = await page.evaluate(() => document.querySelector('[aria-live=polite]')?.textContent);
  await page.evaluate(() => document.querySelectorAll('details.tool')[0]?.setAttribute('open',''));
  await shot('done');
  await runAxe('done');

  // Telefono
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.from-assistant').length >= 2, { timeout: 20000 });
  out.mobile = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
    sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).visibility,
  }));
  await shot('mobile-chat');
  await page.click('.menu-btn');
  await new Promise(r => setTimeout(r, 400));
  out.mobileDrawer = await page.evaluate(() => ({
    expanded: document.querySelector('.menu-btn').getAttribute('aria-expanded'),
    focused: document.activeElement?.className, mainInert: document.querySelector('main').inert,
  }));
  await shot('mobile-drawer');
  await runAxe('mobile-drawer');
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  out.afterEsc = await page.evaluate(() => ({ expanded: document.querySelector('.menu-btn').getAttribute('aria-expanded'), focused: document.activeElement?.className }));
  // Allegati: file nascosto + invio, l'agente demo rimanda il testo ricevuto
  await page.evaluate(() => {
    const input = document.querySelector('.composer input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File(['ciao dal file'], 'nota prova.txt', { type: 'text/plain' }));
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    dt.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.attach-list.pending .attach-chip.is-ready').length === 2, { timeout: 10000 });
  await shot('attach-pending');
  await runAxe('attach-pending');
  await page.type('.composer textarea', 'Leggi gli allegati');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.attach-list.sent .attach-chip').length === 2, { timeout: 10000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.from-assistant')].some((m) => m.textContent.includes('.agicloud/uploads/')), { timeout: 15000 });
  out.attachEcho = await page.evaluate(() => [...document.querySelectorAll('.from-assistant')].pop().textContent.slice(0, 300));
  out.steps.push('allegati ok');
  await shot('attach-sent');

  // Impostazioni
  await page.setViewport({ width: 1366, height: 860 });
  await page.goto(BASE + '#/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.agent-card', { timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-card h3')].some((h) => h.textContent.startsWith('Demo')), { timeout: 30000 });
  out.settingsAgents = await page.$$eval('.agent-card', (cards) => cards.map((c) => c.querySelector('h3').textContent + ': ' + c.querySelector('.badge').textContent));
  out.demoDefaults = await page.$$eval('.agent-card', (cards) => {
    const demo = cards.find((c) => c.querySelector('h3').textContent.startsWith('Demo'));
    return demo ? [...demo.querySelectorAll('.defaults select')].length : -1;
  });
  await page.type('.add-key input.mono-input', 'FAL_KEY');
  await page.type('.add-key input[type=password]', 'chiave-finta-9876');
  await page.click('.add-key .btn.primary');
  await page.waitForSelector('.vault-item');
  out.vault = await page.$eval('.vault-list', (el) => el.textContent);
  out.vaultLeak = (await page.content()).includes('chiave-finta');
  out.steps.push('impostazioni ok');
  await shot('settings');
  await runAxe('settings');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 300));
  out.settingsMobile = await page.evaluate(() => document.documentElement.scrollWidth);
  await shot('settings-mobile');
  await runAxe('settings-mobile');

  // File: crea, modifica, salva, anteprima
  await page.setViewport({ width: 1366, height: 860 });
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('nota.md') : d.accept()));
  await page.goto(BASE + '#/files/' + encodeURIComponent('/tmp/proj/demo'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.files-toolbar');
  await page.evaluate(() => [...document.querySelectorAll('.files-toolbar button')].find((b) => b.textContent.includes('File')).click());
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.click('.cm-content');
  await page.keyboard.type('# Titolo di prova\\n\\nTesto **in grassetto**.');
  out.editorDebug = await page.evaluate(() => ({ active: document.activeElement?.className, doc: document.querySelector('.cm-content')?.textContent, editors: document.querySelectorAll('.cm-editor').length, touch: 'ontouchstart' in window }));
  await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('.viewer-status')?.textContent.includes('Salvato'), { timeout: 10000 });
  out.steps.push('file salvato');
  await shot('files-edit');
  await runAxe('files-edit');
  await page.evaluate(() => [...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('Anteprima')).click());
  await page.waitForSelector('.md-preview strong');
  out.mdPreview = await page.$eval('.md-preview', (el) => el.innerHTML.slice(0, 120));
  await shot('files-preview');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 400));
  out.filesMobile = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, browserVisible: getComputedStyle(document.querySelector('.files-browser')).display }));
  await shot('files-mobile');
  await runAxe('files-mobile');

  // Terminale
  await page.setViewport({ width: 1366, height: 860 });
  await page.goto(BASE + '#/term', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.welcome');
  await page.click('.new-btn');
  await page.waitForSelector('dialog[open] input.mono-input');
  await page.$eval('dialog[open] input.mono-input', (el) => { el.value = ''; });
  await page.type('dialog[open] input.mono-input', '/tmp/proj/demo');
  await page.click('dialog[open] .btn.primary');
  await page.waitForSelector('.term .xterm', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.term .status')?.textContent.includes('Collegato'), { timeout: 10000 });
  await page.click('.term-host');
  await page.keyboard.type('echo CIAO-$((1+1)) && pwd');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('CIAO-2'), { timeout: 10000 });
  out.steps.push('terminale ok');
  await shot('terminal');
  await runAxe('terminal');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('CIAO-2'), { timeout: 10000 });
  out.steps.push('terminale ripreso dopo ricarica');
  out.terminalMobile = await page.evaluate(() => ({
    keybar: getComputedStyle(document.querySelector('.keybar')).display,
    scrollW: document.documentElement.scrollWidth,
  }));
  await shot('terminal-mobile');
  await runAxe('terminal-mobile');
  } catch (err) {
    out.error = String(err);
    out.text = await page.evaluate(() => document.body.innerText.slice(0, 800));
    await shot('error');
  }
  return { data: out, type: 'application/json' };
}`;
const res = await fetch(process.env.BROWSERLESS || 'http://127.0.0.1:3030/function', { method: 'POST', headers: { 'content-type': 'application/javascript' }, body: code });
const text = await res.text();
let data;
try { data = JSON.parse(text); data = data.data ?? data; } catch { console.log(res.status, text.slice(0, 2000)); process.exit(1); }
for (const [k, v] of Object.entries(data.shots || {})) writeFileSync(`${OUT}/${k}.png`, Buffer.from(v, 'base64'));
delete data.shots;
console.log(JSON.stringify(data, null, 1));
