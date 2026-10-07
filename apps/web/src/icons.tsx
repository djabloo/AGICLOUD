// Icone decorative: sempre aria-hidden, il significato sta nel testo (visibile o per screen reader).

const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h13M12 5l7 7-7 7',
  stop: 'M7 7h10v10H7z',
  chat: 'M4 5h16v11H8l-4 4z',
  files: 'M4 4h6l2 2h8v13H4z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  tool: 'M14 6a4 4 0 0 0-5 5l-5 5 3 3 5-5a4 4 0 0 0 5-5l-3 3-3-3z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  settings: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  clip: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
