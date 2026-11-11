const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const XLSX = require('xlsx');
const browserTools = require('./browser');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const DATA = app.getPath('userData');
const CONFIG = path.join(DATA, 'config.json');
const CONVS = path.join(DATA, 'conversations');
const RUNPOD = 'https://rest.runpod.io/v1';

// Recette du pod, utilisée pour le recréer quand ses GPU ne sont plus libres.
const POD_SPEC = {
  name: 'ollama-qwen3-vl-32b',
  image: 'ollama/ollama:latest',
  gpuTypeIds: ['NVIDIA GeForce RTX 4090'],
  cloudType: 'SECURE',
  disk: 60,
  ports: ['11434/http', '7681/http'],
  env: { OLLAMA_HOST: '0.0.0.0', OLLAMA_CONTEXT_LENGTH: '16384', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' },
  entrypoint: ['/bin/sh', '-c'],
  cmd: ['(apt-get update -qq && apt-get install -y -qq curl ca-certificates htop nvtop >/dev/null 2>&1; ' +
    'curl -sL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && ' +
    'chmod +x /usr/local/bin/ttyd && ttyd -W -p 7681 -c admin:$TTYD_PASS bash) & ' +
    'ollama serve & sleep 5 && ollama pull huihui_ai/qwen3-vl-abliterated:32b && wait']
};

const DEFAULT_CONFIG = {
  runpodApiKey: '',
  activeMachine: 'runpod-4090',
  machines: [
    {
      id: 'runpod-4090',
      name: 'RunPod RTX 4090',
      type: 'runpod',
      podId: 'VOTRE_POD_ID',
      url: 'https://VOTRE_POD_ID-11434.proxy.runpod.net',
      model: 'huihui_ai/qwen3-vl-abliterated:32b',
      terminalUrl: 'https://VOTRE_POD_ID-7681.proxy.runpod.net',
      terminalUser: 'admin',
      terminalPass: '',
      podSpec: POD_SPEC,
      costPerHour: 0.89
    },
    {
      id: 'local',
      name: 'Ollama local',
      type: 'local',
      url: 'http://localhost:11434',
      model: 'qwen3:8b',
      costPerHour: 0
    }
  ]
};

// Journal : %APPDATA%\rankicode\logs\rankicode.log (ouvrable depuis Réglages).
const LOG = path.join(DATA, 'logs', 'rankicode.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
try { if (fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.old'); } catch {}
function log(level, ...parts) {
  const text = parts.map(p => p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  fs.appendFileSync(LOG, `${new Date().toISOString()} [${level}] ${text}\n`);
}
process.on('uncaughtException', err => log('CRASH', err));
process.on('unhandledRejection', err => log('ERREUR', err));

// Toutes les fonctions appelées par la fenêtre passent par ici : leurs erreurs sont journalisées.
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
  try { return await fn(...args); } catch (err) { log('ERREUR', `${channel} :`, err); throw err; }
});
ipcMain.on('log', (_, level, text) => log(level, text));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const getConfig = () => readJson(CONFIG, DEFAULT_CONFIG);
const machine = id => getConfig().machines.find(m => m.id === id);

async function runpod(method, route, body) {
  const key = getConfig().runpodApiKey;
  if (!key) throw new Error('Clé API RunPod manquante (Réglages).');
  const res = await fetch(RUNPOD + route, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RunPod ${res.status} : ${text}`);
  return text ? JSON.parse(text) : {};
}

// Le pod tourne-t-il, et le modèle répond-il ?
async function machineStatus(id) {
  const m = machine(id);
  let pod = null;
  if (m.type === 'runpod') {
    pod = (await runpod('GET', `/pods/${m.podId}`)).desiredStatus;
  }
  let ready = false;
  if (!pod || pod === 'RUNNING') {
    try {
      const r = await fetch(`${m.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const tags = await r.json();
      ready = tags.models.some(x => x.name === m.model);
    } catch {}
  }
  return { pod, ready };
}

// Métriques du pod (API GraphQL RunPod) et modèles chargés dans Ollama.
ipcMain.handle('machine:metrics', async (_, id) => {
  const m = machine(id);
  const result = { pod: null, models: [] };
  if (m.type === 'runpod') {
    const key = getConfig().runpodApiKey;
    const query = `query { pod(input: { podId: "${m.podId}" }) {
      desiredStatus costPerHr
      machine { gpuDisplayName }
      runtime { uptimeInSeconds
        gpus { gpuUtilPercent memoryUtilPercent }
        container { cpuPercent memoryPercent } } } }`;
    const res = await fetch('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query })
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    result.pod = json.data.pod;
  }
  try {
    const r = await fetch(`${m.url}/api/ps`, { signal: AbortSignal.timeout(4000) });
    result.models = (await r.json()).models || [];
  } catch {}
  return result;
});

ipcMain.handle('logs:open', () => shell.openPath(LOG));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('config:get', () => getConfig());
ipcMain.handle('config:save', (_, cfg) => writeJson(CONFIG, cfg));
ipcMain.handle('machine:status', (_, id) => machineStatus(id));
// Un pod éteint reste attaché à sa machine physique : si ses GPU ont été loués
// entre-temps, on recrée un pod identique ailleurs (il n'a pas de stockage à perdre).
ipcMain.handle('machine:start', async (e, id) => {
  try {
    return await runpod('POST', `/pods/${machine(id).podId}/start`);
  } catch (err) {
    if (!/not enough free GPUs|no longer any instances|not available/i.test(err.message)) throw err;
    e.sender.send('machine:progress', 'GPU pris, recréation du pod sur une autre machine…');
    return relocate(id);
  }
});

async function relocate(id) {
  const cfg = getConfig();
  const m = cfg.machines.find(x => x.id === id);
  const spec = m.podSpec;
  if (!spec) throw new Error("Pas de podSpec pour cette machine : impossible de la recréer automatiquement.");
  const pod = await runpod('POST', '/pods', {
    name: spec.name,
    imageName: spec.image,
    gpuTypeIds: spec.gpuTypeIds,
    gpuCount: 1,
    cloudType: spec.cloudType || 'SECURE',
    containerDiskInGb: spec.disk,
    volumeInGb: 0,
    ports: spec.ports,
    env: { ...spec.env, ...(m.terminalPass && { TTYD_PASS: m.terminalPass }) },
    dockerEntrypoint: spec.entrypoint,
    dockerStartCmd: spec.cmd
  });
  const oldId = m.podId;
  for (const k of ['url', 'terminalUrl']) if (m[k]) m[k] = m[k].replace(oldId, pod.id);
  m.podId = pod.id;
  writeJson(CONFIG, cfg);
  await runpod('DELETE', `/pods/${oldId}`).catch(() => {});
  return { relocated: true, podId: pod.id };
}
ipcMain.handle('machine:stop', (_, id) => runpod('POST', `/pods/${machine(id).podId}/stop`));

ipcMain.handle('conv:list', () => {
  if (!fs.existsSync(CONVS)) return [];
  return fs.readdirSync(CONVS)
    .map(f => readJson(path.join(CONVS, f), null))
    .filter(Boolean)
    .map(c => ({ id: c.id, title: c.title, updated: c.updated }))
    .sort((a, b) => b.updated - a.updated);
});
ipcMain.handle('conv:load', (_, id) => readJson(path.join(CONVS, `${id}.json`), null));
ipcMain.handle('conv:save', (_, conv) => writeJson(path.join(CONVS, `${conv.id}.json`), conv));
ipcMain.handle('conv:delete', (_, id) => fs.rmSync(path.join(CONVS, `${id}.json`), { force: true }));

// Actions navigateur demandées par le modèle, dans un profil propre à RankiCode.
ipcMain.handle('browser', (_, { name, args }) => {
  const kind = getConfig().browser || 'firefox';
  return browserTools.run(name, args, kind, path.join(DATA, `${kind}-profile`));
});

const AGENT_TOOLS = [...browserTools.TOOLS, {
  type: 'function',
  function: {
    name: 'run_command',
    description: "Exécute une commande PowerShell sur l'ordinateur Windows de l'utilisateur et renvoie sa sortie. L'utilisateur valide chaque commande avant exécution.",
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'La commande PowerShell à exécuter' } },
      required: ['command']
    }
  }
}];

// Pièces jointes : texte et Excel deviennent du texte, les images restent en base64.
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const EXCEL_EXT = ['.xlsx', '.xls', '.xlsm', '.ods'];
const MAX_TEXT = 60000;

function readAttachment(file) {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.includes(ext)) {
    return { name, kind: 'image', data: fs.readFileSync(file).toString('base64') };
  }
  let text;
  if (EXCEL_EXT.includes(ext)) {
    const book = XLSX.readFile(file);
    text = book.SheetNames
      .map(s => `### Feuille « ${s} »\n${XLSX.utils.sheet_to_csv(book.Sheets[s])}`)
      .join('\n\n');
  } else {
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${name} : format non pris en charge (fichier binaire).`);
    text = buf.toString('utf8');
  }
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n[… tronqué, ${text.length} caractères au total]`;
  return { name, kind: 'text', data: text };
}

ipcMain.handle('file:read', (_, file) => readAttachment(file));
ipcMain.handle('file:pick', async e => {
  const { filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Fichiers pris en charge', extensions: ['txt', 'md', 'csv', 'json', 'log', 'xml', 'html', 'js', 'ts', 'py', 'php', 'yml', 'yaml', 'sql', ...EXCEL_EXT.map(x => x.slice(1)), ...IMAGE_EXT.map(x => x.slice(1))] },
      { name: 'Tous les fichiers', extensions: ['*'] }
    ]
  });
  return filePaths;
});

