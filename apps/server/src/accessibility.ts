// Backend per il plugin privato esterno "Accessibilità" (/home/user/agicloud-plugin-accessibility):
// espone il server MCP per gli agenti e le route /api/accessibility/* per l'interfaccia web.

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { HttpError } from './errors.js';

const PLUGIN_DIR = '/home/user/agicloud-plugin-accessibility';
const MCP_SCRIPT = join(PLUGIN_DIR, 'mcp-server.mjs');
const SKILL_FILE = join(PLUGIN_DIR, 'SKILL.md');
const REPORTS_DIR = join(homedir(), '.local', 'state', 'agicloud', 'accessibility-reports');
const WCAG_REPORTS_DIR = '/opt/wcag/public/reports';

export function accessibilityMcpServer(): acp.McpServerStdio {
  return {
    name: 'accessibility',
    command: 'node',
    args: [MCP_SCRIPT],
    env: [],
  };
}

async function loadPluginModule(): Promise<{
  handleTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  buildAndSaveReport: (args: Record<string, unknown>) => Promise<any>;
}> {
  if (!existsSync(MCP_SCRIPT)) throw new HttpError(404, 'Non trovato');
  return import(MCP_SCRIPT);
}

export function registerAccessibility(app: Hono<any>): void {
  mkdirSync(REPORTS_DIR, { recursive: true });

  app.get('/api/accessibility/skill', (c) => {
    const skill = existsSync(SKILL_FILE) ? readFileSync(SKILL_FILE, 'utf8') : '';
    return c.json({ skill });
  });

  app.get('/api/accessibility/reports', (c) => {
    const list: any[] = [];
    if (existsSync(REPORTS_DIR)) {
      for (const f of readdirSync(REPORTS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf8'));
          list.push({ ...meta, source: 'agicloud' });
        } catch {
          /* ignore */
        }
      }
    }
    if (existsSync(WCAG_REPORTS_DIR)) {
      for (const f of readdirSync(WCAG_REPORTS_DIR)) {
        if (!f.endsWith('.pdf')) continue;
        try {
          const st = statSync(join(WCAG_REPORTS_DIR, f));
          list.push({
            id: `wcag_${f}`,
            url: f.replace(/^WCAG_Audit_(?:PRO_)?/i, '').replace(/\.pdf$/i, ''),
            title: f.replace(/\.pdf$/i, ''),
            createdAt: st.mtimeMs,
            scores: {},
            hasPdf: true,
            onlyPdf: true,
            source: 'wcag',
          });
        } catch {
          /* ignore */
        }
      }
    }
    list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return c.json({ reports: list });
  });

  app.get('/api/accessibility/reports/:id/:format', (c) => {
    const id = c.req.param('id').replace(/[^a-zA-Z0-9._-]/g, '');
    const fmt = c.req.param('format');
    if (id.startsWith('wcag_')) {
      const pdfName = id.slice('wcag_'.length);
      const p = join(WCAG_REPORTS_DIR, pdfName);
      if (!existsSync(p)) throw new HttpError(404, 'Non trovato');
      c.header('Content-Type', 'application/pdf');
      c.header('Content-Disposition', `inline; filename="${pdfName}"`);
      return c.body(Readable.toWeb(createReadStream(p)) as ReadableStream);
    }
    const ext = fmt === 'pdf' ? 'pdf' : fmt === 'html' ? 'html' : 'md';
    const file = join(REPORTS_DIR, `${id}.${ext}`);
    if (!existsSync(file)) throw new HttpError(404, 'Non trovato');
    const mime = ext === 'pdf' ? 'application/pdf' : ext === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
    c.header('Content-Type', mime);
    if (c.req.query('download') === '1') {
      c.header('Content-Disposition', `attachment; filename="${id}.${ext}"`);
    }
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });

  app.post('/api/accessibility/audit', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const url = String(body.url ?? '').trim();
    if (!url) throw new HttpError(400, 'URL obbligatorio');
    const mode = String(body.mode ?? 'full');
    const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : undefined;
    const mod = await loadPluginModule();

    let wcag: any = null;
    let cogaguard: any = null;

    if (mode === 'full') {
      const [wRes, cRes] = await Promise.allSettled([
        mod.handleTool('wcag_audit_pro', { url, companyName }).catch(() => mod.handleTool('wcag_audit', { url, companyName })),
        mod.handleTool('cogaguard_scan', { url }),
      ]);
      if (wRes.status === 'fulfilled') wcag = wRes.value;
      if (cRes.status === 'fulfilled') cogaguard = cRes.value;
    } else if (mode === 'wcag-pro') {
      wcag = await mod.handleTool('wcag_audit_pro', { url, companyName });
    } else if (mode === 'wcag-standard') {
      wcag = await mod.handleTool('wcag_audit', { url, companyName });
    } else if (mode === 'cogaguard') {
      cogaguard = await mod.handleTool('cogaguard_scan', { url });
    }

    const wcagScore = wcag?.wcagScore ?? wcag?.score ?? undefined;
    const visualScore = typeof wcag?.visualScore === 'number' ? wcag.visualScore : undefined;
    const cogaScore = cogaguard?.score ?? undefined;
    const nums = [wcagScore, visualScore, cogaScore].filter((n): n is number => typeof n === 'number');
    const overall = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : undefined;

    const recs: any[] = [];
    for (const r of wcag?.topRecommendations ?? wcag?.recommendations ?? []) {
      recs.push({
        severity: r.severity || (r.priority === 1 ? 'Critical' : 'High'),
        criterion: r.criterion || 'WCAG',
        title: r.title || 'Problema WCAG',
        description: r.description || r.explanation || '',
        fix: r.recommendation || r.fix || '',
      });
    }
    for (const i of cogaguard?.issues ?? []) {
      recs.push({
        severity: i.severity || 'Medium',
        criterion: i.rule_id || 'COGA',
        title: i.name || 'Problema Cognitivo',
        description: i.why_risky || '',
        fix: i.fix || '',
      });
    }

    const visionNotes = Array.isArray(wcag?.visionIssues)
      ? wcag.visionIssues.map((v: any) => `- [${v.severity}] ${v.category}: ${v.description} → ${v.recommendation}`).join('\n')
      : '';

    const report = await mod.buildAndSaveReport({
      url,
      title: `Report Accessibilità (${mode.toUpperCase()}) — ${url}`,
      summary: `Audit eseguito tramite i workflow n8n (WCAG + CogaGuard) per ${url}. Problemi rilevati: ${recs.length}.`,
      scores: {
        overall,
        wcag: wcagScore,
        visual: visualScore,
        cognitive: cogaScore,
      },
      profiles: {
        blindness_screen_reader: wcag
          ? `Punteggio WCAG tecnico: ${wcagScore ?? 'N/D'}. Critici: ${wcag.criticalCount ?? wcag.critical ?? 0}, Seri: ${wcag.seriousCount ?? wcag.serious ?? 0}, Avvisi: ${wcag.warningCount ?? wcag.warning ?? 0}.`
          : 'Non eseguito in questa modalita\'.',
        low_vision_contrast: visionNotes || wcag?.visionScoreRationale || 'Vedi dettagli visivi e contrasti.',
        hearing_captions: 'Verifica sottotitoli (<track kind="captions">) e trascrizioni consigliata nel test interattivo del Browser condiviso.',
        motor_keyboard: wcag?.mobileDifferences || 'Verifica ordine di tabulazione (Tab / Shift+Tab) e focus ring nel Browser condiviso.',
        cognitive_coga: cogaguard
          ? `Punteggio CogaGuard: ${cogaguard.score ?? 'N/D'} (${cogaguard.label ?? ''}). Problemi cognitivi rilevati: ${(cogaguard.issues ?? []).length}.`
          : 'Non eseguito in questa modalita\'.',
      },
      recommendations: recs,
    });

    return c.json({ wcag, cogaguard, report });
  });

  app.post('/api/accessibility/vision', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mod = await loadPluginModule();
    return c.json(await mod.handleTool('wcag_vision_expert', body));
  });

  app.post('/api/accessibility/simplify', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mod = await loadPluginModule();
    return c.json(await mod.handleTool('cogaguard_decision_card', body));
  });

  app.post('/api/accessibility/pdf-to-md', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mod = await loadPluginModule();
    return c.json(await mod.handleTool('wcag_pdf_to_markdown', body));
  });
}
