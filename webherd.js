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
// Project identity derives from <root>/<group>/<parent>/<name>; override the
// root with WEBHERD_ROOT when your projects live elsewhere.
const WORKSPACES = process.env.WEBHERD_ROOT ?? path.join(HOME, 'workspaces');
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
let serverMode = false;
const fail = (msg) => {
  if (serverMode) throw new Error(msg);
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

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Parked paths, Herd-style: every direct subfolder of a parked path with a
// `dev` script is a webherd candidate. Seeded on first load from the legacy
// ~/workspaces/<group>/<parent> convention so existing registries keep
// resolving.
const loadConfig = () => {
  const existing = readJson(CONFIG_FILE, null);
  if (existing) return existing;
  const seeded = { paths: [] };
  for (const group of listDirs(WORKSPACES)) {
    for (const parent of listDirs(path.join(WORKSPACES, group))) {
      seeded.paths.push(path.join(WORKSPACES, group, parent));
    }
  }
  saveConfig(seeded);

  return seeded;
};

const saveConfig = (config) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}
`);
};

const parkedPaths = () => loadConfig().paths.filter((p) => fs.existsSync(p));

const saveRegistry = (registry) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
};

// Identity is <parent>/<name> relative to ~/workspaces/<group>/, so two
// projects with the same folder name under different parents never collide
// in the registry.
const resolveProject = (cwd) => {
  for (const parked of parkedPaths()) {
    const rel = path.relative(parked, cwd);
    if (!rel.startsWith('..') && rel !== '') {
      const name = rel.split(path.sep)[0];

      return {
        key: `${path.basename(parked)}/${name}`,
        parent: path.basename(parked),
        name,
        root: path.join(parked, name),
      };
    }
  }

  // Not under a parked path: fall back to the <root>/<group>/<parent>/<name>
  // convention and park the parent automatically (herd park semantics).
  const rel = path.relative(WORKSPACES, cwd);
  if (rel.startsWith('..')) fail(`not inside a parked path or ${WORKSPACES}: ${cwd}`);
  const segments = rel.split(path.sep);
  if (segments.length < 3) fail('run webherd from a project directory, or park its parent via the dashboard');
  const parentDir = path.join(WORKSPACES, segments[0], segments[1]);
  const config = loadConfig();
  if (!config.paths.includes(parentDir)) {
    config.paths.push(parentDir);
    saveConfig(config);
    log(`parked ${parentDir}`);
  }

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
  for (const parked of parkedPaths()) {
    for (const project of listDirs(parked)) {
      if (project.toLowerCase() === name.toLowerCase()) count += 1;
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
const portArgs = (project, port, script) => {
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  const devScript = pkg.scripts?.[script] ?? '';
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

const SCRIPT_CANDIDATES = ['dev', 'start', 'serve'];

const scriptFor = (pkg) => SCRIPT_CANDIDATES.find((name) => pkg?.scripts?.[name]) ?? null;

const buildCommand = (project, entry, extraArgs) => {
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  const script = scriptFor(pkg);
  const pm = packageManager(project.root);
  const args = pm === 'npm' ? ['run', script, '--'] : [script];
  args.push(...portArgs(project, entry.port, script), ...extraArgs);

  return { pm, args };
};

const findProjectRoot = (key) => {
  const [parent, name] = key.split('/');
  for (const parked of parkedPaths()) {
    if (path.basename(parked) === parent && fs.existsSync(path.join(parked, name))) {
      return path.join(parked, name);
    }
  }
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
  if (!scriptFor(pkg)) fail(`${project.key} has no dev/start/serve script`);
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
  if (!scriptFor(pkg)) fail(`${project.key} has no dev/start/serve script`);

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

const renameByKey = (key, newName) => {
  if (!newName) fail('usage: webherd rename <new-host>');
  const registry = loadRegistry();
  const entry = registry.projects[key];
  if (!entry) fail(`${key} is not registered — run \`webherd\` first`);

  const host = slug(newName);
  if (!host) fail(`"${newName}" does not slugify to a usable hostname`);
  const taken = herdClaimedHosts();
  taken.delete(entry.host.toLowerCase());
  for (const [other, otherEntry] of Object.entries(registry.projects)) {
    if (other !== key) taken.add(otherEntry.host.toLowerCase());
  }
  if (taken.has(host)) fail(`hostname ${host}.test is already claimed`);

  if (proxyExists(entry.host)) herd('unproxy', entry.host);
  entry.host = host;
  saveRegistry(registry);
  ensureProxy(host, entry.port, entry.secure);
  log(`renamed ${key} to ${entry.secure ? 'https' : 'http'}://${host}.test`);
};

