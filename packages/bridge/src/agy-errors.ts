// Errori che agy recupera da solo durante il turno (es. "Malformed function call"
// riprovato automaticamente, o 503 transitorio): il `result` finale riporta comunque
// status ERROR per lo step d'errore rimasto in cronologia, ma se il messaggio e' gia'
// stato inviato e' un falso positivo e non va propagato come errore di turno.
//
// Modulo separato perche' agy-agent.ts ha effetti collaterali al load (si collega a stdio)
// e non si puo' importare dai test.

/** Vero se l'errore in `r.error` puo' essere ignorato quando il turno ha gia' prodotto testo */
export function agyErroreRecuperato(err: string | undefined): boolean {
  if (typeof err !== 'string') return false;
  return /UNAVAILABLE \(code 503\)/.test(err) || /Malformed function call/i.test(err) || /improperly formatted function call/i.test(err) || /Retries remaining:/.test(err);
}
