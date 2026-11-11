const $ = id => document.getElementById(id);

let config;
let conv = null;     // conversation ouverte
let streaming = null; // { content, thinking, el }
let liveConvId = null;  // conversation dont la réponse est en cours
let liveCard = null;    // carte de commande en cours dans cette conversation

// Les éléments d'une réponse en cours ne s'affichent que si sa conversation est ouverte.
let rendering = false;
const place = el => { if (rendering || !liveConvId || (conv && conv.id === liveConvId)) $('messages').appendChild(el); };

const machineId = () => $('machine').value;

const AGENT_PROMPT = `Tu es un agent qui agit sur l'ordinateur Windows de l'utilisateur avec l'outil run_command (PowerShell).
Procède par petites étapes : une commande, lis sa sortie, puis décide de la suite.
Le dossier de départ est le dossier personnel de l'utilisateur. Préfère les commandes non destructives et explique brièvement ce que tu fais.
Tu pilotes aussi le navigateur web (Firefox ou Chrome) avec les outils browser_* : ouvre une page, lis ses éléments numérotés [id], clique ou tape dedans, et prends une capture si tu as besoin de voir la page. Enchaîne les actions jusqu'à ce que la tâche soit faite.
Tu as accès à tout l'ordinateur : explore-le avec tes commandes (Get-ChildItem, Get-Content, Get-Process…) pour trouver le contexte dont tu as besoin.
Quand la tâche est finie, réponds sans appeler d'outil.`;

let sysinfo = null;
const getSysinfo = async () => sysinfo ??= await window.api.sysinfo();

// ---- Machines -------------------------------------------------------------

function renderMachines() {
  $('machine').innerHTML = config.machines
    .map(m => `<option value="${m.id}">${m.name} — ${m.model}</option>`).join('');
  $('machine').value = config.activeMachine;
}

async function refreshStatus() {
  const m = config.machines.find(x => x.id === machineId());
  const isPod = m.type === 'runpod';
  $('cost').textContent = m.costPerHour ? `${m.costPerHour} $/h` : 'gratuit';
  $('powerBtn').hidden = !isPod;
  try {
    const { pod, ready } = await window.api.status(m.id);
    podRunning = pod === 'RUNNING';
    let state, text;
    if (ready) { state = 'on'; text = 'Prêt'; }
    else if (podRunning) { state = 'wait'; text = 'Démarrage du modèle…'; }
    else if (isPod) { state = 'off'; text = 'Éteint'; }
    else { state = 'off'; text = 'Injoignable'; }
    $('dot').className = `dot ${state}`;
    $('statusText').textContent = text;
    $('powerBtn').disabled = false;
    $('powerBtn').classList.toggle('on', podRunning);
    $('powerBtn').title = podRunning ? 'Éteindre la machine' : 'Allumer la machine';
    if (view === 'termView' && $('termFrame').hidden === podRunning) loadTerminal();
  } catch (err) {
    $('dot').className = 'dot off';
    $('statusText').textContent = cleanError(err);
  }
}

let podRunning = false;
const cleanError = err => err.message.replace(/^Error invoking.*?: (Error: )?/, '');

$('machine').onchange = async () => {
  config.activeMachine = machineId();
  await window.api.saveConfig(config);
  $('termFrame').removeAttribute('src');
  await refreshStatus();
  refreshMetrics();
  if (view === 'termView') loadTerminal();
};
$('powerBtn').onclick = async () => {
  if (podRunning && !confirm('Éteindre la machine ? Les conversations restent sur ce PC.')) return;
  $('powerBtn').disabled = true;
  $('statusText').textContent = podRunning ? 'Extinction…' : 'Allumage…';
  try {
    const res = await (podRunning ? window.api.stop : window.api.start)(machineId());
    if (res && res.relocated) {
      // Le pod a été recréé ailleurs : nouvel identifiant et nouvelles adresses.
      config = await window.api.getConfig();
      $('termFrame').removeAttribute('src');
    }
  } catch (err) { alert(cleanError(err)); }
  refreshStatus();
};
window.api.onProgress(text => { $('statusText').textContent = text; });

// ---- Conversations --------------------------------------------------------

