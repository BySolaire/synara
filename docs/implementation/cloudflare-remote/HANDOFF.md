# Remote connections — punto di ripartenza

Aggiornato il 30 settembre 2026. Questo è il riepilogo corrente tra desktop e iOS; i documenti precedenti contengono anche stati storici ormai superati. La UI è in pausa per decisione dell'utente: non continuare il ridisegno dei chip.

## Dove si trova il lavoro e cosa è pubblicato

| Superficie | Repository / branch | Stato verificato prima di questo recap |
| --- | --- | --- |
| Desktop, API e trasporto | `Emanuele-web04/synara`, `codex/cloudflare-remote-mvp` | HEAD locale e branch remota entrambi a `b5f8837adb3a8c938d3f16e2d4882aa1b8a1c7ce`; nessuna PR trovata per questa head |
| iPhone | `Emanuele-web04/SynaraIOS`, `codex/ios-remote-connections` | [PR #1](https://github.com/Emanuele-web04/SynaraIOS/pull/1), aperta, codice pubblicato fino a `4b855e68faadb99396452899d53af1f9d0ced3b3`; worktree pulita |

Questo recap viene pubblicato con un commit di sola documentazione dopo quei checkpoint. La sua pubblicazione **non include né certifica** le modifiche desktop non committate descritte sotto. La branch desktop pubblicata è consultabile [qui](https://github.com/Emanuele-web04/synara/tree/codex/cloudflare-remote-mvp).

Il worktree desktop è `.codex/worktrees/a816/synara`; quello iOS è `Developer/SynaraIOS-remote-connections` sul Mac Mini. Il [recap iOS](https://github.com/Emanuele-web04/SynaraIOS/blob/codex/ios-remote-connections/Docs/REMOTE-CONNECTIONS-HANDOFF.md) documenta il lato telefono. Non usare la repo beta-diagnostics per riprendere questa attività.

## Attenzione: lavoro desktop ancora locale

Alla lettura iniziale di questa sessione Git riportava **119 percorsi modificati**, tutti non staged: 36 D, 83 M. Diff complessivo: **1.941 righe aggiunte, 6.392 rimosse**. È un delta successivo al checkpoint pubblicato, non un riepilogo dell'intera feature.

Le aree coinvolte sono:

- API e identità: configurazione, issuer/grant, revoche e route di autorizzazione.
- Rimozione del runtime relay ritirato: `apps/relay`, `packages/relay-protocol`, dialer e harness precedenti; aggiornamenti dei manifest e del lockfile.
- Runtime remoto: supervisor/registry, session gateway, tunnel e risorse, strumenti MCP remoti.
- Web: sidebar unificata, Activity, ricerca, creazione progetto, menu/azioni dei thread e stato delle connessioni.
- Contratti, test e documentazione collegati.

Queste modifiche sono preservate nel worktree. Non sono state aggiunte automaticamente al commit di questo recap: non è stata ricostruita una prova di validazione del loro insieme esatto. I test storici della branch non dimostrano che questo delta passi oggi. Prima di pubblicarlo, rivedere il diff, verificare che appartenga tutto all'attività, eseguire i controlli pertinenti e creare commit coerenti. Non usare `reset --hard`, `clean` o uno stage indiscriminato per semplificare il lavoro.

Git emette inoltre avvisi `non-monotonic index` per file AppleDouble `._pack-*.idx` nel Git common directory sul volume esterno. Le letture di HEAD e la verifica remota sono riuscite. Nessuna riparazione o cancellazione degli oggetti Git è stata eseguita; se gli avvisi bloccano operazioni successive, trattarli come problema del repository, non dell'app.

## Logica scelta e invarianti

L'app mantiene più computer collegati nello stesso workspace. Progetti e chat conservano l'identità del computer proprietario; aprire una chat o filtrare una sidebar cambia la vista, non sposta l'esecuzione. La creazione di una chat/progetto cattura esplicitamente computer e progetto di destinazione. Identificativi uguali su due host non devono collidere.

Il percorso gestito usa Cloudflare Tunnel per raggiungere il computer, con autenticazione del dispositivo e identità del computer verificata dal protocollo remoto. Il codice di pairing serve a iniziare l'abbinamento; non sostituisce l'approvazione dell'identità. Trust, sessione e riconnessione sono per host. La disconnessione di uno non deve interrompere gli altri.

L'API account gestisce identità/directory/autorizzazione; non esegue i task al posto dei Mac. I provider e i file restano sul computer scelto. La configurazione concordata è API/profili su Cloudflare e PostgreSQL su Supabase. Per questo trial l'infrastruttura è già configurata: non occorre ricrearla per riprendere le prove. Segreti, token e chiavi restano fuori dalla repo.

Gli strumenti interni Synara MCP hanno instradamento remoto tramite un `environmentId` esplicito e la connessione già approvata. Il default locale e i controlli di autorizzazione rimangono distinti dai grant delle integrazioni MCP esterne. Cloudflare e SSH sono percorsi differenti: provare l'uno non certifica l'altro. Le regole server Beta/Stable rimangono autorevoli; non disattivarle per far riuscire un test.

## Cosa è stato effettivamente verificato

| Evidenza | Risultato e limite |
| --- | --- |
| Desktop MacBook ↔ Mini | Collegamento in entrambe le direzioni sulle istanze isolate di test, con navigazione e letture remote. Non equivale a verificare le app distribuite su ogni sistema operativo. |
| Recovery desktop | Nella cronologia di [STATUS.md](STATUS.md) sono registrate correzioni e prove di ripresa dopo restart/crash del connector. I primi test usavano un override DNS limitato al processo; non generalizzare quelle prove alla risoluzione di rete ordinaria. |
| MCP remoto | Il checkpoint `ac27fd7` implementa il routing; `b5f8837` registra la validazione. Listing/lettura reali sul bridge MacBook → Mini; mutazioni coperte anche da fixture con provider deterministico. Una negoziazione 503 poi riuscita è registrata, non mascherata come reconnect perfetto. |
| iOS → entrambi i Mac | Simulatore iPhone 18 Pro/iOS 27, pairing separato e approvato, entrambi i computer collegati attraverso le route Cloudflare gestite. |
| Chat reali da iOS | Creazione e risposte di provider reali su entrambi: `REMOTE IOS OK` e `MACBOOK IOS OK`. Snapshot dei server hanno confermato che ogni chat era sul proprio host. |
| Isolamento e riavvio iOS | Disconnettendo un host, l'altro ha continuato a rispondere. Dopo terminazione/rilancio dell'app entrambi hanno recuperato trust, connessioni e cronologia senza nuovo OTP. |
| Sidebar iOS | All e filtri per computer, ricerca, apertura del transcript corretto e destinazione dei nuovi task separata dai filtri. Screenshot e test sono nella PR iOS. |

Le risposte delle prove sono messaggi sintetici senza uso di tool o modifica dei file dell'utente. Non presentare le prove del simulatore come prove su un iPhone fisico. I record dettagliati e i limiti delle suite storiche sono in [STATUS.md](STATUS.md), [QUALIFICATION.md](QUALIFICATION.md) e nel recap iOS; nessuna suite desktop è stata rieseguita per questo commit di sola documentazione.

## Cosa manca davvero

Non è stato identificato un blocco fondamentale assente nel percorso normale pairing → connessione → chat. Restano qualificazione e possibili correzioni dei casi limite, oltre alla pubblicazione ordinata del delta desktop locale:

1. Due task realmente in streaming, uno su ciascun Mac; Stop, richiesta di approvazione e input devono restare sull'host corretto anche cambiando chat e durante reconnect.
2. Revoca durante una sessione reale e nuovo tentativo di accesso; i test di sicurezza isolati esistono, ma non sostituiscono questa prova finale.
3. Riavvio del server, sleep/wake, indisponibilità dell'API e rinnovo delle credenziali durante una prova prolungata con durata e misure dichiarate.
4. iPhone fisico: Wi-Fi/cellulare, lock/unlock, background/foreground e recupero. Non promettere socket continuamente attivi in background su iOS.
5. Allegati consumati da un provider reale e percorso microfono/trascrizione.
6. SSH nativo, Windows/Linux e pacchetti firmati/distribuiti non sono qualificati da queste prove Mac/Cloudflare. Nessuna prova di capacità con molti host autorizza a promettere connessioni illimitate.
7. Prima di un rollout commerciale: il trial usa enrollment esplicito, non una verifica completa dell'abbonamento.

## Sequenza per ripartire

1. Leggere questo file e il recap iOS, poi aggiornare HEAD, stato Git e stato remoto. Preservare i 119 percorsi locali finché non sono stati revisionati.
2. Chiudere il delta desktop: separare rimozione relay, runtime/MCP e presentazione dove opportuno. UI aggiuntiva in pausa; nessun altro ridisegno richiesto.
3. Seguire AGENTS: Node/Bun da `.mise.toml`; `bun run fmt:check`, `bun run lint`, `bun run typecheck`, test Vitest pertinenti tramite `bun run test`. Le modifiche attuali attraversano più package/lifecycle: serve anche la suite più ampia. Eseguire `bun run windows-runtime:check` se si toccano confini process/platform e `bun run migrations:check` se si cambiano migrazioni. Non usare database di produzione per i test.
4. Committare e pushare solo dopo aver registrato risultati e limiti del delta esatto. Al momento del controllo iniziale questa branch non aveva una PR: crearla quando il contenuto da revisionare è pronto, senza confonderla con la PR iOS #1.
5. Riallineare i due runtime isolati a commit noti, conservando le rispettive home e pairing. Verificare porte IPv4/IPv6 prima di avviarli; dry-run del dev runner prima del launch. Le ultime home di prova erano `/private/tmp/synara-remote-mini` (porta 4775) e `/private/tmp/synara-remote-macbook-20260929` (4776 sul MacBook); sono riferimenti storici, non una garanzia che i processi siano ancora in esecuzione.
6. Eseguire i casi 1–3 sopra dal simulatore, poi passare al telefono fisico. Registrare commit di ogni runtime/client, passaggi, esito, artefatti e durata. Nuova identità di dispositivo richiede la sua specifica approvazione; non copiare chiavi tra dispositivi.
7. Correggere difetti concreti emersi; niente riscritture preventive o nuovi strati di trasporto se non necessari. Aggiornare entrambi i recap dopo ciascuna prova significativa.

## Mappa del codice e riferimenti

- `apps/api/src`: configurazione account, identità e route di autorizzazione.
- `apps/server/src/hostConnections`: connessioni e lifecycle del controller.
- `apps/server/src/remoteSessions` e `remoteTransport`: sessioni, gateway, trasporto e risorse.
- `apps/server/src/agentGateway/remoteTools.ts`: strumenti agent/MCP verso altri computer.
- `apps/web/src/lib/hosts` e componenti Sidebar/Activity/Search/CreateProject: proiezione e navigazione multi-host.
- `packages/contracts`: contratti condivisi; non introdurre orchestrazione runtime qui.
- [Piano originale](PLAN.md), [configurazione trial](READINESS.md), [operazioni](../../cloudflare-remote.md), [ADR 0016](../../adr/0016-managed-cloudflare-remote.md).

La richiesta corrente è un recap e verifica del push: nessun merge, rilascio, cambiamento infrastrutturale o nuova prova distruttiva è incluso in questo checkpoint.
