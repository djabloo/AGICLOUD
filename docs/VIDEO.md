# Foto, video e presentazioni: strumenti per gli agenti

Ogni ambiente AgiCloud ha gli stessi strumenti da shell, così Claude, OpenCode, Cursor e agy possono montare e modificare materiale senza installare nulla:

| Strumento | A cosa serve |
|---|---|
| `ffmpeg`, `ffprobe` | Conversioni, tagli, unione di clip, audio (mixaggio di voci), sottotitoli, ridimensionamenti. |
| Python con `moviepy` e `pillow` (`/opt/video-tools`, già nel `PATH`) | Montaggio da codice: diapositive con dissolvenze, titoli, sovrapposizioni, audio sincronizzato; ritocco di immagini. |
| Caratteri DejaVu e Liberation | Testo nei fotogrammi e nelle diapositive. |

MoviePy scrive un file audio temporaneo nella cartella corrente: lavorando in una cartella di progetto va bene, altrimenti si passa `temp_audiofile_path=` a `write_videofile` (vedi l'esempio). I file di lavoro temporanei vanno in `$TMPDIR` (`/data/tmp`, sul volume dell'utente): la memoria `/tmp` è piccola.

## Esempio completo
`python3 scripts/video-check.py` crea tre diapositive, un dialogo a due voci (due toni, al posto delle voci vere) e le monta in un mp4, poi lo controlla con `ffprobe`. Per un lavoro vero si sostituiscono le immagini e le voci con quelle prodotte da agy (immagini, dialoghi a due voci, presentazioni) e si lascia il resto.

## Come si divide il lavoro
- **agy**: crea e modifica immagini, scrive e legge dialoghi a due voci, prepara presentazioni e diapositive.
- **Claude** (o un altro agente): monta tutto con `ffmpeg` o `moviepy`: ordine delle scene, durata, dissolvenze, musica, sottotitoli.
- **Browser condiviso**: per guardare il risultato o usare un sito dal vivo insieme all'agente.

## Limiti da tenere presenti
- Il montaggio usa CPU: nei piani con poca CPU i video lunghi richiedono tempo. Meglio 720p e clip brevi per le prove.
- Lo spazio è quello del piano: i video pesano, e gli ambienti sopra il limite si fermano.