async function renderConvs() {
  const list = await window.api.listConvs();
  $('convs').innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.className = conv && conv.id === c.id ? 'active' : '';
    li.innerHTML = `<span></span><button class="del" title="Supprimer"><svg class="i" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>`;
    li.querySelector('span').textContent = c.title;
    li.onclick = () => openConv(c.id);
    li.querySelector('.del').onclick = async e => {
      e.stopPropagation();
      if (!confirm(`Supprimer « ${c.title} » ?`)) return;
      await window.api.deleteConv(c.id);
      if (conv && conv.id === c.id) newConv();
      renderConvs();
    };
    $('convs').appendChild(li);
  }
}

async function openConv(id) {
  conv = await window.api.loadConv(id);
  renderMessages();
  renderConvs();
}

function newConv() {
  conv = null;
  renderMessages();
  renderConvs();
  $('input').focus();
}
$('newConv').onclick = newConv;

// Markdown des réponses → HTML nettoyé, avec un bouton Copier sur les blocs de code.
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(el, text) {
  el.classList.add('md');
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  el.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noreferrer'; });
  el.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'Copier';
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
      btn.textContent = 'Copié';
      setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
    };
    pre.appendChild(btn);
  });
}

function addMessage(role, content, thinking, attachments) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (attachments && attachments.length) wrap.appendChild(chipList(attachments));
  if (thinking) {
    const d = document.createElement('details');
    d.innerHTML = '<summary>Réflexion</summary>';
    d.append(thinking);
    wrap.appendChild(d);
  }
  const body = document.createElement('div');
  if (role === 'assistant' && content) renderMarkdown(body, content);
  else body.textContent = content;
  wrap.appendChild(body);
  place(wrap);
  return wrap;
}

// Carte d'une commande : en attente de validation, ou avec sa sortie.
function addTool(command, output) {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.innerHTML = '<div class="tool"><div class="cmd"></div></div>';
  wrap.querySelector('.cmd').textContent = command;
  place(wrap);
  if (output !== undefined) setToolOutput(wrap, output);
  return wrap;
}

function setToolOutput(wrap, output) {
  const out = document.createElement('div');
  out.className = 'out';
  out.textContent = output;
  wrap.querySelector('.tool').appendChild(out);
}

function askApproval(wrap) {
  return new Promise(resolve => {
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = '<button class="primary">Exécuter</button><button>Refuser</button>';
    const [ok, no] = actions.querySelectorAll('button');
    ok.onclick = () => { actions.remove(); resolve(true); };
    no.onclick = () => { actions.remove(); resolve(false); };
    wrap.querySelector('.tool').appendChild(actions);
    $('messages').scrollTop = $('messages').scrollHeight;
    ok.focus();
  });
}

// Libellé lisible d'un appel d'outil, affiché dans la carte.
function describeCall({ function: { name, arguments: a } }) {
  switch (name) {
    case 'run_command': return a.command;
    case 'browser_navigate': return `Navigateur › ouvrir ${a.url}`;
    case 'browser_read': return 'Navigateur › lire la page';
    case 'browser_click': return `Navigateur › cliquer sur [${a.id}]`;
    case 'browser_type': return `Navigateur › taper « ${a.text} » dans [${a.id}]${a.submit ? ' + Entrée' : ''}`;
    case 'browser_scroll': return `Navigateur › défiler vers le ${a.direction === 'up' ? 'haut' : 'bas'}`;
    case 'browser_back': return 'Navigateur › page précédente';
    case 'browser_screenshot': return "Navigateur › capture d'écran";
    case 'browser_tabs': return `Navigateur › onglets : ${a.action}${a.index != null ? ' ' + a.index : ''}`;
    default: return `${name} ${JSON.stringify(a)}`;
  }
}

async function runTool({ function: { name, arguments: a } }) {
  if (name === 'run_command') return { output: await window.api.exec(a.command) };
  return window.api.browser(name, a);
}

function renderMessages() {
  $('messages').innerHTML = '';
  if (!conv || !conv.messages.length) {
    $('messages').innerHTML = `<div class="empty">
      <svg class="i logo" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>
      <h1>Comment puis-je vous aider ?</h1></div>`;
    return;
  }
  const msgs = conv.messages;
  const live = streaming && conv.id === liveConvId;
  rendering = true;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') continue;
    if (m.content || m.thinking || m.attachments) addMessage(m.role, m.content, m.thinking, m.attachments);
    for (const [j, call] of (m.tool_calls || []).entries()) {
      const result = msgs[i + 1 + j];
      const done = result && result.role === 'tool';
      if (!done && live) continue; // la carte en cours est réinsérée plus bas
      addTool(describeCall(call), done ? result.content : '');
    }
  }
  rendering = false;
  // Réponse en cours dans cette conversation : on remet la bulle et la carte vivantes.
  if (live) {
    if (!streaming.pushed) $('messages').appendChild(streaming.el);
    if (liveCard) $('messages').appendChild(liveCard);
  }
  $('messages').scrollTop = $('messages').scrollHeight;
}

