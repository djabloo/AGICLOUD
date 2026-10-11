export default {
  aggiunte: { one: "{n} Zeile hinzugefügt", other: "{n} Zeilen hinzugefügt" },
  rimosse: { one: "{n} Zeile entfernt", other: "{n} Zeilen entfernt" },
  nuovoFile: "neue Datei",
  modificheA: "Änderungen an {percorso}",
  righeUguali: { one: "… {n} unveränderte Zeile", other: "… {n} unveränderte Zeilen" },
  aggiunta: "hinzugefügt: ",
  rimossa: "entfernt: ",
  troncato: "… Diff gekürzt ({count} Zeilen nicht angezeigt)",
  binario: "@@ Binärdatei",
} satisfies Record<string, string | Record<string, string>>;
