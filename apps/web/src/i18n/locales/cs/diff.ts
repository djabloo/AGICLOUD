export default {
  aggiunte: { one: "{n} řádek přidán", few: "{n} řádky přidány", many: "{n} řádku přidáno", other: "{n} řádků přidáno" },
  rimosse: { one: "{n} řádek odstraněn", few: "{n} řádky odstraněny", many: "{n} řádku odstraněno", other: "{n} řádků odstraněno" },
  nuovoFile: "nový soubor",
  modificheA: "Změny v souboru {percorso}",
  righeUguali: { one: "… {n} nezměněný řádek", few: "… {n} nezměněné řádky", many: "… {n} nezměněného řádku", other: "… {n} nezměněných řádků" },
  aggiunta: "přidáno: ",
  rimossa: "odstraněno: ",
  troncato: "… rozdíl zkrácen (nezobrazeno řádků: {count})",
  binario: "@@ binární soubor",
} satisfies Record<string, string | Record<string, string>>;