// ---- Envoi ----------------------------------------------------------------

// Bulle de réponse en cours : réflexion visible en direct, puis repliée quand la réponse arrive.
function startStreaming() {
  const el = addMessage('assistant', '');
  const think = document.createElement('details');
  think.className = 'live';
  think.open = true;
  think.hidden = true;
  think.innerHTML = '<summary>Réflexion…</summary><div class="think-text"></div>';
  el.insertBefore(think, el.lastChild);
  el.lastChild.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  streaming = { content: '', thinking: '', raw: '', el, think };
}

window.api.onChatStatus(text => {
  if (streaming && !streaming.raw && !streaming.thinking) streaming.el.lastChild.textContent = text;
});

window.api.onChunk(({ content, thinking }) => {
  if (!streaming) return;
  const s = streaming;
  s.thinking += thinking;
  s.raw += content;
  // Certains modèles mettent leur réflexion dans des balises <think> au lieu d'un champ à part.
  const m = s.raw.match(/^\s*<think>([\s\S]*?)(<\/think>|$)([\s\S]*)/);
  const tagThinking = m ? m[1] : '';
  s.content = m ? m[3].trimStart() : s.raw;
  const allThinking = s.thinking + tagThinking;

  if (allThinking) {
    s.think.hidden = false;
    s.think.querySelector('.think-text').textContent = allThinking;
  }
  if (s.content) {
    if (s.think.open && allThinking) { s.think.open = false; s.think.querySelector('summary').textContent = 'Réflexion'; }
    renderMarkdown(s.el.lastChild, s.content);
  }
  s.thinkingFull = allThinking;
  $('messages').scrollTop = $('messages').scrollHeight;
});

// ---- Pièces jointes -------------------------------------------------------

let pending = [];

const ICON_FILE = '<svg class="i" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

function chipList(items, onRemove) {
  const list = document.createElement('div');
  list.className = 'chips';
  items.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = a.kind === 'image' ? `<img src="data:image/*;base64,${a.data}">` : ICON_FILE;
    const name = document.createElement('span');
    name.textContent = a.name;
    chip.appendChild(name);
    if (onRemove) {
      const x = document.createElement('button');
      x.type = 'button';
      x.title = 'Retirer';
      x.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      x.onclick = () => onRemove(i);
      chip.appendChild(x);
    }
    list.appendChild(chip);
  });
  return list;
}

function renderPending() {
  $('attachments').replaceWith(Object.assign(
    chipList(pending, i => { pending.splice(i, 1); renderPending(); }), { id: 'attachments' }));
}

async function addFiles(files) {
  for (const f of files) {
    try {
      const filePath = typeof f === 'string' ? f : window.api.pathOf(f);
      if (filePath) {
        pending.push(await window.api.readFile(filePath));
      } else if (f.type.startsWith('image/')) {
        // Image collée depuis le presse-papiers : pas de chemin sur le disque.
        const data = await new Promise(r => {
          const reader = new FileReader();
          reader.onload = () => r(reader.result.split(',')[1]);
          reader.readAsDataURL(f);
        });
        pending.push({ name: f.name || 'image collée.png', kind: 'image', data });
      }
    } catch (err) { alert(cleanError(err)); }
  }
  renderPending();
  $('input').focus();
}

$('attach').onclick = async () => addFiles(await window.api.pickFiles());
$('input').onpaste = e => {
  const files = [...e.clipboardData.files];
  if (files.length) { e.preventDefault(); addFiles(files); }
};
let dragDepth = 0;
window.ondragenter = e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); };
window.ondragleave = () => { if (--dragDepth === 0) document.body.classList.remove('dragging'); };
window.ondragover = e => e.preventDefault();
window.ondrop = e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles([...e.dataTransfer.files]);
};

// Message tel que le modèle le reçoit : fichiers texte collés dans le contenu, images à part.
function toModel({ role, content, tool_calls, attachments = [] }) {
  const files = attachments.filter(a => a.kind === 'text')
    .map(a => `\n\n<fichier nom="${a.name}">\n${a.data}\n</fichier>`).join('');
  const images = attachments.filter(a => a.kind === 'image').map(a => a.data);
  return { role, content: content + files, tool_calls, ...(images.length && { images }) };
}

