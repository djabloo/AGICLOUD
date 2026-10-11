export default {
  aggiunte: { one: "{n} line added", other: "{n} lines added" },
  rimosse: { one: "{n} line removed", other: "{n} lines removed" },
  nuovoFile: "new file",
  modificheA: "Changes to {percorso}",
  righeUguali: { one: "… {n} unchanged line", other: "… {n} unchanged lines" },
  aggiunta: "added: ",
  rimossa: "removed: ",
  troncato: "… diff truncated ({count} lines not shown)",
  binario: "@@ binary file",
} satisfies Record<string, string | Record<string, string>>;