// Aperçu du PC donné au modèle en mode agent.
ipcMain.handle('sysinfo', () => {
  const disks = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-PSDrive -PSProvider FileSystem | % { '{0}: {1:N0} Go libres / {2:N0} Go' -f $_.Name, ($_.Free/1GB), (($_.Used+$_.Free)/1GB) }"],
    { encoding: 'utf8', windowsHide: true }).trim();
  return [
    `Système : ${os.version()} (${os.release()}), ${os.arch()}`,
    `Machine : ${os.hostname()}, utilisateur ${os.userInfo().username}`,
    `CPU : ${os.cpus()[0].model} (${os.cpus().length} cœurs), RAM ${Math.round(os.totalmem() / 1e9)} Go`,
    `Dossier personnel : ${os.homedir()}`,
    `Disques :\n${disks}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`
  ].join('\n');
});

// Commande validée par l'utilisateur dans la fenêtre.
ipcMain.handle('exec', (_, command) => new Promise(resolve => {
  execFile('powershell.exe', ['-NoProfile', '-Command', command],
    { cwd: os.homedir(), timeout: 120000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      let out = (stdout + stderr).trim();
      if (err && err.killed) out += '\n[arrêtée après 120 s]';
      else if (err) out += `\n[code de sortie ${err.code}]`;
      resolve(out.slice(-8000) || '(aucune sortie)');
    });
}));

