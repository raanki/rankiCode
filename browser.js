// Pilotage du navigateur pour le mode agent : Firefox (WebDriver BiDi) ou Chrome (CDP).
// Le navigateur tourne avec un profil dédié à RankiCode, séparé du profil personnel.
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 9333;
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
];

const FIREFOX_PATHS = [
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
];

let browser = null;
let browserKind = null;
let page = null;

// Firefox parle WebDriver BiDi sur /session, Chrome le protocole CDP.
const BROWSERS = {
  firefox: {
    label: 'Firefox', paths: FIREFOX_PATHS, port: PORT + 1,
    args: (port, dir) => ['--no-remote', '--profile', dir, `--remote-debugging-port=${port}`, 'about:blank'],
    options: port => ({ browserWSEndpoint: `ws://127.0.0.1:${port}/session`, protocol: 'webDriverBiDi' })
  },
  chrome: {
    label: 'Chrome', paths: CHROME_PATHS, port: PORT,
    args: (port, dir) => [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
    options: port => ({ browserURL: `http://127.0.0.1:${port}` })
  }
};

async function connect(kind, profileDir) {
  if (browser && browser.connected && browserKind === kind) return;
  if (browser && browser.connected) await browser.disconnect().catch(() => {});
  browser = null;
  page = null;
  browserKind = kind;
  const b = BROWSERS[kind];
  const attach = () => puppeteer.connect({ ...b.options(b.port), defaultViewport: null });
  try {
    browser = await attach();
  } catch {
    const exe = b.paths.find(p => fs.existsSync(p));
    if (!exe) throw new Error(`${b.label} introuvable sur ce PC.`);
    fs.mkdirSync(profileDir, { recursive: true });
    spawn(exe, b.args(b.port, profileDir), { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60 && !browser; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { browser = await attach(); } catch {}
    }
    if (!browser) throw new Error(`Impossible de démarrer ${b.label}.`);
  }
  browser.on('disconnected', () => { browser = null; page = null; });
}

async function currentPage(kind, profileDir) {
  await connect(kind, profileDir);
  if (!page || page.isClosed()) {
    const pages = await browser.pages();
    page = pages[pages.length - 1] || await browser.newPage();
  }
  return page;
}

// Numérote les éléments cliquables visibles et renvoie le texte de la page.
async function readPage(p) {
  return p.evaluate(() => {
    document.querySelectorAll('[data-rk]').forEach(el => el.removeAttribute('data-rk'));
    const sel = 'a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [onclick], [contenteditable=true]';
    const items = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight * 3) continue;
      const id = ++n;
      el.setAttribute('data-rk', id);
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const kind = el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : '');
      items.push(`[${id}] ${kind} ${label}`);
    }
    const text = document.body ? document.body.innerText.replace(/\n{3,}/g, '\n\n') : '';
    return `Titre : ${document.title}\nURL : ${location.href}\n\n--- Éléments interactifs ---\n${items.join('\n')}\n\n--- Texte ---\n${text.slice(0, 12000)}`;
  });
}

const settle = p => p.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});

async function run(name, args, kind, profileDir) {
  const p = await currentPage(kind, profileDir);
  await p.bringToFront();
  switch (name) {
    case 'browser_navigate': {
      const url = /^https?:\/\//.test(args.url) ? args.url : `https://${args.url}`;
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(p);
      return { output: await readPage(p) };
    }
    case 'browser_read':
      return { output: await readPage(p) };
    case 'browser_click': {
      const el = await p.$(`[data-rk="${args.id}"]`);
      if (!el) return { output: `Élément ${args.id} introuvable : relis la page avec browser_read.` };
      await el.scrollIntoView();
      await el.click();
      await settle(p);
      return { output: await readPage(p) };
    }
    case 'browser_type': {
      const el = await p.$(`[data-rk="${args.id}"]`);
      if (!el) return { output: `Élément ${args.id} introuvable : relis la page avec browser_read.` };
      await el.click({ clickCount: 3 });
      await el.type(args.text, { delay: 15 });
      if (args.submit) { await p.keyboard.press('Enter'); await settle(p); }
      return { output: await readPage(p) };
    }
    case 'browser_scroll':
      await p.evaluate(dir => scrollBy(0, (dir === 'up' ? -1 : 1) * innerHeight * 0.8), args.direction);
      return { output: await readPage(p) };
    case 'browser_back':
      await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(p);
      return { output: await readPage(p) };
    case 'browser_screenshot': {
      const image = await p.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });
      return { output: `Capture de ${p.url()}`, image };
    }
    case 'browser_tabs': {
      const pages = await browser.pages();
      if (args.action === 'new') { page = await browser.newPage(); return { output: 'Nouvel onglet ouvert.' }; }
      if (args.action === 'switch') { page = pages[args.index]; await page.bringToFront(); return { output: await readPage(page) }; }
      const list = await Promise.all(pages.map(async (x, i) => `[${i}] ${await x.title()} — ${x.url()}`));
      return { output: list.join('\n') };
    }
  }
  throw new Error(`Outil inconnu : ${name}`);
}

const fn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TOOLS = [
  fn('browser_navigate', 'Ouvre une URL dans le navigateur et renvoie le texte de la page et ses éléments interactifs numérotés.',
    { url: { type: 'string' } }, ['url']),
  fn('browser_read', 'Relit la page courante : texte et éléments interactifs numérotés [id].'),
  fn('browser_click', "Clique sur l'élément numéroté [id] donné par browser_read.", { id: { type: 'integer' } }, ['id']),
  fn('browser_type', "Tape du texte dans le champ [id]. submit=true appuie ensuite sur Entrée.",
    { id: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['id', 'text']),
  fn('browser_scroll', 'Fait défiler la page.', { direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']),
  fn('browser_back', 'Revient à la page précédente.'),
  fn('browser_screenshot', "Prend une capture d'écran de la page pour la voir (utile si le texte ne suffit pas)."),
  fn('browser_tabs', "Gère les onglets : list (liste), new (nouvel onglet), switch (aller à l'onglet index).",
    { action: { type: 'string', enum: ['list', 'new', 'switch'] }, index: { type: 'integer' } }, ['action'])
];

module.exports = { run, TOOLS };