async function send() {
  const text = $('input').value.trim();
  if ((!text && !pending.length) || streaming) return;
  const attachments = pending;
  pending = [];
  renderPending();
  $('input').value = '';
  if (!conv) {
    conv = { id: Date.now().toString(), title: (text || attachments[0].name).slice(0, 50), messages: [], updated: Date.now() };
    $('messages').innerHTML = '';
  }
  // La conversation en cours de réponse : on peut en ouvrir une autre pendant ce temps.
  const c = conv;
  liveConvId = c.id;
  c.messages.push({ role: 'user', content: text, ...(attachments.length && { attachments }) });
  c.updated = Date.now();
  await window.api.saveConv(c);
  renderConvs();
  addMessage('user', text, '', attachments);
  setSending(true);
  stopRequested = false;
  const agent = $('agent').checked;

  // Boucle agent : tant que le modèle demande des commandes, on les fait valider
  // puis on lui renvoie leur sortie.
  try {
    while (!stopRequested) {
      startStreaming();
      const toolCalls = await window.api.chat({
        machineId: machineId(),
        agent,
        messages: [
          ...(agent ? [{ role: 'system', content: `${AGENT_PROMPT}\n\nCet ordinateur :\n${await getSysinfo()}` }] : []),
          ...c.messages.map(toModel)
        ]
      });
      c.messages.push({ role: 'assistant', content: streaming.content, thinking: streaming.thinkingFull || '', tool_calls: toolCalls });
      streaming.pushed = true;
      if (!streaming.content && !streaming.thinkingFull) streaming.el.remove();
      await window.api.saveConv(c);
      if (!toolCalls.length) break;

      for (const call of toolCalls) {
        if (stopRequested) break;
        const card = addTool(describeCall(call));
        liveCard = card;
        let output, image;
        if ($('auto').checked || await askApproval(card)) {
          setToolOutput(card, 'Exécution…');
          try {
            ({ output, image } = await runTool(call));
          } catch (err) {
            output = `Erreur : ${cleanError(err)}`;
          }
          card.querySelector('.out').textContent = output;
        } else {
          output = "L'utilisateur a refusé cette action.";
          setToolOutput(card, output);
        }
        c.messages.push({
          role: 'tool', content: output,
          ...(image && { attachments: [{ name: 'capture.jpg', kind: 'image', data: image }] })
        });
        liveCard = null;
      }
    }
  } catch (err) {
    if (stopRequested) {
      // Arrêt demandé : on garde ce qui a déjà été écrit.
      if (streaming.content || streaming.thinkingFull) {
        c.messages.push({ role: 'assistant', content: streaming.content + '\n\n[interrompu]', thinking: streaming.thinkingFull || '' });
      }
    } else {
      streaming.el.className = 'msg assistant error';
      streaming.el.lastChild.textContent = cleanError(err);
    }
  } finally {
    c.updated = Date.now();
    await window.api.saveConv(c).catch(() => {});
    streaming = null;
    liveConvId = null;
    liveCard = null;
    setSending(false);
    if (stopRequested && conv === c) renderMessages();
    renderConvs();
  }
}

// Pendant une réponse, le bouton d'envoi devient un bouton Stop.
let stopRequested = false;
const ICON_SEND = '<svg class="i" viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 19V5"/></svg>';
const ICON_STOP = '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

function setSending(on) {
  $('send').classList.toggle('stop', on);
  $('send').innerHTML = on ? ICON_STOP : ICON_SEND;
  $('send').title = on ? 'Arrêter la réponse' : 'Envoyer (Entrée)';
}

function stop() {
  stopRequested = true;
  window.api.abort();
  // Débloque aussi une validation de commande en attente.
  document.querySelectorAll('.tool .actions button:last-child').forEach(b => b.click());
}

$('composer').onsubmit = e => { e.preventDefault(); streaming ? stop() : send(); };
$('input').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};
$('input').oninput = () => {
  $('input').style.height = 'auto';
  $('input').style.height = $('input').scrollHeight + 'px';
};

// ---- Réglages -------------------------------------------------------------

