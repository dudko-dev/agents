import type { AgentLabels } from '@dudko.dev/agent-web-react'

/** Spanish and German have two forms: 1 paso / 2 pasos, 1 Schritt / 2 Schritte. */
const form = (n: number, one: string, other: string): string => (n === 1 ? one : other)
const count = (n: number, one: string, other: string): string => `${n} ${form(n, one, other)}`

/** "1.5k" with the decimal comma both languages write. */
const kTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace('.', ',')}k` : `${n}`

const bytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1).replace('.', ',')} KB`
      : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`

/** The scope of a compaction, as the core names it (`history`, `trace`, `tool-results`). */
const scopeName = (names: Record<string, string>, scope: string): string => names[scope] ?? scope

/**
 * Every label of the chat, in Spanish — what `labels` (or `<AgentLabelsProvider>`) is for.
 * Typed as the whole `AgentLabels`, so a label the library adds later fails the typecheck here
 * until it is translated. Counted phrases are functions, so plurals come out right.
 */
export const ES_LABELS: AgentLabels = {
  emptyState: 'Pida algo al agente.',
  status: {
    idle: 'Inactivo',
    initializing: 'Cargando modelo…',
    ready: 'Listo',
    running: 'Trabajando…',
    error: 'Error al iniciar',
  },
  history: 'Chats',
  newChat: 'Nuevo chat',
  files: 'Archivos',
  totalUsage: 'Tokens usados en esta conversación, por tipo',
  showHistory: 'Mostrar chats',
  showFiles: 'Mostrar archivos',
  close: 'Cerrar',

  steps: (n) => count(n, 'paso', 'pasos'),
  toolCalls: (n) => count(n, 'llamada a herramientas', 'llamadas a herramientas'),
  subagents: (n) => count(n, 'subagente', 'subagentes'),
  skillsUsed: (names) => `habilidades: ${names}`,
  learnedNow: (names) => `aprendido: ${names}`,
  fetches: (n) => count(n, 'solicitud web', 'solicitudes web'),
  fetchRefused: (reason) => `rechazada: ${reason}`,
  answerThoughts: 'Razonamiento sobre la respuesta',
  stepThoughts: 'Razonamiento',
  usageTitle: 'Tokens gastados en esta respuesta, por tipo',
  attachments: 'Adjuntos',
  planned: 'Plan',
  replanned: (mode, reason) => `Plan modificado (${mode}): ${reason}`,

  notebookTitle: 'Cuaderno',
  notebookEmpty: 'El agente aún no ha anotado ninguna lección.',
  notebookForget: 'Olvidar',
  notebookRevision: (n) => `revisión ${n}`,
  notebookFrom: 'fuentes:',

  placeholder: 'Pida algo al agente…  ( / para comandos, Ctrl+V para pegar una imagen )',
  listening: 'Escuchando…',
  message: 'Mensaje',
  dropHint: 'Suelte archivos o imágenes para adjuntarlos',
  attach: 'Adjuntar archivos',
  attachTitle: 'Adjuntar archivos o imágenes (o pegar con Ctrl+V, o soltarlos aquí)',
  commands: 'Comandos',
  commandsTitle: 'Comandos y habilidades ( / )',
  send: 'Enviar',
  stop: 'Detener',
  dismiss: 'Ocultar',
  remove: (name) => `Quitar ${name}`,
  dictate: 'Dictar (voz a texto)',
  dictateTitle: 'Dictar: voz a texto en el navegador',
  stopDictation: 'Detener el dictado',
  microphone: 'Micrófono',
  model: 'Modelo',
  thinking: 'Razonamiento',
  toolConsent: 'Consentimiento para herramientas',
  modes: {
    autopilot: {
      label: 'Auto',
      hint: 'Piloto automático: ejecutar todas las herramientas sin preguntar',
    },
    'ask-writes': {
      label: 'Preguntar',
      hint: 'Las herramientas de solo lectura se ejecutan libremente; preguntar antes de cualquier cambio',
    },
    'ask-all': {
      label: 'Preguntar todo',
      hint: 'Preguntar antes de cada llamada a una herramienta',
    },
    'read-only': {
      label: 'Solo lectura',
      hint: 'Solo herramientas de lectura; los cambios se rechazan sin preguntar',
    },
  },
  timerRunning: 'Duración de esta ejecución hasta ahora',
  timerLast: 'La última ejecución tardó',
  agents: (n) => count(n, 'agente', 'agentes'),
  agentsTitle: 'Subagentes activos en esta ejecución',
  notices: {
    limit: (kind, used, cap) => {
      const calls = kind === 'tool-calls'
      const what = calls
        ? 'de llamadas a herramientas'
        : ({
            input: 'de tokens de entrada',
            output: 'de tokens de salida',
            reasoning: 'de tokens de razonamiento',
            total: 'total de tokens',
          }[kind] ?? `de tokens (${kind})`)
      const amount = calls ? `${used}/${cap} llamadas` : `${kTokens(used)}/${kTokens(cap)} tokens`
      return `Límite ${what} alcanzado · ${amount}: el agente se detuvo antes y respondió con lo que tenía`
    },
    compacted: (scope, before, after) =>
      `Contexto compactado (${scopeName(
        {
          history: 'historial',
          trace: 'registro de pasos',
          'tool-results': 'resultados de herramientas',
        },
        scope,
      )}) · ${kTokens(before)} → ${kTokens(after)} tokens`,
  },
  attachmentsOnly: '(adjuntos)',
  seeAttachments: 'Ver los adjuntos.',
  tooLarge: (name, mb) => `${name} supera los ${mb} MB.`,
  binaryText: (name) => `${name} parece binario: no se puede adjuntar como texto.`,
  commandGroups: { commands: 'Comandos', consent: 'Consentimiento', skills: 'Habilidades' },
  commandDescriptions: {
    compact: 'Resumir la conversación para liberar contexto',
    new: 'Iniciar una conversación nueva',
    stop: 'Detener la ejecución actual',
    autopilot: 'Ejecutar todas las herramientas sin preguntar',
    ask: 'Preguntar antes de las herramientas que pueden cambiar algo',
    askAll: 'Preguntar antes de cada llamada a una herramienta',
    readOnly: 'Solo lectura; rechazar los cambios',
    think: (levels) => `Nivel de razonamiento: ${levels}`,
  },
  thinkingLevels: {
    off: 'Predeterminado',
    none: 'Sin razonamiento',
    low: 'Bajo',
    medium: 'Medio',
    high: 'Alto',
  },

  filesEmpty:
    'Aún no hay archivos. Aquí aparecen los adjuntos y los archivos que escribe el agente.',
  upload: 'Subir',
  download: 'Descargar',
  delete: 'Eliminar',
  preview: 'Vista previa',
  bytes,

  historyEmpty: 'Aún no hay chats guardados.',
  deleteChat: 'Eliminar chat',
  messagesCount: (n) => count(n, 'mensaje', 'mensajes'),

  approvalLead: 'El agente quiere ejecutar',
  approve: 'Permitir una vez',
  alwaysAllow: 'Permitir siempre',
  deny: 'Denegar',
  declinedReason: 'el usuario lo rechazó',
  readOnlyTool: 'solo lectura',
  consentWaiting: 'esperando su consentimiento',
  consentAllowed: 'permitido',
  consentDenied: (reason) => `denegado${reason ? ` — ${reason}` : ''}`,

  placeholderBusy: 'Escriba algo al agente mientras trabaja…',
  steer: 'Enviar al agente',
  noAttachmentsWhileBusy:
    'No se pueden añadir archivos mientras el agente trabaja: envíelos con el siguiente mensaje.',
  queuedWaiting: 'esperando el siguiente paso del agente',
  noteAt: {
    round: 'su mensaje, entre llamadas a herramientas',
    step: 'su mensaje, después de este paso',
    final: 'su mensaje, antes de la respuesta',
  },
  undelivered: (n) => `Sin entregar (${count(n, 'mensaje', 'mensajes')})`,
  sendUndelivered: 'Enviar ahora',
  discardUndelivered: 'Descartar',
  stopSubagent: 'Detener este subagente',
  subagentStopped: 'detenido',

  failed: 'error',
  toolCostTitle:
    'Tokens estimados de los argumentos y del resultado devuelto al modelo (caracteres / 4), y duración de la llamada',

  tierNames: { light: 'ligero', standard: 'estándar', strong: 'potente' },
  tierReasons: {
    planned: 'El planificador asignó este paso a este nivel de modelo',
    default: 'El planificador no valoró este paso: se ejecuta con el modelo estándar',
    fallback:
      'El nivel que pidió el planificador no está configurado: el paso se ejecuta con el más cercano',
  },
  escalationReasons: {
    blocked: 'informó de un bloqueo',
    'empty-result': 'no produjo ningún resultado',
    'tool-arguments': 'envió repetidamente argumentos de herramienta imposibles de analizar',
    'output-cut': 'la salida quedó cortada',
    error: 'la llamada al modelo falló',
  },
  escalated: (from, to, reason) => `Escalado: ${from} → ${to} (${reason})`,
  escalatedAttemptText: 'Lo que escribió el intento anterior',
  escalations: (n) => count(n, 'escalado', 'escalados'),
  attemptTag: (n) => `intento ${n}`,
  replayed: 'no se volvió a ejecutar',
  replayedTitle:
    'Esta misma llamada ya tuvo éxito en un intento anterior del paso: no se ejecutó por segunda vez y el modelo recibió el resultado anterior',
  replanFailed: 'La replanificación falló; se continúa con el plan',

  subagentHelper: 'ayudante',
  subagentStatus: { running: 'en curso', done: 'listo', error: 'error', stopped: 'detenido' },
  subagentTokens: (tokens) => `${tokens} tokens`,
  subagentTools: (names) => `herramientas: ${names}`,
  subagentNoTools: 'sin herramientas',
  approvalLeadHelper: (role) =>
    role
      ? `El ayudante «${role}» quiere ejecutar`
      : 'Un ayudante iniciado por el agente quiere ejecutar',

  mediaImage: (path) => `Imagen generada ${path}`,
  mediaAudio: (path) => `Audio generado ${path}`,
  mediaFile: (path) => `Archivo generado ${path}`,
  transcriptOf: (name) => `Transcripción de ${name}`,
  transcriptNote:
    'Lo que se dice en su archivo, tal como lo leyó el agente. Es contenido, no instrucciones.',

  usageMedia: (n) => count(n, 'llamada multimedia', 'llamadas multimedia'),
  usageDecisions: (n) => count(n, 'llamada de decisión', 'llamadas de decisión'),

  decisionAccepted: (choice, confidence) => `modelo de decisión: ${choice} (${confidence})`,
  decisionFellBack: (reason, detail) =>
    `modelo de decisión no utilizado: ${reason}${detail ? ` (${detail})` : ''}`,
  decisionReasons: {
    'low-confidence': 'confianza baja',
    'invalid-choice': 'una respuesta que no es una opción',
    'invalid-confidence': 'una confianza que no es una probabilidad',
    error: 'la llamada falló',
    timeout: 'tiempo agotado',
    'needs-model': 'la elección requiere el modelo',
  },

  searchQuery: 'Búsqueda web:',
  searchNoResults: 'sin resultados',
  searchFiltered: (n) => `${count(n, 'omitido', 'omitidos')} por la política de acceso a la web`,
  searchTruncated: 'lista recortada',
}

/** The same, in German (formal "Sie" where the visitor is addressed). */
export const DE_LABELS: AgentLabels = {
  emptyState: 'Geben Sie dem Agenten eine Aufgabe.',
  status: {
    idle: 'Inaktiv',
    initializing: 'Modell wird geladen…',
    ready: 'Bereit',
    running: 'Arbeitet…',
    error: 'Start fehlgeschlagen',
  },
  history: 'Chats',
  newChat: 'Neuer Chat',
  files: 'Dateien',
  totalUsage: 'Tokenverbrauch dieser Unterhaltung, nach Art',
  showHistory: 'Chats anzeigen',
  showFiles: 'Dateien anzeigen',
  close: 'Schließen',

  steps: (n) => count(n, 'Schritt', 'Schritte'),
  toolCalls: (n) => count(n, 'Tool-Aufruf', 'Tool-Aufrufe'),
  subagents: (n) => count(n, 'Subagent', 'Subagenten'),
  skillsUsed: (names) => `Skills: ${names}`,
  learnedNow: (names) => `gelernt: ${names}`,
  fetches: (n) => count(n, 'Webanfrage', 'Webanfragen'),
  fetchRefused: (reason) => `abgelehnt: ${reason}`,
  answerThoughts: 'Überlegungen zur Antwort',
  stepThoughts: 'Überlegungen',
  usageTitle: 'Tokenverbrauch dieser Antwort, nach Art',
  attachments: 'Anhänge',
  planned: 'Plan',
  replanned: (mode, reason) => `Neu geplant (${mode}): ${reason}`,

  notebookTitle: 'Notizbuch',
  notebookEmpty: 'Der Agent hat noch keine Lektionen notiert.',
  notebookForget: 'Vergessen',
  notebookRevision: (n) => `Version ${n}`,
  notebookFrom: 'Quellen:',

  placeholder:
    'Geben Sie dem Agenten eine Aufgabe…  ( / für Befehle, Strg+V zum Einfügen eines Bildes )',
  listening: 'Aufnahme läuft…',
  message: 'Nachricht',
  dropHint: 'Dateien oder Bilder hier ablegen, um sie anzuhängen',
  attach: 'Dateien anhängen',
  attachTitle: 'Dateien oder Bilder anhängen (oder mit Strg+V einfügen oder hier ablegen)',
  commands: 'Befehle',
  commandsTitle: 'Befehle und Skills ( / )',
  send: 'Senden',
  stop: 'Stoppen',
  dismiss: 'Ausblenden',
  remove: (name) => `${name} entfernen`,
  dictate: 'Diktieren (Sprache zu Text)',
  dictateTitle: 'Diktieren – Spracherkennung im Browser',
  stopDictation: 'Diktat beenden',
  microphone: 'Mikrofon',
  model: 'Modell',
  thinking: 'Nachdenken',
  toolConsent: 'Tool-Freigabe',
  modes: {
    autopilot: { label: 'Auto', hint: 'Autopilot – alle Tools ohne Rückfrage ausführen' },
    'ask-writes': {
      label: 'Fragen',
      hint: 'Lesende Tools laufen ohne Rückfrage; vor allem, was etwas ändern kann, wird gefragt',
    },
    'ask-all': { label: 'Immer fragen', hint: 'Vor jedem Tool-Aufruf fragen' },
    'read-only': {
      label: 'Nur lesen',
      hint: 'Nur lesende Tools; Änderungen werden ohne Rückfrage abgelehnt',
    },
  },
  timerRunning: 'Bisherige Dauer dieses Laufs',
  timerLast: 'Der letzte Lauf dauerte',
  agents: (n) => count(n, 'Agent', 'Agenten'),
  agentsTitle: 'Aktive Subagenten in diesem Lauf',
  notices: {
    limit: (kind, used, cap) => {
      const calls = kind === 'tool-calls'
      const what = calls
        ? 'Tool-Aufrufe'
        : ({
            input: 'Eingabe-Tokens',
            output: 'Ausgabe-Tokens',
            reasoning: 'Denk-Tokens',
            total: 'Tokens insgesamt',
          }[kind] ?? `Tokens (${kind})`)
      const amount = calls ? `${used}/${cap} Aufrufe` : `${kTokens(used)}/${kTokens(cap)} Tokens`
      return `Limit für ${what} erreicht · ${amount} – der Agent hat vorzeitig gestoppt und mit dem bisherigen Stand geantwortet`
    },
    compacted: (scope, before, after) =>
      `Kontext komprimiert (${scopeName(
        { history: 'Verlauf', trace: 'Schrittprotokoll', 'tool-results': 'Tool-Ergebnisse' },
        scope,
      )}) · ${kTokens(before)} → ${kTokens(after)} Tokens`,
  },
  attachmentsOnly: '(Anhänge)',
  seeAttachments: 'Siehe Anhänge.',
  tooLarge: (name, mb) => `${name} ist größer als ${mb} MB.`,
  binaryText: (name) =>
    `${name} sieht nach einer Binärdatei aus – sie kann nicht als Text angehängt werden.`,
  commandGroups: { commands: 'Befehle', consent: 'Freigabe', skills: 'Skills' },
  commandDescriptions: {
    compact: 'Unterhaltung zusammenfassen, um Kontext freizugeben',
    new: 'Neue Unterhaltung beginnen',
    stop: 'Aktuellen Lauf stoppen',
    autopilot: 'Alle Tools ohne Rückfrage ausführen',
    ask: 'Vor Tools fragen, die etwas ändern können',
    askAll: 'Vor jedem Tool-Aufruf fragen',
    readOnly: 'Nur lesen; Änderungen ablehnen',
    think: (levels) => `Nachdenken einstellen: ${levels}`,
  },
  thinkingLevels: {
    off: 'Standard',
    none: 'Kein Nachdenken',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
  },

  filesEmpty: 'Noch keine Dateien. Anhänge und vom Agenten geschriebene Dateien erscheinen hier.',
  upload: 'Hochladen',
  download: 'Herunterladen',
  delete: 'Löschen',
  preview: 'Vorschau',
  bytes,

  historyEmpty: 'Noch keine gespeicherten Chats.',
  deleteChat: 'Chat löschen',
  messagesCount: (n) => count(n, 'Nachricht', 'Nachrichten'),

  approvalLead: 'Der Agent möchte ausführen:',
  approve: 'Einmal erlauben',
  alwaysAllow: 'Immer erlauben',
  deny: 'Ablehnen',
  declinedReason: 'vom Benutzer abgelehnt',
  readOnlyTool: 'nur lesend',
  consentWaiting: 'wartet auf Ihre Zustimmung',
  consentAllowed: 'erlaubt',
  consentDenied: (reason) => `abgelehnt${reason ? ` – ${reason}` : ''}`,

  placeholderBusy: 'Schreiben Sie dem Agenten, während er arbeitet…',
  steer: 'An den Agenten senden',
  noAttachmentsWhileBusy:
    'Während der Agent arbeitet, können keine Dateien hinzugefügt werden – senden Sie sie mit Ihrer nächsten Nachricht.',
  queuedWaiting: 'wartet auf den nächsten Schritt des Agenten',
  noteAt: {
    round: 'Ihre Nachricht, zwischen Tool-Aufrufen',
    step: 'Ihre Nachricht, nach diesem Schritt',
    final: 'Ihre Nachricht, vor der Antwort',
  },
  undelivered: (n) => `Nicht zugestellt (${count(n, 'Nachricht', 'Nachrichten')})`,
  sendUndelivered: 'Jetzt senden',
  discardUndelivered: 'Verwerfen',
  stopSubagent: 'Diesen Subagenten stoppen',
  subagentStopped: 'gestoppt',

  failed: 'fehlgeschlagen',
  toolCostTitle:
    'Geschätzte Tokens der Argumente und des an das Modell zurückgegebenen Ergebnisses (Zeichen / 4) sowie die Dauer des Aufrufs',

  tierNames: { light: 'leicht', standard: 'standard', strong: 'stark' },
  tierReasons: {
    planned: 'Der Planer hat diesen Schritt für diese Modellstufe eingestuft',
    default: 'Der Planer hat diesen Schritt nicht eingestuft: Er läuft auf dem Standardmodell',
    fallback:
      'Die vom Planer gewünschte Stufe ist nicht konfiguriert: Die nächstgelegene führt den Schritt aus',
  },
  escalationReasons: {
    blocked: 'meldete ein Hindernis',
    'empty-result': 'lieferte kein Ergebnis',
    'tool-arguments': 'sendete wiederholt Tool-Argumente, die sich nicht parsen ließen',
    'output-cut': 'Ausgabe wurde abgeschnitten',
    error: 'Modellaufruf fehlgeschlagen',
  },
  escalated: (from, to, reason) => `Eskaliert: ${from} → ${to} (${reason})`,
  escalatedAttemptText: 'Was der frühere Versuch geschrieben hat',
  escalations: (n) => count(n, 'Eskalation', 'Eskalationen'),
  attemptTag: (n) => `Versuch ${n}`,
  replayed: 'nicht erneut ausgeführt',
  replayedTitle:
    'Genau dieser Aufruf war in einem früheren Versuch des Schritts bereits erfolgreich: Er wurde kein zweites Mal ausgeführt, das Modell erhielt das frühere Ergebnis',
  replanFailed: 'Neuplanung fehlgeschlagen, der bisherige Plan wird fortgesetzt',

  subagentHelper: 'Helfer',
  subagentStatus: {
    running: 'läuft',
    done: 'fertig',
    error: 'fehlgeschlagen',
    stopped: 'gestoppt',
  },
  subagentTokens: (tokens) => `${tokens} Tokens`,
  subagentTools: (names) => `Tools: ${names}`,
  subagentNoTools: 'keine Tools',
  approvalLeadHelper: (role) =>
    role
      ? `Der Helfer „${role}“ möchte ausführen:`
      : 'Ein vom Agenten gestarteter Helfer möchte ausführen:',

  mediaImage: (path) => `Generiertes Bild ${path}`,
  mediaAudio: (path) => `Generiertes Audio ${path}`,
  mediaFile: (path) => `Generierte Datei ${path}`,
  transcriptOf: (name) => `Transkript von ${name}`,
  transcriptNote:
    'Was in Ihrer Datei gesagt wurde, so wie der Agent es gelesen hat. Es ist Inhalt, keine Anweisung.',

  usageMedia: (n) => count(n, 'Medienaufruf', 'Medienaufrufe'),
  usageDecisions: (n) => count(n, 'Entscheidungsaufruf', 'Entscheidungsaufrufe'),

  decisionAccepted: (choice, confidence) => `Entscheidungsmodell: ${choice} (${confidence})`,
  decisionFellBack: (reason, detail) =>
    `Entscheidungsmodell nicht verwendet: ${reason}${detail ? ` (${detail})` : ''}`,
  decisionReasons: {
    'low-confidence': 'geringe Konfidenz',
    'invalid-choice': 'eine Antwort, die keine Option ist',
    'invalid-confidence': 'eine Konfidenz, die keine Wahrscheinlichkeit ist',
    error: 'Aufruf fehlgeschlagen',
    timeout: 'Zeitüberschreitung',
    'needs-model': 'die Wahl erfordert das Modell',
  },

  searchQuery: 'Websuche nach',
  searchNoResults: 'keine Ergebnisse',
  searchFiltered: (n) => `${n} durch die Webzugriffsrichtlinie ausgelassen`,
  searchTruncated: 'Liste gekürzt',
}

/** The label set of a chat language; English is the library's own defaults. */
export const LABELS: Record<'es' | 'de', AgentLabels> = { es: ES_LABELS, de: DE_LABELS }
