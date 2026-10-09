// Importa da una copia di open-design (https://github.com/nexu-io/open-design, Apache 2.0)
// solo i contenuti generici: design system senza marchi e skill che non usano servizi esterni.
// Uso: npm run import -w @agicloud/design -- /percorso/open-design
// Riscrive content/ da zero e rigenera content/catalog.json.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Catalog, SkillInfo, SystemInfo } from '../src/types.js';

/** Stili generici: niente design system "ispirati a" un marchio */
const SYSTEMS = [
  'agentic', 'application', 'artistic', 'atelier-zero', 'bento', 'bold', 'brutalism', 'cafe', 'claymorphism',
  'clean', 'colorful', 'contemporary', 'corporate', 'cosmic', 'creative', 'dashboard', 'default', 'dithered',
  'doodle', 'dramatic', 'editorial', 'elegant', 'energetic', 'enterprise', 'expressive', 'fantasy', 'flat',
  'friendly', 'futuristic', 'glassmorphism', 'gradient', 'hud', 'kami', 'levels', 'luxury', 'minimal',
  'mission-control', 'modern', 'mono', 'neobrutalism', 'neon', 'neumorphism', 'paper', 'perspective', 'premium',
  'professional', 'publication', 'refined', 'retro', 'simple', 'skeumorphism', 'sleek', 'spacious',
  'storytelling', 'tom-modern', 'trading-terminal', 'urdu', 'vibrant', 'vintage', 'warm-editorial',
];

/** File di un design system che servono all'agente e alla galleria (niente traduzioni ne' source/) */
const SYSTEM_FILES = [
  'manifest.json', 'DESIGN.md', 'USAGE.md', 'tokens.css', 'tailwind-v4.css', 'design-tokens.json',
  'components.html', 'components.manifest.json', 'preview', 'system',
];

/** Skill che producono pagine, documenti o presentazioni HTML senza chiavi API ne' marchi */
const SKILLS = [
  // pagine e prototipi
  'frontend-design', 'web-artifacts-builder', 'artifacts-builder', 'frontend-dev', 'article-magazine', 'data-report',
  'doc-kami-parchment', 'faq-page', 'login-flow', 'mockup-device-3d', 'poster-hero', 'release-notes-one-pager',
  'research-decision-room', 'resume-modern', 'd3-visualization', 'hand-drawn-diagrams', 'image-to-code-skill',
  // direzione visiva
  'minimalist-skill', 'brutalist-skill', 'soft-skill', 'taste-skill', 'redesign-skill', 'impeccable-design-polish',
  'emil-design-eng', 'gsap-core', 'threejs', 'shader-dev',
  // presentazioni
  'deck-swiss-international', 'deck-guizang-editorial', 'deck-open-slide-canvas', 'ppt-keynote', 'slides', 'frontend-slides',
  // modelli pronti
  'swiss-creative-mode-template', 'field-notes-editorial-template', 'after-hours-editorial-template',
  'editorial-burgundy-principles-template', 'html-ppt-retro-quarterly-review', 'digits-fintech-swiss-template',
  // brief, revisione, scrittura
  'design-brief', 'design-review', 'design-consultation', 'creative-director', 'color-expert', 'design-md',
  'brainstorming', 'copywriting', 'web-design-guidelines', 'writing-guidelines', 'theme-factory', 'ui-ux-pro-max',
  'plan-design-review',
];

const src = process.argv[2];
if (!src || !existsSync(join(src, 'design-systems'))) {
  console.error('Uso: tsx scripts/import.ts /percorso/open-design');
  process.exit(1);
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'content');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const systems: SystemInfo[] = SYSTEMS.map((id) => {
  const from = join(src, 'design-systems', id);
  for (const f of SYSTEM_FILES) if (existsSync(join(from, f))) cpSync(join(from, f), join(out, 'systems', id, f), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  const design = readFileSync(join(from, 'DESIGN.md'), 'utf8');
  return {
    id,
    name: String(manifest.name ?? id),
    category: String(manifest.category ?? ''),
    // Seconda riga "> ..." dopo la categoria: la descrizione breve
    description: design.match(/^> (?!Category)(.+)$/m)?.[1]?.trim() ?? '',
    craft: Array.isArray(manifest.craft?.suggested) ? manifest.craft.suggested.map(String) : [],
    previews: existsSync(join(from, 'preview')) ? readdirSync(join(from, 'preview')).filter((f) => f.endsWith('.html')) : [],
    kit: existsSync(join(from, 'system', 'kit.html')),
  };
});

const skills: SkillInfo[] = SKILLS.map((id) => {
  const from = join(src, 'skills', id);
  cpSync(from, join(out, 'skills', id), { recursive: true });
  const text = readFileSync(join(from, 'SKILL.md'), 'utf8');
  const fm = (parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '') ?? {}) as Record<string, any>;
  const od = (fm.od ?? {}) as Record<string, any>;
  const description = String(fm.en_description ?? fm.description ?? '').replace(/\s+/g, ' ').trim();
  const rawName = String(fm.en_name ?? fm.name ?? id);
  return {
    id,
    // Molte skill hanno come nome lo slug: "frontend-design" → "Frontend design"
    name: /^[a-z0-9-]+$/.test(rawName) ? (rawName.charAt(0).toUpperCase() + rawName.slice(1)).replace(/-/g, ' ') : rawName,
    emoji: typeof fm.emoji === 'string' ? fm.emoji : undefined,
    description,
    mode: String(od.mode ?? 'prototype'),
    category: String(od.category ?? fm.category ?? ''),
    craft: Array.isArray(od.craft?.requires) ? od.craft.requires.map(String) : [],
    needsSystem: od.design_system?.requires === true,
    examplePrompt: typeof od.example_prompt === 'string' ? od.example_prompt : undefined,
    example: existsSync(join(from, 'example.html')),
  };
});

const craftDir = join(src, 'craft');
mkdirSync(join(out, 'craft'));
const craft = readdirSync(craftDir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'FUTURE_SECTIONS.md');
for (const f of craft) cpSync(join(craftDir, f), join(out, 'craft', f));

cpSync(join(src, 'LICENSE'), join(out, 'LICENSE'));
const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const catalog: Catalog = { source: { repo: 'https://github.com/nexu-io/open-design', commit }, systems, skills, craft: craft.map((f) => f.replace(/\.md$/, '')) };
writeFileSync(join(out, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
writeFileSync(
  join(out, 'NOTICE.md'),
  `# Contenuti da OpenDesign\n\nDesign system, skill e regole "craft" copiati da [open-design](${catalog.source.repo}) al commit \`${commit}\`, licenza Apache 2.0 (\`LICENSE\`).\nAlcune skill hanno una licenza propria (MIT o Apache 2.0) nella loro cartella.\n\nModifiche: tenuti solo gli stili generici (niente design system ispirati a marchi) e le skill che non richiedono servizi esterni; tolte le traduzioni di DESIGN.md e le cartelle \`source/\`.\nRigenerare con \`npm run import -w @agicloud/design -- /percorso/open-design\`.\n`,
);
console.log(`${systems.length} design system, ${skills.length} skill, ${craft.length} regole craft (commit ${commit.slice(0, 7)})`);
