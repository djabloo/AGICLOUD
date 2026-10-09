export interface SystemInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Regole craft consigliate dal design system */
  craft: string[];
  /** Pagine in preview/ (colori, tipografia, spaziature) */
  previews: string[];
  /** C'e' system/kit.html (componenti di esempio) */
  kit: boolean;
}

export interface SkillInfo {
  id: string;
  name: string;
  emoji?: string;
  description: string;
  /** prototype, deck, template, design-system... (da open-design) */
  mode: string;
  category: string;
  /** Regole craft richieste */
  craft: string[];
  /** La skill rende meglio con un design system */
  needsSystem: boolean;
  examplePrompt?: string;
  /** C'e' example.html */
  example: boolean;
}

export interface Catalog {
  source: { repo: string; commit: string };
  systems: SystemInfo[];
  skills: SkillInfo[];
  craft: string[];
}

/** Scelta fatta alla creazione della conversazione */
export interface DesignChoice {
  skill?: string;
  system?: string;
}