$('openSettings').onclick = () => {
  $('apiKey').value = config.runpodApiKey;
  $('browserKind').value = config.browser || 'firefox';
  $('machinesJson').value = JSON.stringify(config.machines, null, 2);
  $('settings').showModal();
};
$('saveSettings').onclick = async e => {
  try {
    config.machines = JSON.parse($('machinesJson').value);
  } catch {
    e.preventDefault();
    alert('JSON des machines invalide.');
    return;
  }
  config.runpodApiKey = $('apiKey').value.trim();
  config.browser = $('browserKind').value;
  if (!config.machines.some(m => m.id === config.activeMachine)) config.activeMachine = config.machines[0].id;
  await window.api.saveConfig(config);
  renderMachines();
  refreshStatus();
};

// ---- Mode agent / auto ----------------------------------------------------

function syncSwitches() {
  $('auto').disabled = !$('agent').checked;
  if (!$('agent').checked) $('auto').checked = false;
}
$('agent').onchange = $('auto').onchange = async e => {
  if (e.target.id === 'auto' && e.target.checked &&
      !confirm("Mode Auto : le modèle exécutera ses commandes sur ce PC sans vous demander. Il peut modifier ou supprimer des fichiers. Activer ?")) {
    e.target.checked = false;
  }
  syncSwitches();
  config.agent = $('agent').checked;
  config.auto = $('auto').checked;
  await window.api.saveConfig(config);
};

// ---- Onglets --------------------------------------------------------------

let view = 'chatView';
const currentMachine = () => config.machines.find(x => x.id === machineId());

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.onclick = () => {
    view = btn.dataset.view;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== view; });
    if (view === 'monitorView') refreshMetrics();
    if (view === 'termView') loadTerminal();
  };
});

// ---- Monitoring -----------------------------------------------------------

function setBar(name, pct) {
  const el = $(`b${name}`);
  const v = pct == null ? null : Math.round(pct);
  el.style.width = `${v ?? 0}%`;
  el.className = v >= 90 ? 'crit' : v >= 75 ? 'warn' : '';
  $(`v${name}`).textContent = v == null ? '—' : `${v} %`;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

async function refreshMetrics() {
  if (view !== 'monitorView') return;
  try {
    const { pod, models } = await window.api.metrics(machineId());
    $('monitorError').textContent = '';
    const rt = pod && pod.runtime;
    const gpu = rt && rt.gpus && rt.gpus[0];
    $('mGpuName').textContent = pod ? (pod.machine && pod.machine.gpuDisplayName) || '—' : 'Machine locale';
    $('mUptime').textContent = rt ? formatDuration(rt.uptimeInSeconds) : pod ? 'Éteint' : '—';
    $('mCost').textContent = rt ? `${(rt.uptimeInSeconds / 3600 * pod.costPerHr).toFixed(2)} $` : '—';
    $('mModel').textContent = models.length
      ? models.map(x => `${x.name} (${(x.size_vram / 1e9).toFixed(1)} Go)`).join(', ')
      : 'Aucun (chargé au premier message)';
    setBar('Gpu', gpu && gpu.gpuUtilPercent);
    setBar('Vram', gpu && gpu.memoryUtilPercent);
    setBar('Cpu', rt && rt.container && rt.container.cpuPercent);
    setBar('Ram', rt && rt.container && rt.container.memoryPercent);
  } catch (err) {
    $('monitorError').textContent = cleanError(err);
  }
}
setInterval(refreshMetrics, 5000);

// ---- Terminal -------------------------------------------------------------

function loadTerminal() {
  const m = currentMachine();
  const frame = $('termFrame');
  let msg = '';
  if (!m.terminalUrl) msg = "Cette machine n'a pas de terminal configuré.";
  else if (!podRunning && m.type === 'runpod') msg = 'Allumez la machine pour ouvrir son terminal.';
  $('termPlaceholder').textContent = msg;
  frame.hidden = !!msg;
  if (!msg && frame.src !== m.terminalUrl + '/') frame.src = m.terminalUrl;
}
// Le terminal démarre une trentaine de secondes après le pod :
// recliquer sur l'onglet Terminal le recharge.
document.querySelector('[data-view="termView"]').addEventListener('dblclick', () => {
  $('termFrame').src = currentMachine().terminalUrl;
});

// ---- Démarrage ------------------------------------------------------------

(async () => {
  config = await window.api.getConfig();
  renderMachines();
  $('agent').checked = !!config.agent;
  $('auto').checked = !!config.auto;
  syncSwitches();
  newConv();
  refreshStatus();
  setInterval(refreshStatus, 10000);
})();
