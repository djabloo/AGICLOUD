export default {
  aggiunte: { one: '{n} riga aggiunta', other: '{n} righe aggiunte' },
  rimosse: { one: '{n} riga rimossa', other: '{n} righe rimosse' },
  nuovoFile: 'nuovo file',
  modificheA: 'Modifiche a {percorso}',
  righeUguali: { one: '… {n} riga uguale', other: '… {n} righe uguali' },
  aggiunta: 'aggiunta: ',
  rimossa: 'rimossa: ',
  troncato: '… diff troncato ({count} righe non mostrate)',
  binario: '@@ file binario',
} satisfies Record<string, string | { one: string; other: string }>;
