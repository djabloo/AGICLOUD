export default {
  aggiunte: { one: "Добавлена {n} строка", few: "Добавлено {n} строки", many: "Добавлено {n} строк", other: "Добавлено {n} строки" },
  rimosse: { one: "Удалена {n} строка", few: "Удалено {n} строки", many: "Удалено {n} строк", other: "Удалено {n} строки" },
  nuovoFile: "новый файл",
  modificheA: "Изменения в {percorso}",
  righeUguali: { one: "… {n} неизменённая строка", few: "… {n} неизменённые строки", many: "… {n} неизменённых строк", other: "… {n} неизменённой строки" },
  aggiunta: "добавлено: ",
  rimossa: "удалено: ",
  troncato: "… diff усечён (не показано строк: {count})",
  binario: "@@ двоичный файл",
} satisfies Record<string, string | Record<string, string>>;
