// Come gli agenti chiamano la persona che usa AgiCloud: il nome da AGICLOUD_USER_NAME (la piattaforma lo prende
// dall'account), altrimenti "l'utente". Le forme con preposizione evitano frasi come "a l'utente".
import { config } from './config.js';

export const user = {
  /** Soggetto o complemento: "l'utente" / "l'utente" */
  get name(): string {
    return config.userName || "l'utente";
  },
  /** Inizio di frase: "l'utente" / "L'utente" */
  get Name(): string {
    return config.userName || "L'utente";
  },
  /** "a l'utente" / "all'utente" */
  get a(): string {
    return config.userName ? `a ${config.userName}` : "all'utente";
  },
  /** "di l'utente" / "dell'utente" */
  get di(): string {
    return config.userName ? `di ${config.userName}` : "dell'utente";
  },
};