const removeByKey = (key) => {
  const registry = loadRegistry();
  const entry = registry.projects[key];
  if (!entry) fail(`${key} is not registered`);
  try {
    if (isListening(entry.port)) stopProject(key);
  } catch {
    /* best effort */
  }
  if (proxyExists(entry.host)) herd('unproxy', entry.host);
  delete registry.projects[key];
  saveRegistry(registry);
  log(`removed ${key} (${entry.host}.test)`);
};

const setPortByKey = (key, rawPort) => {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`"${rawPort}" is not a valid port (1024-65535)`);
  const registry = loadRegistry();
  const entry = registry.projects[key];
  if (!entry) fail(`${key} is not registered`);
  if (port === entry.port) return entry;
  for (const [other, otherEntry] of Object.entries(registry.projects)) {
    if (other !== key && otherEntry.port === port) fail(`port ${port} is already used by ${other}`);
  }
  if (isListening(port)) fail(`port ${port} is already in use by another process`);

  const wasRunning = isListening(entry.port);
  if (wasRunning) stopProject(key);
  if (proxyExists(entry.host)) herd('unproxy', entry.host);
  entry.port = port;
  saveRegistry(registry);
  ensureProxy(entry.host, port, entry.secure);
  if (wasRunning) startDetached(projectFromKey(key));
  log(`${key} moved to port ${port}`);

  return entry;
};

const setSecureByKey = (key, secure) => {
  const registry = loadRegistry();
  const entry = registry.projects[key];
  if (!entry) fail(`${key} is not registered — run \`webherd\` first`);
  entry.secure = secure;
  saveRegistry(registry);
  ensureProxy(entry.host, entry.port, secure);
  log(
    secure
      ? `https://${entry.host}.test enabled (plain http stays available for the emulator)`
      : `http://${entry.host}.test is now http-only`,
  );

  return entry;
};

const setSecure = (secure) => {
  setSecureByKey(resolveProject(process.cwd()).key, secure);
};

const remove = () => removeByKey(resolveProject(process.cwd()).key);

// ---- dashboard ----

