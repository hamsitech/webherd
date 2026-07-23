#!/usr/bin/env node
'use strict';

// webherd — Herd-style .test hostnames for JS dev servers.
//
// Run `webherd` inside a project under ~/workspaces/<group>/<parent>/<name>:
// it allocates a stable port, ensures a Herd nginx proxy for the project's
// hostname, and launches the repo's own `dev` script with the port injected.
// Hostnames default to <name>.test and fall back to <parent>-<name>.test when
// the bare name is ambiguous or already claimed by Herd.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const WORKSPACES = path.join(HOME, 'workspaces');
const CONFIG_DIR = path.join(HOME, '.config', 'webherd');
const REGISTRY_FILE = path.join(CONFIG_DIR, 'registry.json');
const HERD_VALET_DIR = path.join(HOME, 'Library', 'Application Support', 'Herd', 'config', 'valet');
const PORT_BLOCK_START = 3100;
const PORT_BLOCK_END = 3999;
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const UI_HOST = 'webherd';
const UI_PORT = 3098;
const UI_PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.hamsitech.webherd.ui.plist');

const log = (msg) => console.log(`[webherd] ${msg}`);
const fail = (msg) => {
  console.error(`[webherd] ${msg}`);
  process.exit(1);
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const loadRegistry = () => readJson(REGISTRY_FILE, { projects: {} });

const saveRegistry = (registry) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
};

// Identity is <parent>/<name> relative to ~/workspaces/<group>/, so two
// projects with the same folder name under different parents never collide
// in the registry.
const resolveProject = (cwd) => {
  const rel = path.relative(WORKSPACES, cwd);
  if (rel.startsWith('..')) fail(`not inside ${WORKSPACES}: ${cwd}`);
  const segments = rel.split(path.sep);
  if (segments.length < 3) fail('run webherd from a project directory (~/workspaces/<group>/<parent>/<name>)');

  return {
    key: `${segments[1]}/${segments[2]}`,
    parent: segments[1],
    name: segments[2],
    root: path.join(WORKSPACES, segments[0], segments[1], segments[2]),
  };
};

// Folder names that exist under more than one ~/workspaces/<group>/<parent>
// are ambiguous and always get the <parent>- prefix.
const isAmbiguousName = (name) => {
  let count = 0;
  for (const group of listDirs(WORKSPACES)) {
    for (const parent of listDirs(path.join(WORKSPACES, group))) {
      for (const project of listDirs(path.join(WORKSPACES, group, parent))) {
        if (project.toLowerCase() === name.toLowerCase()) count += 1;
      }
    }
  }

  return count > 1;
};

const listDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

// Hostnames already claimed inside Herd: parked site folders, linked sites,
// and existing proxies/custom nginx configs.
const herdClaimedHosts = () => {
  const claimed = new Set();
  const valetConfig = readJson(path.join(HERD_VALET_DIR, 'config.json'), { paths: [] });
  for (const parked of valetConfig.paths ?? []) {
    for (const site of listDirs(parked)) claimed.add(site.toLowerCase());
  }
  for (const entry of listDirs(path.join(HERD_VALET_DIR, 'Sites'))) claimed.add(entry.toLowerCase());
  try {
    for (const file of fs.readdirSync(path.join(HERD_VALET_DIR, 'Nginx'))) {
      claimed.add(file.replace(/\.test.*$/, '').toLowerCase());
    }
  } catch {
    /* no custom nginx dir */
  }

  return claimed;
};

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

const allocateHost = (project, registry) => {
  const taken = herdClaimedHosts();
  for (const entry of Object.values(registry.projects)) taken.add(entry.host.toLowerCase());

  const bare = slug(project.name);
  const prefixed = `${slug(project.parent)}-${bare}`;
  const host = !isAmbiguousName(project.name) && !taken.has(bare) ? bare : prefixed;
  if (taken.has(host)) fail(`hostname ${host}.test is already claimed — use \`webherd rename <name>\``);

  return host;
};

