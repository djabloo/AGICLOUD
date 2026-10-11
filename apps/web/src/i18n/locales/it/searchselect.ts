import type { Message } from '../../index';

export default {
  cerca: 'Cerca…',
  cercaIn: 'Cerca in {label}',
  risultatiPer: 'Risultati per {label}',
  nessunRisultato: 'Nessun risultato',
  altri: "Altri {n}: scrivi qualcosa in piu'",
  contaRisultati: { one: '{n} risultato', other: '{n} risultati' },
} satisfies Record<string, Message>;