// Unregistered dev-script projects under the parked paths.
const availableProjects = (registry) => {
  const seen = new Set();
  const out = [];
  for (const parked of parkedPaths()) {
    for (const name of listDirs(parked)) {
      const key = `${path.basename(parked)}/${name}`;
      if (seen.has(key) || registry.projects[key]) continue;
      seen.add(key);
      const pkg = readJson(path.join(parked, name, 'package.json'), null);
      if (!scriptFor(pkg)) continue;
      out.push({ key, path: path.join(parked, name).replace(HOME, '~') });
    }
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
};

const stateSnapshot = () => {
  const registry = loadRegistry();
  const projects = Object.keys(registry.projects)
    .sort()
    .map((key) => {
      const { host, port, secure } = registry.projects[key];
      const root = findProjectRoot(key);

      return {
        key,
        host,
        port,
        secure: Boolean(secure),
        running: isListening(port),
        path: root ? root.replace(HOME, '~') : '(folder not found)',
      };
    });

  return {
    projects,
    available: availableProjects(registry),
    paths: loadConfig().paths.map((p) => p.replace(HOME, '~')),
  };
};

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webherd</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1e; --bg:#f5f5f7; --card:#fff; --muted:#6e6e73; --line:#e3e3e8;
          --green:#28a745; --red:#e5484d; --blue:#0a66c2; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f7; --bg:#1c1c1e; --card:#2c2c2e; --muted:#98989d; --line:#3a3a3c;
          --green:#30d158; --red:#ff453a; --blue:#409cff; } }
  * { box-sizing:border-box; margin:0; }
  body { font:15px/1.5 -apple-system, "SF Pro Text", sans-serif; background:var(--bg); color:var(--fg); padding:48px 24px; }
  main { max-width:960px; margin:0 auto; }
  h1 { font-size:22px; margin-bottom:4px; }
  .sub { color:var(--muted); margin-bottom:20px; }
  #err { display:none; align-items:center; gap:10px; background:color-mix(in srgb, var(--red) 12%, var(--card)); border:1px solid var(--red);
         border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:13px; }
  #err.show { display:flex; }
  #err button { margin-left:auto; }
  .row { display:flex; flex-direction:column; gap:10px; background:var(--card); border:1px solid var(--line);
         border-radius:12px 12px 0 0; padding:12px 18px; }
  .line { display:flex; align-items:center; gap:12px; }
  .item { margin-bottom:10px; }
  .item:not(.open) .row { border-radius:12px; }
  .dot { width:10px; height:10px; border-radius:50%; background:#a0a0a5; flex:none; }
  .dot.on { background:var(--green); }
  .name { font-weight:600; }
  .path { color:var(--muted); font-size:12px; font-family:ui-monospace, monospace; margin-left:auto; }
  .host a { color:inherit; text-decoration:none; border-bottom:1px dotted var(--muted); }
  .meta { color:var(--muted); font-size:13px; margin-left:auto; display:flex; gap:8px; align-items:center; }
  button { font:600 13px/1 -apple-system, sans-serif; border:1px solid var(--line); background:transparent; color:inherit;
           border-radius:8px; padding:7px 10px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
  button:hover { background:var(--bg); }
  button svg { width:14px; height:14px; fill:currentColor; flex:none; }
  .go { color:var(--green); border-color:color-mix(in srgb, var(--green) 45%, var(--line)); }
  .halt { color:var(--red); border-color:color-mix(in srgb, var(--red) 45%, var(--line)); }
  .scheme.on { color:var(--blue); border-color:color-mix(in srgb, var(--blue) 45%, var(--line)); }
  .danger { color:var(--red); }
  .icon-only { padding:7px; }
  body.busy button { pointer-events:none; opacity:.7; }
  button.working svg { display:none; }
  button.working::before { content:''; width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent;
                           border-radius:50%; animation:sp .7s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }
  .logs { display:none; background:#101012; color:#d5d5da; font:11px/1.5 ui-monospace, monospace; padding:12px 16px;
          border:1px solid var(--line); border-top:0; border-radius:0 0 12px 12px; max-height:280px; overflow:auto;
          white-space:pre-wrap; word-break:break-all; }
  .item.open .logs { display:block; }
  .empty { color:var(--muted); text-align:center; padding:40px; }
  #tabs { display:flex; gap:4px; margin-bottom:16px; border-bottom:1px solid var(--line); }
  .tab { border:0; border-bottom:2px solid transparent; border-radius:0; padding:8px 14px; color:var(--muted); font-weight:600; }
  .tab:hover { background:transparent; color:var(--fg); }
  .tab.active { color:var(--fg); border-bottom-color:var(--fg); }
  .tab span { margin-left:6px; font-size:11px; background:var(--line); border-radius:8px; padding:1px 7px; }
  .hint { color:var(--muted); font-size:12px; margin-bottom:10px; }
  .muted { color:var(--muted); }
  .picon svg { width:15px; height:15px; fill:var(--muted); display:block; }
</style>
</head>
<body>
<main>
  <h1>webherd</h1>
  <div class="sub">JS dev servers with Herd-style hostnames</div>
  <nav id="tabs">
    <button data-tab="projects" class="tab active">Projects</button>
    <button data-tab="available" class="tab">Available<span id="avail-count"></span></button>
    <button data-tab="paths" class="tab">Paths</button>
  </nav>
  <div id="err"><span id="err-text"></span><button data-dismiss>Dismiss</button></div>
  <div id="list"><div class="empty">loading…</div></div>
</main>
<script>
// Icons: Phosphor (phosphoricons.com, MIT), inlined as fills.
const I = {
  play: '<svg viewBox="0 0 256 256"><path d="M232.4 114.49 88.32 26.35a16 16 0 0 0-16.2-.3A15.86 15.86 0 0 0 64 39.87v176.26A15.94 15.94 0 0 0 80 232a16.07 16.07 0 0 0 8.36-2.35l144.04-88.14a15.81 15.81 0 0 0 0-27.02Z"/></svg>',
  stop: '<svg viewBox="0 0 256 256"><path d="M200 36H56a20 20 0 0 0-20 20v144a20 20 0 0 0 20 20h144a20 20 0 0 0 20-20V56a20 20 0 0 0-20-20Z"/></svg>',
  lock: '<svg viewBox="0 0 256 256"><path d="M208 80h-32V56a48 48 0 0 0-96 0v24H48a16 16 0 0 0-16 16v112a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V96a16 16 0 0 0-16-16Zm-48 0H96V56a32 32 0 0 1 64 0Z"/></svg>',
  lockOpen: '<svg viewBox="0 0 256 256"><path d="M208 80H96V56a32 32 0 0 1 64 0 8 8 0 0 0 16 0 48 48 0 0 0-96 0v24H48a16 16 0 0 0-16 16v112a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V96a16 16 0 0 0-16-16Z"/></svg>',
  logs: '<svg viewBox="0 0 256 256"><path d="M213.66 82.34l-56-56A8 8 0 0 0 152 24H56a16 16 0 0 0-16 16v176a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V88a8 8 0 0 0-2.34-5.66ZM160 51.31 188.69 80H160ZM200 216H56V40h88v48a8 8 0 0 0 8 8h48Zm-40-64a8 8 0 0 1-8 8h-48a8 8 0 0 1 0-16h48a8 8 0 0 1 8 8Zm0 32a8 8 0 0 1-8 8h-48a8 8 0 0 1 0-16h48a8 8 0 0 1 8 8Z"/></svg>',
  pencil: '<svg viewBox="0 0 256 256"><path d="M227.31 73.37 182.63 28.68a16 16 0 0 0-22.63 0L36.69 152A15.86 15.86 0 0 0 32 163.31V208a16 16 0 0 0 16 16h44.69a15.86 15.86 0 0 0 11.31-4.69L227.31 96a16 16 0 0 0 0-22.63ZM92.69 208H48v-44.69l88-88L180.69 120ZM192 108.68 147.31 64l24-24L216 84.68Z"/></svg>',
  trash: '<svg viewBox="0 0 256 256"><path d="M216 48h-40v-8a24 24 0 0 0-24-24h-48a24 24 0 0 0-24 24v8H40a8 8 0 0 0 0 16h8v144a16 16 0 0 0 16 16h128a16 16 0 0 0 16-16V64h8a8 8 0 0 0 0-16ZM96 40a8 8 0 0 1 8-8h48a8 8 0 0 1 8 8v8H96Zm96 168H64V64h128Zm-80-104v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Zm48 0v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Z"/></svg>',
  plus: '<svg viewBox="0 0 256 256"><path d="M224 128a8 8 0 0 1-8 8h-80v80a8 8 0 0 1-16 0v-80H40a8 8 0 0 1 0-16h80V40a8 8 0 0 1 16 0v80h80a8 8 0 0 1 8 8Z"/></svg>',
  minus: '<svg viewBox="0 0 256 256"><path d="M224 128a8 8 0 0 1-8 8H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8Z"/></svg>',
  folder: '<svg viewBox="0 0 256 256"><path d="M216 72h-84.69L104 44.69A15.86 15.86 0 0 0 92.69 40H40a16 16 0 0 0-16 16v144.62A15.4 15.4 0 0 0 39.38 216h177.51A15.13 15.13 0 0 0 232 200.89V88a16 16 0 0 0-16-16Z"/></svg>',
};

const API = 'http://127.0.0.1:3098';
let busy = false;
let lastState = '';
let openLogs = null;
let suggestions = null;

const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const showError = (msg) => {
  document.getElementById('err-text').textContent = msg;
  document.getElementById('err').classList.add('show');
};

let tab = 'projects';

const renderProjects = (data) => {
  const projects = data.projects;
  let html = '';
  if (!projects.length) html += '<div class="empty">No projects yet — register one from the Available tab.</div>';
  html += projects.map((p) => {
    const scheme = p.secure ? 'https' : 'http';
    const k = esc(p.key);
    return '<div class="item' + (openLogs === p.key ? ' open' : '') + '" data-item="' + k + '">' +
      '<div class="row">' +
      '<div class="line">' +
      '<span class="dot ' + (p.running ? 'on' : '') + '"></span>' +
      '<span class="name">' + k + '</span>' +
      '<span class="path">' + esc(p.path) + '</span>' +
      '</div>' +
      '<div class="line">' +
      '<span class="host"><a href="' + scheme + '://' + esc(p.host) + '.test" target="_blank">' + esc(p.host) + '.test</a></span>' +
      '<span class="meta">' +
      '<button data-action="set-port" data-key="' + k + '" data-port="' + p.port + '" title="Change port">:' + p.port + '</button>' +
      '<button class="scheme ' + (p.secure ? 'on' : '') + '" data-action="toggle-secure" data-key="' + k + '" title="Switch to ' + (p.secure ? 'http only' : 'https') + '">' + (p.secure ? I.lock : I.lockOpen) + scheme + '</button>' +
      '<button class="icon-only" data-action="logs" data-key="' + k + '" title="Logs">' + I.logs + '</button>' +
      '<button class="icon-only" data-action="rename" data-key="' + k + '" data-host="' + esc(p.host) + '" title="Rename hostname">' + I.pencil + '</button>' +
      (p.running
        ? '<button class="halt" data-action="stop" data-key="' + k + '">' + I.stop + 'Stop</button>'
        : '<button class="go" data-action="start" data-key="' + k + '">' + I.play + 'Start</button>') +
      '<button class="icon-only danger" data-action="rm" data-key="' + k + '" title="Unregister">' + I.trash + '</button>' +
      '</span></div></div>' +
      '<pre class="logs" data-logs="' + k + '"></pre>' +
      '</div>';
  }).join('');

  return html;
};

const renderAvailable = (data) => {
  if (!data.available.length) return '<div class="empty">Nothing to register — every runnable project under the parked paths already has a hostname.</div>';
  let html = '<div class="hint">Projects with a dev/start/serve script under the parked paths — add one to give it a hostname.</div>';
  html += data.available.map((p) => {
    const k = esc(p.key);
    return '<div class="item"><div class="row"><div class="line">' +
      '<span class="dot"></span>' +
      '<span class="name muted">' + k + '</span>' +
      '<span class="path">' + esc(p.path) + '</span>' +
      '<button class="go" style="margin-left:12px" data-action="register" data-key="' + k + '">' + I.plus + 'Add</button>' +
      '</div></div></div>';
  }).join('');

  return html;
};

const renderPaths = (data) => {
  let html = '<div class="hint">Direct subfolders of these directories are offered in the Available tab.</div>';
  html += data.paths.map((p) => {
    const q = esc(p);
    return '<div class="item"><div class="row"><div class="line">' +
      '<span class="picon">' + I.folder + '</span><span class="path" style="margin-left:0">' + q + '</span>' +
      '<button class="icon-only danger" style="margin-left:auto" data-action="paths-remove" data-path="' + q + '" title="Remove path">' + I.minus + '</button>' +
      '</div></div></div>';
  }).join('');
  html += '<button data-action="suggest" style="margin-top:2px">' + I.plus + 'Add path</button>';
  if (suggestions) {
    html += '<div class="hint" style="margin-top:12px">Folders with runnable projects — pick one, or use a custom path.</div>';
    html += suggestions.map((sg) => {
      const q = esc(sg.path);
      return '<div class="item"><div class="row"><div class="line">' +
        '<span class="picon">' + I.folder + '</span><span class="path" style="margin-left:0">' + q + '</span>' +
        '<span class="muted" style="font-size:12px">' + sg.projects + ' project' + (sg.projects > 1 ? 's' : '') + '</span>' +
        '<button class="go icon-only" style="margin-left:auto" data-action="paths-add" data-path="' + q + '" title="Park this path">' + I.plus + '</button>' +
        '</div></div></div>';
    }).join('');
    if (!suggestions.length) html += '<div class="hint">No unparked folders with runnable projects found.</div>';
    html += '<button data-action="paths-add-custom">' + I.pencil + 'Custom path…</button> ' +
            '<button data-action="suggest-close">Close</button>';
  }

  return html;
};

const render = (data) => {
  document.getElementById('avail-count').textContent = data.available.length || '';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const list = document.getElementById('list');
  list.innerHTML = tab === 'projects' ? renderProjects(data) : tab === 'available' ? renderAvailable(data) : renderPaths(data);
  if (tab === 'projects' && openLogs) loadLogs(openLogs);
};

let lastData = null;
const refresh = async (force) => {
  if (busy) return;
  try {
    const data = await (await fetch(API + '/api/state')).json();
    const state = JSON.stringify(data);
    if (!force && state === lastState) return;
    lastState = state;
    lastData = data;
    render(data);
  } catch {
    /* server briefly away (nginx restart) — next tick retries */
  }
};

const loadLogs = async (key) => {
  const pre = document.querySelector('[data-logs="' + CSS.escape(key) + '"]');
  if (!pre) return;
  const res = await fetch(API + '/api/logs?key=' + encodeURIComponent(key));
  pre.textContent = res.ok ? await res.text() : 'could not load logs';
  pre.scrollTop = pre.scrollHeight;
};

const act = async (action, params) => {
  busy = true;
  document.body.classList.add('busy');
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(API + '/api/' + action + '?' + qs, { method: 'POST' });
    if (!res.ok) showError(await res.text());
  } catch (e) {
    showError(String(e));
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    lastState = '';
    setTimeout(() => refresh(true), 600);
  }
};

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    if (lastData) render(lastData);
    return;
  }
  if (e.target.closest('[data-dismiss]')) {
    document.getElementById('err').classList.remove('show');
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn || busy) return;
  const key = btn.dataset.key;
  const action = btn.dataset.action;

  if (action === 'logs') {
    openLogs = openLogs === key ? null : key;
    document.querySelectorAll('.item').forEach((el) => el.classList.toggle('open', el.dataset.item === openLogs));
    if (openLogs) loadLogs(openLogs);
    return;
  }
  if (action === 'register') {
    btn.classList.add('working');
    return act('register', { key });
  }
  if (action === 'suggest') {
    btn.classList.add('working');
    suggestions = await (await fetch(API + '/api/suggestions')).json();
    if (lastData) render(lastData);
    return;
  }
  if (action === 'suggest-close') {
    suggestions = null;
    if (lastData) render(lastData);
    return;
  }
  if (action === 'paths-add') {
    btn.classList.add('working');
    suggestions = null;
    return act('paths-add', { path: btn.dataset.path });
  }
  if (action === 'paths-add-custom') {
    const p = prompt('Directory to park (its subfolders become projects):', '~/workspaces/');
    if (!p) return;
    btn.classList.add('working');
    suggestions = null;
    return act('paths-add', { path: p });
  }
  if (action === 'paths-remove') {
    btn.classList.add('working');
    return act('paths-remove', { path: btn.dataset.path });
  }
  if (action === 'set-port') {
    const next = prompt('New port for ' + key + ' (1024-65535):', btn.dataset.port);
    if (!next || next === btn.dataset.port) return;
    btn.classList.add('working');
    return act('set-port', { key, port: next });
  }
  if (action === 'rename') {
    const next = prompt('New hostname for ' + key + ' (without .test):', btn.dataset.host);
    if (!next || next === btn.dataset.host) return;
    btn.classList.add('working');
    return act('rename', { key, host: next });
  }
  if (action === 'rm') {
    if (!confirm('Unregister ' + key + ' and remove its hostname?')) return;
    btn.classList.add('working');
    return act('rm', { key });
  }
  btn.classList.add('working');
  act(action, { key });
});