const allocatePort = (registry) => {
  const used = new Set(Object.values(registry.projects).map((p) => p.port));
  for (let port = PORT_BLOCK_START; port <= PORT_BLOCK_END; port += 1) {
    if (!used.has(port) && !isListening(port)) return port;
  }
  fail(`no free port in ${PORT_BLOCK_START}-${PORT_BLOCK_END}`);
};

const isListening = (port) => {
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });

  return res.status === 0 && res.stdout.trim().length > 0;
};

const herd = (...args) => {
  const res = spawnSync('herd', args, { encoding: 'utf8' });
  if (res.status !== 0) fail(`herd ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);

  return res.stdout;
};

const proxyExists = (host) => {
  try {
    return fs.readdirSync(path.join(HERD_VALET_DIR, 'Nginx')).some((f) => f.startsWith(`${host}.test`));
  } catch {
    return false;
  }
};

const ensureProxy = (host, port, secure) => {
  const confSecure = proxyExists(host) ? confIsSecure(host) : null;
  if (confSecure === null || confSecure !== Boolean(secure)) {
    if (confSecure !== null) herd('unproxy', host);
    herd('proxy', host, `http://127.0.0.1:${port}`, ...(secure ? ['--secure'] : []));
    log(`created Herd proxy ${secure ? 'https' : 'http'}://${host}.test -> 127.0.0.1:${port}`);
  }
  patchProxyConf(host, port);
};

