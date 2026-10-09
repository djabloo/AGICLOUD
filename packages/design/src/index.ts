// Plugin Design: skill, design system e regole "craft" presi da open-design (content/, vedi NOTICE.md).
// Alla prima richiesta di una conversazione di design il kit scelto viene copiato nel progetto
// (.agicloud/design/) e l'agente riceve poche righe che gli dicono cosa leggere: funziona con
// qualsiasi agente che sa leggere file, senza MCP.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, DesignChoice, SkillInfo, SystemInfo } from './types.js';

export type { Catalog, DesignChoice, SkillInfo, SystemInfo } from './types.js';

export const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content');

/** Cartella del kit dentro il progetto (gia' esclusa da git insieme a tutto .agicloud/) */
export const KIT_DIR = join('.agicloud', 'design');

/** Cartella del progetto dove l'agente scrive le pagine */
export const OUTPUT_DIR = 'design';

/** File di un design system utili all'agente (le anteprime restano alla galleria) */
const SYSTEM_KIT_FILES = ['DESIGN.md', 'USAGE.md', 'tokens.css', 'tailwind-v4.css', 'design-tokens.json', 'components.html', 'components.manifest.json'];

let cached: Catalog | null = null;

export function catalog(): Catalog {
  cached ??= JSON.parse(readFileSync(join(CONTENT_DIR, 'catalog.json'), 'utf8')) as Catalog;
  return cached;
}

export function getSkill(id: string): SkillInfo | undefined {
  return catalog().skills.find((s) => s.id === id);
}

export function getSystem(id: string): SystemInfo | undefined {
  return catalog().systems.find((s) => s.id === id);
}

export function skillDir(id: string): string {
  return join(CONTENT_DIR, 'skills', id);
}

export function systemDir(id: string): string {
  return join(CONTENT_DIR, 'systems', id);
}

/** Scelta pulita (id noti) o null se vuota; lancia un errore con un id sconosciuto */
export function normalizeChoice(raw: unknown): DesignChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const { skill, system } = raw as Record<string, unknown>;
  const choice: DesignChoice = {};
  if (typeof skill === 'string' && skill) {
    if (!getSkill(skill)) throw new Error(`Skill sconosciuta: ${skill}`);
    choice.skill = skill;
  }
  if (typeof system === 'string' && system) {
    if (!getSystem(system)) throw new Error(`Design system sconosciuto: ${system}`);
    choice.system = system;
  }
  return choice.skill || choice.system ? choice : null;
}

/** Regole craft da seguire: quelle chieste dalla skill e quelle consigliate dal design system */
export function craftFor(choice: DesignChoice): string[] {
  const wanted = [
    ...(choice.skill ? getSkill(choice.skill)?.craft ?? [] : []),
    ...(choice.system ? getSystem(choice.system)?.craft ?? [] : []),
  ];
  const known = new Set(catalog().craft);
  return [...new Set(wanted)].filter((c) => known.has(c));
}

/** Copia nel progetto il kit scelto (sostituisce quello di prima) */
export function installKit(cwd: string, choice: DesignChoice): void {
  const kit = join(cwd, KIT_DIR);
  rmSync(kit, { recursive: true, force: true });
  mkdirSync(kit, { recursive: true });
  if (choice.skill) cpSync(skillDir(choice.skill), join(kit, 'skill'), { recursive: true });
  if (choice.system) {
    for (const f of SYSTEM_KIT_FILES) {
      const from = join(systemDir(choice.system), f);
      if (existsSync(from)) cpSync(from, join(kit, 'system', f));
    }
  }
  for (const c of craftFor(choice)) cpSync(join(CONTENT_DIR, 'craft', `${c}.md`), join(kit, 'craft', `${c}.md`));
  writeFileSync(join(kit, 'NOTICE.md'), readFileSync(join(CONTENT_DIR, 'NOTICE.md'), 'utf8'));
}

/** Istruzioni messe davanti alla prima richiesta (l'utente in chat vede solo la sua) */
export function kitPrompt(choice: DesignChoice): string {
  const skill = choice.skill ? getSkill(choice.skill) : undefined;
  const system = choice.system ? getSystem(choice.system) : undefined;
  const craft = craftFor(choice);
  const lines = [`[Design · AgiCloud] Per questo lavoro usa il kit di design in \`${KIT_DIR}/\` (da Open Design). Prima di iniziare:`];
  if (skill) {
    lines.push(`- Skill "${skill.name}": leggi e segui \`${KIT_DIR}/skill/SKILL.md\` (esempi e riferimenti nella stessa cartella).`);
  }
  if (system) {
    lines.push(
      `- Design system "${system.name}": leggi \`${KIT_DIR}/system/DESIGN.md\` e \`USAGE.md\`. Copia il blocco \`:root\` di \`${KIT_DIR}/system/tokens.css\` nel primo \`<style>\` e non usare colori o font fuori dai token.`,
    );
  }
  if (craft.length) {
    lines.push(`- Regole da controllare prima di consegnare: ${craft.map((c) => `\`${KIT_DIR}/craft/${c}.md\``).join(', ')}.`);
  }
  lines.push(
    `Consegna: scrivi file HTML autonomi nella cartella \`${OUTPUT_DIR}/\` del progetto (es. \`${OUTPUT_DIR}/index.html\`), non blocchi \`<artifact>\` in chat: in AgiCloud si vedono nell'anteprima dal vivo. Alla fine indica i file creati.`,
  );
  return lines.join('\n');
}
