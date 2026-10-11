import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/usr/local/bin/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:3171/flow-novnc/afd4f79da73a511d887eb3a94966bc34/vnc.html?autoconnect=1&resize=scale&reconnect=1'); await p.waitForTimeout(15000);
await p.screenshot({ path: '/tmp/novnc.png' });
await b.close();
