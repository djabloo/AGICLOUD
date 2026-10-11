import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/usr/local/bin/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:3171/flow-novnc/5e24c2eac03da23d9e40b68087293c5d/vnc.html?autoconnect=1&resize=scale&reconnect=1'); await p.waitForTimeout(14000);
await p.screenshot({ path: '/tmp/novnc.png' });
await b.close();