const confFiles = (host) => {
  const dir = path.join(HERD_VALET_DIR, 'Nginx');
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(`${host}.test`)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

const confIsSecure = (host) =>
  confFiles(host).some((conf) => fs.readFileSync(conf, 'utf8').includes(':443 ssl'));

// Two fixes over Herd's proxy template:
// 1. Send Host: localhost upstream — dev servers (Vite & co.) reject unknown
//    hosts by default, which would force allowedHosts changes into every repo.
// 2. On secured proxies, replace the port-80 https redirect with a real
//    proxy so plain http keeps working (the Android emulator cannot trust
//    the Herd CA and must stay on http).
const patchProxyConf = (host, port) => {
  const httpLocation = `location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header   Host              localhost;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_http_version 1.1;
        proxy_read_timeout 1800;
        proxy_connect_timeout 1800;
    }`;

  let changed = false;
  for (const conf of confFiles(host)) {
    const body = fs.readFileSync(conf, 'utf8');
    const patched = body
      .replace(/proxy_set_header(\s+)Host\s+\$host;/g, 'proxy_set_header$1Host              localhost;')
      .replace(/return 301 https:\/\/\$host\$request_uri;/, httpLocation);
    if (patched !== body) {
      fs.writeFileSync(conf, patched);
      changed = true;
    }
  }
  if (changed) herd('restart', 'nginx');
};

const ensureEntry = (project) => {
  const registry = loadRegistry();
  let entry = registry.projects[project.key];
  if (!entry) {
    entry = { host: allocateHost(project, registry), port: allocatePort(registry), secure: false };
    registry.projects[project.key] = entry;
    saveRegistry(registry);
    log(`registered ${project.key} as http://${entry.host}.test (port ${entry.port})`);
  }
  ensureProxy(entry.host, entry.port, entry.secure);

  return entry;
};

// Tool-specific flags; every tool also receives PORT/HOST in the env. The
// host is pinned to 127.0.0.1 because nginx proxies there — tools that bind
// IPv6-only localhost (Vite does) would 502 behind the proxy otherwise.
const portArgs = (project, port) => {
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  const devScript = pkg.scripts?.dev ?? '';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vite || /\bvite\b/.test(devScript))
    return ['--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  if (deps.next || /\bnext\b/.test(devScript)) return ['--port', String(port), '--hostname', '127.0.0.1'];
  if (deps['@angular/cli'] || /\bng serve\b/.test(devScript))
    return ['--port', String(port), '--host', '127.0.0.1'];

  return [];
};

const packageManager = (root) => {
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';

  return 'npm';
};

const buildCommand = (project, entry, extraArgs) => {
  const pm = packageManager(project.root);
  const args = pm === 'npm' ? ['run', 'dev', '--'] : ['dev'];
  args.push(...portArgs(project, entry.port), ...extraArgs);

  return { pm, args };
};

const findProjectRoot = (key) => {
  const [parent, name] = key.split('/');
  for (const group of listDirs(WORKSPACES)) {
    const root = path.join(WORKSPACES, group, parent, name);
    if (fs.existsSync(root)) return root;
  }

  return null;
};

const projectFromKey = (key) => {
  const root = findProjectRoot(key);
  if (!root) fail(`cannot find ${key} under ${WORKSPACES}`);
  const [parent, name] = key.split('/');

  return { key, parent, name, root };
};

const logFileFor = (entry) => path.join(LOGS_DIR, `${entry.host}.log`);

// Herd-style background mode: the dev server is spawned detached into its
// own process group with output going to a per-project log file.
const startDetached = (project) => {
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  if (!pkg.scripts?.dev) fail(`${project.key} has no "dev" script`);
  const entry = ensureEntry(project);
  if (isListening(entry.port)) {
    log(`${entry.host}.test is already running on :${entry.port}`);

    return entry;
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const fd = fs.openSync(logFileFor(entry), 'a');
  const { pm, args } = buildCommand(project, entry, []);
  const child = spawn(pm, args, {
    cwd: project.root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(entry.port), HOST: '127.0.0.1' },
  });
  child.unref();
  fs.closeSync(fd);

  const registry = loadRegistry();
  registry.projects[project.key].pid = child.pid;
  saveRegistry(registry);
  log(`started ${entry.secure ? 'https' : 'http'}://${entry.host}.test (:${entry.port}) — logs: ${logFileFor(entry)}`);

  return entry;
};

const stopProject = (key) => {
  const registry = loadRegistry();
  const entry = registry.projects[key];
  if (!entry) fail(`${key} is not registered`);

  // The detached child is a process-group leader; killing the group takes
  // the package-manager wrapper and the dev server down together. Fall back
  // to whoever owns the port.
  if (entry.pid) {
    try {
      process.kill(-entry.pid, 'SIGTERM');
    } catch {
      /* group already gone */
    }
    delete entry.pid;
    saveRegistry(registry);
  }
  const res = spawnSync('lsof', ['-nP', `-iTCP:${entry.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  for (const pid of res.stdout.trim().split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  log(`stopped ${entry.host}.test`);
};

const run = (extraArgs) => {
  const project = resolveProject(process.cwd());
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  if (!pkg.scripts?.dev) fail(`${project.key} has no "dev" script`);

  const entry = ensureEntry(project);
  if (isListening(entry.port)) fail(`port ${entry.port} is already in use — is ${entry.host}.test already running?`);

  const { pm, args } = buildCommand(project, entry, extraArgs);

  log(`${entry.secure ? 'https' : 'http'}://${entry.host}.test -> ${pm} ${args.join(' ')} (port ${entry.port})`);
  const child = spawn(pm, args, {
    cwd: project.root,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(entry.port), HOST: '127.0.0.1' },
  });

  // Warn when the tool ignored the injected port (no flag support, hardcoded
  // config); the proxy would silently point at nothing.
  const check = setTimeout(() => {
    if (!isListening(entry.port)) {
      console.error(`[webherd] warning: nothing is listening on ${entry.port} yet — the dev script may have ignored PORT`);
    }
  }, 7000);
  check.unref();

  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
};

const list = () => {
  const registry = loadRegistry();
  const keys = Object.keys(registry.projects).sort();
  if (keys.length === 0) return log('no projects registered yet');
  for (const key of keys) {
    const { host, port, secure } = registry.projects[key];
    const state = isListening(port) ? 'running' : 'stopped';
    console.log(`${key.padEnd(34)} ${secure ? 'https' : 'http'}://${host}.test  :${port}  ${state}`);
  }
};

const rename = (newName) => {
  if (!newName) fail('usage: webherd rename <new-host>');
  const project = resolveProject(process.cwd());
  const registry = loadRegistry();
  const entry = registry.projects[project.key];
  if (!entry) fail(`${project.key} is not registered — run \`webherd\` first`);

  const host = slug(newName);
  const taken = herdClaimedHosts();
  for (const [key, other] of Object.entries(registry.projects)) {
    if (key !== project.key) taken.add(other.host.toLowerCase());
  }
  if (taken.has(host)) fail(`hostname ${host}.test is already claimed`);

  if (proxyExists(entry.host)) herd('unproxy', entry.host);
  entry.host = host;
  saveRegistry(registry);
  ensureProxy(host, entry.port);
  log(`renamed ${project.key} to http://${host}.test`);
};

const setSecure = (secure) => {
  const project = resolveProject(process.cwd());
  const registry = loadRegistry();
  const entry = registry.projects[project.key];
  if (!entry) fail(`${project.key} is not registered — run \`webherd\` first`);
  entry.secure = secure;
  saveRegistry(registry);
  ensureProxy(entry.host, entry.port, secure);
  log(
    secure
      ? `https://${entry.host}.test enabled (plain http stays available for the emulator)`
      : `http://${entry.host}.test is now http-only`,
  );
};

const remove = () => {
  const project = resolveProject(process.cwd());
  const registry = loadRegistry();
  const entry = registry.projects[project.key];
  if (!entry) fail(`${project.key} is not registered`);
  if (proxyExists(entry.host)) herd('unproxy', entry.host);
  delete registry.projects[project.key];
  saveRegistry(registry);
  log(`removed ${project.key} (${entry.host}.test)`);
};

// ---- dashboard ----

const stateSnapshot = () => {
  const registry = loadRegistry();

  return Object.keys(registry.projects)
    .sort()
    .map((key) => {
      const { host, port, secure } = registry.projects[key];

      return { key, host, port, secure: Boolean(secure), running: isListening(port) };
    });
};

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webherd</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1e; --bg:#f5f5f7; --card:#fff; --muted:#6e6e73; --line:#e3e3e8; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f7; --bg:#1c1c1e; --card:#2c2c2e; --muted:#98989d; --line:#3a3a3c; } }
  * { box-sizing:border-box; margin:0; }
  body { font:15px/1.5 -apple-system, "SF Pro Text", sans-serif; background:var(--bg); color:var(--fg); padding:48px 24px; }
  main { max-width:760px; margin:0 auto; }
  h1 { font-size:22px; margin-bottom:4px; }
  .sub { color:var(--muted); margin-bottom:28px; }
  .row { display:flex; align-items:center; gap:14px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 18px; margin-bottom:10px; }
  .dot { width:10px; height:10px; border-radius:50%; background:#a0a0a5; flex:none; }
  .dot.on { background:#30d158; }
  .name { font-weight:600; min-width:200px; }
  .host a { color:inherit; text-decoration:none; border-bottom:1px dotted var(--muted); }
  .meta { color:var(--muted); font-size:13px; margin-left:auto; display:flex; gap:12px; align-items:center; }
  .badge { border:1px solid var(--line); border-radius:6px; padding:1px 7px; font-size:12px; }
  button { font:600 13px/1 -apple-system, sans-serif; border:1px solid var(--line); background:transparent; color:inherit; border-radius:8px; padding:8px 14px; cursor:pointer; }
  button:hover { background:var(--bg); }
  .empty { color:var(--muted); text-align:center; padding:40px; }
</style>
</head>
<body>
<main>
  <h1>webherd</h1>
  <div class="sub">JS dev servers with Herd-style hostnames</div>
  <div id="list"><div class="empty">loading…</div></div>
</main>
<script>
const refresh = async () => {
  const projects = await (await fetch('/api/state')).json();
  const list = document.getElementById('list');
  if (!projects.length) { list.innerHTML = '<div class="empty">No projects yet — run webherd inside one.</div>'; return; }
  list.innerHTML = projects.map((p) => {
    const scheme = p.secure ? 'https' : 'http';
    return '<div class="row">' +
      '<span class="dot ' + (p.running ? 'on' : '') + '"></span>' +
      '<span class="name">' + p.key + '</span>' +
      '<span class="host"><a href="' + scheme + '://' + p.host + '.test" target="_blank">' + p.host + '.test</a></span>' +
      '<span class="meta">' + (p.secure ? '<span class="badge">https</span>' : '') + '<span>:' + p.port + '</span>' +
      '<button data-action="' + (p.running ? 'stop' : 'start') + '" data-key="' + p.key + '">' + (p.running ? 'Stop' : 'Start') + '</button></span>' +
      '</div>';
  }).join('');
};
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  await fetch('/api/' + btn.dataset.action + '?key=' + encodeURIComponent(btn.dataset.key), { method: 'POST' });
  setTimeout(refresh, 800);
});
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;

const uiServer = () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://webherd.test');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      return res.end(DASHBOARD_HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });

      return res.end(JSON.stringify(stateSnapshot()));
    }
    if (req.method === 'POST' && (url.pathname === '/api/start' || url.pathname === '/api/stop')) {
      const key = url.searchParams.get('key') ?? '';
      const registry = loadRegistry();
      if (!registry.projects[key]) {
        res.writeHead(404);

        return res.end('unknown project');
      }
      try {
        if (url.pathname === '/api/start') startDetached(projectFromKey(key));
        else stopProject(key);
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(String(e));
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(UI_PORT, '127.0.0.1', () => log(`dashboard on http://${UI_HOST}.test (:${UI_PORT})`));
};

// One-time: install the dashboard as a LaunchAgent + Herd proxy so
// http://webherd.test is always available.
const uiInstall = () => {
  const binDir = path.dirname(process.execPath);
  // Front the server with a named wrapper script so the macOS
  // background-items list shows "webherd-ui" rather than the node
  // binary's signer ("Node.js Foundation").
  const wrapperDir = path.join(CONFIG_DIR, 'bin');
  const wrapper = path.join(wrapperDir, 'webherd-ui');
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" ui-server\n`, { mode: 0o755 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hamsitech.webherd.ui</string>
  <key>ProgramArguments</key>
  <array>
    <string>${wrapper}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${binDir}:/Users/kolaybi/Library/Application Support/Herd/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/webherd-ui.log</string>
  <key>StandardOutPath</key><string>/tmp/webherd-ui.log</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(UI_PLIST), { recursive: true });
  fs.writeFileSync(UI_PLIST, plist);
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('launchctl', ['bootout', `gui/${uid}/com.hamsitech.webherd.ui`]);
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, UI_PLIST], { encoding: 'utf8' });
  if (boot.status !== 0) fail(`launchctl bootstrap failed:\n${boot.stderr}`);
  ensureProxy(UI_HOST, UI_PORT, false);
  log(`dashboard installed — http://${UI_HOST}.test`);
};