refresh(true);
setInterval(() => refresh(false), 4000);
</script>
</body>
</html>`;

const uiServer = () => {
  serverMode = true;
  const http = require('http');
  const server = http.createServer((req, res) => {
    // The page is served through nginx, but API calls go directly to this
    // port so proxy rebuilds (nginx restarts) can't sever in-flight actions.
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://webherd.test');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      return res.end(DASHBOARD_HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });

      return res.end(JSON.stringify(stateSnapshot()));
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const key = url.searchParams.get('key') ?? '';
      const registry = loadRegistry();
      const entry = registry.projects[key];
      if (!entry) {
        res.writeHead(404);

        return res.end('unknown project');
      }
      let body = '(no log yet — start the project in background mode first)';
      try {
        const lines = fs.readFileSync(logFileFor(entry), 'utf8').split('\n');
        body = lines.slice(-120).join('\n');
      } catch {
        /* keep placeholder */
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });

      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/api/suggestions') {
      const parked = new Set(parkedPaths());
      const out = [];
      for (const group of listDirs(WORKSPACES)) {
        for (const parent of listDirs(path.join(WORKSPACES, group))) {
          const dir = path.join(WORKSPACES, group, parent);
          if (parked.has(dir)) continue;
          let projects = 0;
          for (const name of listDirs(dir)) {
            const pkg = readJson(path.join(dir, name, 'package.json'), null);
            if (scriptFor(pkg)) projects += 1;
          }
          if (projects > 0) out.push({ path: dir.replace(HOME, '~'), projects });
        }
      }
      out.sort((a, b) => b.projects - a.projects || a.path.localeCompare(b.path));
      res.writeHead(200, { 'Content-Type': 'application/json' });

      return res.end(JSON.stringify(out));
    }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const key = url.searchParams.get('key') ?? '';
      try {
        const root = findProjectRoot(key);
        if (!root) throw new Error(`cannot find ${key} under the parked paths`);
        const [parent, name] = key.split('/');
        ensureEntry({ key, parent, name, root });
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(e.message ?? String(e));
      }
    }
    if (req.method === 'POST' && (url.pathname === '/api/paths-add' || url.pathname === '/api/paths-remove')) {
      const raw = (url.searchParams.get('path') ?? '').replace(/^~(?=\/|$)/, HOME);
      const target = path.resolve(raw);
      try {
        const config = loadConfig();
        if (url.pathname === '/api/paths-add') {
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`${target} is not a directory`);
          if (!config.paths.includes(target)) config.paths.push(target);
        } else {
          config.paths = config.paths.filter((p) => p !== target);
        }
        saveConfig(config);
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(e.message ?? String(e));
      }
    }
    if (req.method === 'POST' && (url.pathname === '/api/rename' || url.pathname === '/api/rm')) {
      const key = url.searchParams.get('key') ?? '';
      const registry = loadRegistry();
      if (!registry.projects[key]) {
        res.writeHead(404);

        return res.end('unknown project');
      }
      try {
        if (url.pathname === '/api/rename') renameByKey(key, url.searchParams.get('host') ?? '');
        else removeByKey(key);
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(e.message ?? String(e));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/set-port') {
      const key = url.searchParams.get('key') ?? '';
      const registry = loadRegistry();
      if (!registry.projects[key]) {
        res.writeHead(404);

        return res.end('unknown project');
      }
      try {
        setPortByKey(key, url.searchParams.get('port'));
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(e.message ?? String(e));
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/toggle-secure') {
      const key = url.searchParams.get('key') ?? '';
      const registry = loadRegistry();
      if (!registry.projects[key]) {
        res.writeHead(404);

        return res.end('unknown project');
      }
      try {
        setSecureByKey(key, !registry.projects[key].secure);
        res.writeHead(200);

        return res.end('ok');
      } catch (e) {
        res.writeHead(500);

        return res.end(e.message ?? String(e));
      }
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

        return res.end(e.message ?? String(e));
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
  // The wrapper lives INSIDE webherd.app: Background-items attribution for
  // unsigned tools is path-based — items whose executable sits in an app
  // bundle inherit that bundle's name and icon.
  const wrapperDir = path.join('/Applications', 'webherd.app', 'Contents', 'MacOS');
  const wrapper = path.join(wrapperDir, 'webherd-ui');
  if (!fs.existsSync('/Applications/webherd.app/Contents/Info.plist')) {
    const build = spawnSync('bash', [path.join(__dirname, 'app', 'install.sh')], { encoding: 'utf8' });
    if (build.status !== 0) fail(`app bundle build failed:\n${build.stderr || build.stdout}`);
  }
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" ui-server\n`, { mode: 0o755 });
  spawnSync('codesign', ['-s', '-', '--force', wrapper]);
  spawnSync('codesign', ['-s', '-', '--force', '/Applications/webherd.app']);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hamsitech.webherd.ui</string>
  <key>AssociatedBundleIdentifiers</key><array><string>com.hamsitech.webherd</string></array>
  <key>ProgramArguments</key>
  <array>
    <string>${wrapper}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${binDir}:${path.join(HOME, 'Library', 'Application Support', 'Herd', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
  webherd port <number>                  move the current project to another port
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
    renameByKey(resolveProject(process.cwd()).key, rest[0]);
    break;
  case 'port':
    setPortByKey(resolveProject(process.cwd()).key, rest[0]);
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
