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

  elicitationTitle: 'Una pregunta de un servidor MCP',
  elicitationLead: (server) => `El servidor MCP «${server}» le pide datos`,
  elicitationLeadHelper: (server, role) =>
    role
      ? `El servidor MCP «${server}» le pide datos (una llamada del ayudante «${role}»)`
      : `El servidor MCP «${server}» le pide datos (una llamada de un ayudante)`,
  elicitationDuring: 'durante',
  elicitationCount: (index, total) => `${index} de ${total}`,
  elicitationFrom: (server) => `Del servidor «${server}»`,
  elicitationRequired: 'obligatorio',
  elicitationChoose: 'Elija…',
  elicitationSubmit: 'Enviar',
  elicitationDecline: 'Rechazar',
  elicitationCancel: 'Cancelar',
  elicitationErrors: {
    required: (field) => `${field} es obligatorio.`,
    tooShort: (field, limit) => `${field} debe tener al menos ${limit} caracteres.`,
    tooLong: (field, limit) => `${field} debe tener como máximo ${limit} caracteres.`,
    email: (field) => `${field} debe ser una dirección de correo.`,
    uri: (field) => `${field} debe ser una dirección completa, como https://example.com.`,
    date: (field) => `${field} debe ser una fecha.`,
    dateTime: (field) => `${field} debe ser una fecha y una hora.`,
    notNumber: (field) => `${field} debe ser un número.`,
    notInteger: (field) => `${field} debe ser un número entero.`,
    belowMinimum: (field, limit) => `${field} debe ser ${limit} o más.`,
    aboveMaximum: (field, limit) => `${field} debe ser ${limit} o menos.`,
    notAnOption: (field) => `${field} debe ser una de las opciones.`,
    tooFew: (field, limit) => `${field}: elija al menos ${limit}.`,
    tooMany: (field, limit) => `${field}: elija como máximo ${limit}.`,
  },
  elicitationFix: (n) => `${count(n, 'campo necesita', 'campos necesitan')} una corrección.`,
  elicitationUrlLead: (server) => `El servidor MCP «${server}» le pide abrir una página en`,
  elicitationUrlFull: 'Dirección completa',
  elicitationOpen: 'Abrir en una pestaña nueva',
  elicitationOpened: 'Abierta en una pestaña nueva. Termine allí y confirme aquí.',
  elicitationUrlDone: 'He terminado allí',
  elicitationUrlRefused:
    'Este enlace no es una dirección segura (https), así que no se abre desde aquí.',
  elicitationExpiresIn: (time) => `Se cancela automáticamente en ${time}`,
  elicitationExpires: 'Se cancela automáticamente si queda sin respuesta',
  elicitationAutomatic: (server, reason) =>
    `Una pregunta del servidor MCP «${server}» se respondió automáticamente y su llamada a la herramienta no terminó: ${reason}.`,
  elicitationReasons: {
    timeout: 'nadie respondió a tiempo',
    'step-timeout': 'el paso agotó su tiempo mientras la pregunta esperaba',
    aborted: 'la ejecución se detuvo',
    stopped: 'la ejecución se detuvo',
    'cap-per-call': 'la llamada ya había hecho demasiadas preguntas',
    'cap-per-run': 'ya se habían hecho demasiadas preguntas en esta ejecución',
    'unsupported-schema': 'el formulario que envió no se puede mostrar',
    'unsupported-mode': 'preguntó de una forma que esta aplicación no ofrece',
    'insecure-url': 'el enlace que envió fue rechazado',
    'invalid-request': 'su solicitud estaba mal formada',
    subagent: 'un ayudante no puede preguntarle',
    'handler-error': 'la pregunta no se pudo mostrar',
    'invalid-answer': 'la respuesta no se ajustaba al formulario y no se envió',
    'after-failure': 'una pregunta anterior de la misma llamada ya había fallado',
    'no-tool-call': 'no había ninguna llamada en curso',
  },
  elicitationDismiss: 'Descartar',
  filesWritten: (n) => `${count(n, 'archivo escrito', 'archivos escritos')} en este turno`,
  filesCount: (n) => count(n, 'archivo', 'archivos'),
  showInFiles: 'Mostrar en Archivos',
  fileKinds: {
    html: 'HTML',
    markdown: 'Markdown',
    csv: 'CSV',
    json: 'JSON',
    image: 'Imagen',
    code: 'Código',
    text: 'Texto',
    file: 'Archivo',
  },
  fileOpen: (name) => `Abrir ${name}`,
  fileClose: (name) => `Cerrar la vista previa de ${name}`,
  fileDownload: (name) => `Descargar ${name}`,
  fileBy: (name) => `de ${name}`,
  fileGone: 'ya no está en el espacio de trabajo',
  fileNoPreview: 'Este tipo de archivo no tiene vista previa. Descárguelo para abrirlo.',
  fileCut: (chars) =>
    `Solo se muestran los primeros ${chars.toLocaleString('es-ES')} caracteres. El resto está en el archivo descargado.`,
  fileShowRest: 'Mostrar el resto',
  fileShowLess: 'Mostrar menos',
  fileRendered: 'Vista',
  fileSource: 'Código fuente',
  closePreview: 'Cerrar la vista previa',
  fileLines: (n) => count(n, 'línea', 'líneas'),
  htmlFrameTitle: 'HTML escrito por el agente',
  htmlSandboxed: 'aislado',
  htmlNoNetwork: 'sin red',
  htmlSourceNote: 'mostrado como texto, no se ejecuta nada',
  htmlScripts: (on) => (on ? 'scripts activados' : 'scripts desactivados'),
  htmlLinkedFiles: (names) => `los archivos enlazados no se cargan: ${names}`,
  htmlTooLarge: 'La página es demasiado grande para la vista previa. Se muestra el código fuente.',
  htmlTaller: 'Hacer la vista previa más alta',
  htmlShorter: 'Hacer la vista previa más baja',
  htmlFrameName: (path) => `Vista previa de ${path}`,

  appFrom: (server) => `App del servidor «${server}»`,
  appSandboxed: 'aislada',
  appSandboxedOrigin: 'aislada en su propio origen',
  appSandboxOrigin: (origin) =>
    `Se ejecuta en su propio origen, ${origin}: su almacenamiento es suyo, nunca el de esta página.`,
  appSandboxFallback: (reason) =>
    `Sin origen propio (${reason}): se ejecuta en un entorno aislado opaco, sin almacenamiento propio.`,
  appSandboxReasons: {
    invalid: 'la URL del entorno aislado no es válida',
    insecure: 'la URL del entorno aislado no es https',
    'same-origin': 'la URL del entorno aislado está en el origen de esta página',
    'no-page-origin': 'esta página no tiene un origen propio',
    'server-name': 'el nombre del servidor no es una etiqueta DNS',
    'too-many-origins': 'declara demasiados orígenes',
    'no-answer': 'la página del entorno aislado no respondió',
  },
  appSandboxBroken: 'La app recargó su marco, así que se detuvo. Recárguela para empezar de nuevo.',
  appWaiting: 'le espera',
  appTag: 'app',
  appsCount: (n) => count(n, 'app', 'apps'),
  appLoading: 'Cargando la app…',
  appFailed: (reason) => `No se pudo mostrar la app: ${reason}`,
  appUnavailable: (server) =>
    `El servidor «${server}» no está conectado, así que su app no se puede mostrar.`,
  appHidden: 'oculta',
  appShow: 'Mostrar',
  appMenu: 'Menú de la app',
  appReload: 'Recargar la app',
  appOpenPanel: 'Abrir en el panel',
  appHide: 'Ocultar la app',
  appServedBy: (server, uri) =>
    `La sirve ${server} como ${uri}. No puede leer este chat, sus claves ni sus archivos.`,
  appInPanel: 'abierta en el panel',
  appBringBack: 'Traer de vuelta',
  appClosePanel: 'Cerrar el panel',
  appPanelNote: (server) =>
    `Contenido del servidor «${server}». No puede leer este chat, sus claves ni sus archivos.`,
  appFrameName: (server) => `App del servidor ${server}`,
  appRan: (names) => `La app ejecutó ${names}`,
  appRefused: 'rechazada',
  approvalLeadApp: (server) => `La app «${server}» quiere ejecutar`,
  approvalFromApp: (server, readOnly) =>
    `Lo pide la app, no el agente. Esta herramienta ${readOnly ? 'solo lee' : 'modifica'} datos en el servidor «${server}».`,
  appLinkLead: (server) => `La app «${server}» quiere abrir un enlace. ¿Abrirlo?`,
  appLinkNote:
    'Se abre en una pestaña nueva, fuera de este chat. Compruebe el nombre del sitio antes de seguir.',
  appLinkOpen: 'Abrir',
  appCancel: 'Cancelar',
  appMessageLead: (server) => `La app «${server}» quiere poner un mensaje en su cuadro de texto`,
  appMessageNote:
    'No se envía nada hasta que lo envíe usted, y puede cambiarlo antes. Es el texto de la app, no el suyo.',
  appMessageAccept: 'Poner en el cuadro de texto',
  appMessageDiscard: 'Descartar',
  appFullscreenBadge: 'pantalla completa',
  appFullscreenExit: 'Salir de pantalla completa',
  appFullscreenKey: 'Esc',
  appDownloadLead: (server) => `La app «${server}» quiere guardar un archivo en su dispositivo`,
  appDownloadType: (mimeType) => mimeType ?? 'tipo no indicado',
  appDownloadSize: bytes,
  appDownloadSource: (source, server) =>
    source === 'link'
      ? `Leído del servidor «${server}» para la app.`
      : 'Creado por la app dentro de su marco.',
  appDownloadNote:
    'Lo guarda esta página, no la app. Nunca se guardan programas, scripts ni páginas web; compruebe el nombre antes de guardar.',
  appDownloadSave: 'Guardar archivo',
  appSamplingLead: (server) => `La app «${server}» pide una respuesta al modelo del agente`,
  appSamplingSystem: 'Sus instrucciones',
  appSamplingRole: (role) => (role === 'user' ? 'Pregunta' : 'Respuesta anterior'),
  appSamplingImages: (n) => count(n, 'imagen', 'imágenes'),
  appSamplingTokens: (tokens, asked) =>
    tokens < asked ? `Hasta ${tokens} tokens (la app pidió ${asked}).` : `Hasta ${tokens} tokens.`,
  appSamplingNote:
    'Solo se envía este texto, no su chat. La respuesta va solo a la app, y sus tokens cuentan en su total.',
  appSamplingAllow: 'Permitir una vez',
  appSamplingAlways: 'Siempre para esta app',
  appSamplingDeny: 'Denegar',
  skillConsentLead: (server, skill) => `El servidor «${server}» ofrece la habilidad «${skill}»`,
  skillConsentSize: (n, files) =>
    `SKILL.md ${bytes(n)}${files ? ` · ${count(files, 'archivo más', 'archivos más')}` : ''}`,
  skillConsentByUri: 'No está en la lista del servidor: el agente la pidió por su dirección.',
  skillConsentNested: (enclosing) =>
    `Está dentro de la habilidad «${enclosing}»: permitir aquella no permitió esta.`,
  skillConsentDynamic:
    'Este servidor no publica sumas de comprobación para esta habilidad: apruebas la copia que el agente acaba de leer, y solo se usa esa copia.',
  skillConsentNoFileListing:
    'El servidor no puede listar los archivos de esta habilidad: esa copia es solo su SKILL.md.',
  skillConsentPreview: 'Mostrar lo que leería el agente',
  skillConsentFiles: (paths, more) =>
    `Sus archivos, leídos como texto y nunca ejecutados: ${paths}${more ? ` y ${more} más` : ''}`,
  skillConsentNote: (server, consent) =>
    `Instrucciones escritas por el servidor «${server}», no por usted. Llegan al agente solo si usted lo permite${
      consent === 'ask'
        ? ', y se le preguntará de nuevo en cada tarea que las cargue.'
        : '; se le preguntará de nuevo si el servidor las cambia.'
    } No pueden cambiar las reglas ni los permisos del agente.`,
  skillConsentAllow: 'Permitir una vez',
  skillConsentAlways: 'Siempre para este servidor',
  skillConsentDeny: 'Denegar',
  skillConsentDeclined: 'el usuario rechazó la habilidad',
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

  elicitationTitle: 'Eine Frage von einem MCP-Server',
  elicitationLead: (server) => `Der MCP-Server „${server}“ bittet Sie um eine Eingabe`,
  elicitationLeadHelper: (server, role) =>
    role
      ? `Der MCP-Server „${server}“ bittet Sie um eine Eingabe (Aufruf des Helfers „${role}“)`
      : `Der MCP-Server „${server}“ bittet Sie um eine Eingabe (Aufruf eines Helfers)`,
  elicitationDuring: 'während',
  elicitationCount: (index, total) => `${index} von ${total}`,
  elicitationFrom: (server) => `Vom Server „${server}“`,
  elicitationRequired: 'erforderlich',
  elicitationChoose: 'Auswählen…',
  elicitationSubmit: 'Absenden',
  elicitationDecline: 'Ablehnen',
  elicitationCancel: 'Abbrechen',
  elicitationErrors: {
    required: (field) => `${field} ist erforderlich.`,
    tooShort: (field, limit) => `${field} muss mindestens ${limit} Zeichen lang sein.`,
    tooLong: (field, limit) => `${field} darf höchstens ${limit} Zeichen lang sein.`,
    email: (field) => `${field} muss eine E-Mail-Adresse sein.`,
    uri: (field) => `${field} muss eine vollständige Adresse sein, etwa https://example.com.`,
    date: (field) => `${field} muss ein Datum sein.`,
    dateTime: (field) => `${field} muss ein Datum mit Uhrzeit sein.`,
    notNumber: (field) => `${field} muss eine Zahl sein.`,
    notInteger: (field) => `${field} muss eine ganze Zahl sein.`,
    belowMinimum: (field, limit) => `${field} muss mindestens ${limit} sein.`,
    aboveMaximum: (field, limit) => `${field} darf höchstens ${limit} sein.`,
    notAnOption: (field) => `${field} muss eine der Optionen sein.`,
    tooFew: (field, limit) => `${field}: Wählen Sie mindestens ${limit}.`,
    tooMany: (field, limit) => `${field}: Wählen Sie höchstens ${limit}.`,
  },
  elicitationFix: (n) =>
    n === 1 ? '1 Feld muss korrigiert werden.' : `${n} Felder müssen korrigiert werden.`,
  elicitationUrlLead: (server) => `Der MCP-Server „${server}“ bittet Sie, eine Seite zu öffnen auf`,
  elicitationUrlFull: 'Vollständige Adresse',
  elicitationOpen: 'In neuem Tab öffnen',
  elicitationOpened: 'In einem neuen Tab geöffnet. Schließen Sie dort ab und bestätigen Sie hier.',
  elicitationUrlDone: 'Ich bin dort fertig',
  elicitationUrlRefused:
    'Dieser Link ist keine sichere Adresse (https) und wird daher nicht von hier aus geöffnet.',
  elicitationExpiresIn: (time) => `Wird in ${time} automatisch abgebrochen`,
  elicitationExpires: 'Wird automatisch abgebrochen, wenn sie unbeantwortet bleibt',
  elicitationAutomatic: (server, reason) =>
    `Eine Frage des MCP-Servers „${server}“ wurde automatisch beantwortet, und ihr Tool-Aufruf wurde nicht abgeschlossen: ${reason}.`,
  elicitationReasons: {
    timeout: 'niemand hat rechtzeitig geantwortet',
    'step-timeout': 'die Zeit des Schritts lief ab, während die Frage wartete',
    aborted: 'der Lauf wurde gestoppt',
    stopped: 'der Lauf wurde gestoppt',
    'cap-per-call': 'der Aufruf hatte bereits zu viele Fragen gestellt',
    'cap-per-run': 'in diesem Lauf wurden bereits zu viele Fragen gestellt',
    'unsupported-schema': 'das gesendete Formular kann nicht angezeigt werden',
    'unsupported-mode': 'er fragte auf eine Weise, die diese App nicht anbietet',
    'insecure-url': 'der gesendete Link wurde abgelehnt',
    'invalid-request': 'seine Anfrage war fehlerhaft',
    subagent: 'ein Helfer darf Sie nicht fragen',
    'handler-error': 'die Frage konnte nicht angezeigt werden',
    'invalid-answer': 'die Antwort passte nicht zum Formular und wurde nicht gesendet',
    'after-failure': 'eine frühere Frage desselben Aufrufs war bereits fehlgeschlagen',
    'no-tool-call': 'es lief kein Aufruf',
  },
  elicitationDismiss: 'Schließen',
  filesWritten: (n) => `${count(n, 'Datei', 'Dateien')} in diesem Schritt geschrieben`,
  filesCount: (n) => count(n, 'Datei', 'Dateien'),
  showInFiles: 'In Dateien anzeigen',
  fileKinds: {
    html: 'HTML',
    markdown: 'Markdown',
    csv: 'CSV',
    json: 'JSON',
    image: 'Bild',
    code: 'Code',
    text: 'Text',
    file: 'Datei',
  },
  fileOpen: (name) => `${name} öffnen`,
  fileClose: (name) => `Vorschau von ${name} schließen`,
  fileDownload: (name) => `${name} herunterladen`,
  fileBy: (name) => `von ${name}`,
  fileGone: 'nicht mehr im Arbeitsbereich',
  fileNoPreview: 'Für diesen Dateityp gibt es keine Vorschau. Laden Sie die Datei herunter.',
  fileCut: (chars) =>
    `Nur die ersten ${chars.toLocaleString('de-DE')} Zeichen werden angezeigt. Der Rest steht in der heruntergeladenen Datei.`,
  fileShowRest: 'Rest anzeigen',
  fileShowLess: 'Weniger anzeigen',
  fileRendered: 'Ansicht',
  fileSource: 'Quelltext',
  closePreview: 'Vorschau schließen',
  fileLines: (n) => count(n, 'Zeile', 'Zeilen'),
  htmlFrameTitle: 'Vom Agenten geschriebenes HTML',
  htmlSandboxed: 'isoliert',
  htmlNoNetwork: 'ohne Netzwerk',
  htmlSourceNote: 'als Text angezeigt, nichts wird ausgeführt',
  htmlScripts: (on) => (on ? 'Skripte an' : 'Skripte aus'),
  htmlLinkedFiles: (names) => `verknüpfte Dateien werden nicht geladen: ${names}`,
  htmlTooLarge: 'Die Seite ist zu groß für die Vorschau. Der Quelltext wird angezeigt.',
  htmlTaller: 'Vorschau höher machen',
  htmlShorter: 'Vorschau niedriger machen',
  htmlFrameName: (path) => `Vorschau von ${path}`,

  appFrom: (server) => `App vom Server „${server}“`,
  appSandboxed: 'abgeschottet',
  appSandboxedOrigin: 'abgeschottet, mit eigenem Origin',
  appSandboxOrigin: (origin) =>
    `Läuft auf einem eigenen Origin, ${origin}: ihr Speicher gehört ihr, nie dieser Seite.`,
  appSandboxFallback: (reason) =>
    `Ohne eigenen Origin (${reason}): sie läuft in einer opaken Sandbox, ohne eigenen Speicher.`,
  appSandboxReasons: {
    invalid: 'die Sandbox-URL ist ungültig',
    insecure: 'die Sandbox-URL ist nicht https',
    'same-origin': 'die Sandbox-URL liegt auf dem Origin dieser Seite',
    'no-page-origin': 'diese Seite hat keinen eigenen Origin',
    'server-name': 'der Name des Servers ist kein DNS-Label',
    'too-many-origins': 'sie deklariert zu viele Origins',
    'no-answer': 'die Sandbox-Seite hat nicht geantwortet',
  },
  appSandboxBroken:
    'Die App hat ihren Rahmen neu geladen und wurde deshalb angehalten. Laden Sie sie neu, um von vorn zu beginnen.',
  appWaiting: 'wartet auf Sie',
  appTag: 'App',
  appsCount: (n) => count(n, 'App', 'Apps'),
  appLoading: 'Die App wird geladen…',
  appFailed: (reason) => `Die App konnte nicht angezeigt werden: ${reason}`,
  appUnavailable: (server) =>
    `Der Server „${server}“ ist nicht verbunden, daher kann seine App nicht angezeigt werden.`,
  appHidden: 'ausgeblendet',
  appShow: 'Anzeigen',
  appMenu: 'App-Menü',
  appReload: 'App neu laden',
  appOpenPanel: 'Im Seitenbereich öffnen',
  appHide: 'App ausblenden',
  appServedBy: (server, uri) =>
    `Bereitgestellt von ${server} als ${uri}. Sie kann diesen Chat, Ihre Schlüssel und Ihre Dateien nicht lesen.`,
  appInPanel: 'im Seitenbereich geöffnet',
  appBringBack: 'Zurückholen',
  appClosePanel: 'Seitenbereich schließen',
  appPanelNote: (server) =>
    `Inhalt vom Server „${server}“. Er kann diesen Chat, Ihre Schlüssel und Ihre Dateien nicht lesen.`,
  appFrameName: (server) => `App vom Server ${server}`,
  appRan: (names) => `Die App hat ausgeführt: ${names}`,
  appRefused: 'abgelehnt',
  approvalLeadApp: (server) => `Die App „${server}“ möchte ausführen:`,
  approvalFromApp: (server, readOnly) =>
    `Von der App angefragt, nicht vom Agenten. Dieses Werkzeug ${readOnly ? 'liest nur' : 'ändert'} Daten auf dem Server „${server}“.`,
  appLinkLead: (server) => `Die App „${server}“ möchte einen Link öffnen. Öffnen?`,
  appLinkNote:
    'Öffnet sich in einem neuen Tab, außerhalb dieses Chats. Prüfen Sie den Namen der Website, bevor Sie fortfahren.',
  appLinkOpen: 'Öffnen',
  appCancel: 'Abbrechen',
  appMessageLead: (server) => `Die App „${server}“ möchte eine Nachricht in Ihr Eingabefeld setzen`,
  appMessageNote:
    'Nichts wird gesendet, bis Sie es selbst senden, und Sie können es vorher ändern. Es ist der Text der App, nicht Ihrer.',
  appMessageAccept: 'Ins Eingabefeld setzen',
  appMessageDiscard: 'Verwerfen',
  appFullscreenBadge: 'Vollbild',
  appFullscreenExit: 'Vollbild beenden',
  appFullscreenKey: 'Esc',
  appDownloadLead: (server) => `Die App „${server}“ möchte eine Datei auf Ihrem Gerät speichern`,
  appDownloadType: (mimeType) => mimeType ?? 'Typ nicht angegeben',
  appDownloadSize: bytes,
  appDownloadSource: (source, server) =>
    source === 'link'
      ? `Für die App vom Server „${server}“ gelesen.`
      : 'Von der App in ihrem Rahmen erstellt.',
  appDownloadNote:
    'Diese Seite speichert sie, nicht die App. Programme, Skripte und Webseiten werden nie gespeichert; prüfen Sie den Namen, bevor Sie speichern.',
  appDownloadSave: 'Datei speichern',
  appSamplingLead: (server) => `Die App „${server}“ bittet das Modell des Agenten um eine Antwort`,
  appSamplingSystem: 'Ihre Anweisungen',
  appSamplingRole: (role) => (role === 'user' ? 'Fragt' : 'Frühere Antwort'),
  appSamplingImages: (n) => count(n, 'Bild', 'Bilder'),
  appSamplingTokens: (tokens, asked) =>
    tokens < asked
      ? `Bis zu ${tokens} Tokens (die App bat um ${asked}).`
      : `Bis zu ${tokens} Tokens.`,
  appSamplingNote:
    'Nur dieser Text wird gesendet, nicht Ihr Chat. Die Antwort geht nur an die App, und ihre Tokens zählen in Ihrer Summe.',
  appSamplingAllow: 'Einmal erlauben',
  appSamplingAlways: 'Immer für diese App',
  appSamplingDeny: 'Ablehnen',
  skillConsentLead: (server, skill) => `Der Server „${server}“ bietet den Skill „${skill}“ an`,
  skillConsentSize: (n, files) =>
    `SKILL.md ${bytes(n)}${files ? ` · ${count(files, 'weitere Datei', 'weitere Dateien')}` : ''}`,
  skillConsentByUri:
    'Nicht in der Liste des Servers: Der Agent hat ihn über seine Adresse angefordert.',
  skillConsentNested: (enclosing) =>
    `Er liegt im Skill „${enclosing}“: Dessen Freigabe gilt nicht für diesen.`,
  skillConsentDynamic:
    'Dieser Server veröffentlicht keine Prüfsummen für diesen Skill: Sie geben die Kopie frei, die der Agent gerade gelesen hat, und nur diese Kopie wird verwendet.',
  skillConsentNoFileListing:
    'Der Server kann die Dateien dieses Skills nicht auflisten: Diese Kopie ist nur seine SKILL.md.',
  skillConsentPreview: 'Zeigen, was der Agent lesen würde',
  skillConsentFiles: (paths, more) =>
    `Seine Dateien, nur als Text gelesen, nie ausgeführt: ${paths}${more ? ` und ${more} weitere` : ''}`,
  skillConsentNote: (server, consent) =>
    `Anweisungen vom Server „${server}“, nicht von Ihnen. Sie erreichen den Agenten nur, wenn Sie es erlauben${
      consent === 'ask'
        ? ', und Sie werden in jeder Aufgabe, die sie lädt, erneut gefragt.'
        : ' - Sie werden erneut gefragt, wenn der Server sie ändert.'
    } Sie können die Regeln und Freigaben des Agenten nicht ändern.`,
  skillConsentAllow: 'Einmal erlauben',
  skillConsentAlways: 'Immer für diesen Server',
  skillConsentDeny: 'Ablehnen',
  skillConsentDeclined: 'der Nutzer hat den Skill abgelehnt',
}

/** The label set of a chat language; English is the library's own defaults. */
export const LABELS: Record<'es' | 'de', AgentLabels> = { es: ES_LABELS, de: DE_LABELS }