const help = () => {
  console.log(`webherd — Herd-style .test hostnames for JS dev servers

usage:
  webherd [-- <extra dev-script args>]   run the current project's dev script
  webherd list                           show registered projects
  webherd rename <new-host>              change the current project's hostname
  webherd secure | unsecure              toggle https (http stays on for emulators)
  webherd start | stop                   run the current project in the background
  webherd logs                           show the current project's background log path
  webherd ui install                     install the http://webherd.test dashboard
  webherd rm                             unregister the current project
`);
};

const [, , command, ...rest] = process.argv;
switch (command) {
  case undefined:
    run([]);
    break;
  case '--':
    run(rest);
    break;
  case 'list':
    list();
    break;
  case 'rename':
    rename(rest[0]);
    break;
  case 'start':
    startDetached(resolveProject(process.cwd()));
    break;
  case 'stop':
    stopProject(resolveProject(process.cwd()).key);
    break;
  case 'logs': {
    const proj = resolveProject(process.cwd());
    const reg = loadRegistry();
    const en = reg.projects[proj.key];
    if (!en) fail(`${proj.key} is not registered`);
    console.log(logFileFor(en));
    break;
  }
  case 'ui':
    if (rest[0] === 'install') uiInstall();
    else fail('usage: webherd ui install');
    break;
  case 'ui-server':
    uiServer();
    break;
  case 'secure':
    setSecure(true);
    break;
  case 'unsecure':
    setSecure(false);
    break;
  case 'rm':
    remove();
    break;
  case 'help':
  case '-h':
  case '--help':
    help();
    break;
  default:
    fail(`unknown command: ${command} (see \`webherd help\`)`);
}