let chatAbort = null;
ipcMain.handle('chat:abort', () => { if (chatAbort) chatAbort.abort(); });

// Réponse en streaming : chaque morceau est renvoyé à la fenêtre.
// En mode agent, renvoie les appels d'outils demandés par le modèle.
ipcMain.handle('chat', async (e, { machineId, messages, agent }) => {
  const m = machine(machineId);
  // Le premier message charge le modèle dans le GPU : on prévient la fenêtre.
  try {
    const ps = await (await fetch(`${m.url}/api/ps`, { signal: AbortSignal.timeout(4000) })).json();
    if (!ps.models.some(x => x.name === m.model)) e.sender.send('chat:status', 'Chargement du modèle dans le GPU (30 à 60 s)…');
  } catch {}
  chatAbort = new AbortController();
  const res = await fetch(`${m.url}/api/chat`, {
    signal: chatAbort.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: m.model, messages, stream: true, ...(agent && { tools: AGENT_TOOLS }),
      // Réglages recommandés pour Qwen3 : évitent qu'un modèle compressé tourne en boucle,
      // et num_predict borne la longueur d'une réponse.
      options: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 1.5, repeat_penalty: 1.1, num_predict: 8192 }
    })
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} : ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let data;
      try { data = JSON.parse(line); } catch {
        throw new Error("Le pod ne répond pas (éteint, en démarrage ou modèle pas encore prêt). Réessayez dans un instant.");
      }
      if (data.error) throw new Error(`Ollama : ${data.error}`);
      const msg = data.message || {};
      if (msg.tool_calls) toolCalls.push(...msg.tool_calls);
      e.sender.send('chat:chunk', { content: msg.content || '', thinking: msg.thinking || '' });
    }
  }
  return toolCalls;
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1a1a19',
    title: 'RankiCode',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1a1a19', symbolColor: '#8a8983', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.removeMenu();
  win.loadFile('index.html');
  log('INFO', `Démarrage v${app.getVersion()}, données dans ${DATA}`);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log(level === 3 ? 'ERREUR-FENETRE' : 'ALERTE-FENETRE', `${message} (${path.basename(source)}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => log('CRASH', 'Fenêtre plantée :', details));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
});
app.on('window-all-closed', () => app.quit());

// Le terminal du pod est protégé par mot de passe : on le fournit automatiquement.
app.on('login', (e, _wc, details, _auth, callback) => {
  const m = getConfig().machines.find(x => x.terminalUrl && details.url.startsWith(x.terminalUrl));
  if (!m) return;
  e.preventDefault();
  callback(m.terminalUser, m.terminalPass);
});
