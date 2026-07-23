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

const ensureProxy = (host, port) => {
  if (proxyExists(host)) return;
  herd('proxy', `${host}`, `http://127.0.0.1:${port}`);
  log(`created Herd proxy http://${host}.test -> 127.0.0.1:${port}`);
};

const ensureEntry = (project) => {
  const registry = loadRegistry();
  let entry = registry.projects[project.key];
  if (!entry) {
    entry = { host: allocateHost(project, registry), port: allocatePort(registry) };
    registry.projects[project.key] = entry;
    saveRegistry(registry);
    log(`registered ${project.key} as http://${entry.host}.test (port ${entry.port})`);
  }
  ensureProxy(entry.host, entry.port);

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

const run = (extraArgs) => {
  const project = resolveProject(process.cwd());
  const pkg = readJson(path.join(project.root, 'package.json'), {});
  if (!pkg.scripts?.dev) fail(`${project.key} has no "dev" script`);

  const entry = ensureEntry(project);
  if (isListening(entry.port)) fail(`port ${entry.port} is already in use — is ${entry.host}.test already running?`);

  const pm = packageManager(project.root);
  const args = pm === 'npm' ? ['run', 'dev', '--'] : ['dev'];
  args.push(...portArgs(project, entry.port), ...extraArgs);

  log(`http://${entry.host}.test -> ${pm} ${args.join(' ')} (port ${entry.port})`);
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
    const { host, port } = registry.projects[key];
    const state = isListening(port) ? 'running' : 'stopped';
    console.log(`${key.padEnd(34)} http://${host}.test  :${port}  ${state}`);
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

const help = () => {
  console.log(`webherd — Herd-style .test hostnames for JS dev servers

usage:
  webherd [-- <extra dev-script args>]   run the current project's dev script
  webherd list                           show registered projects
  webherd rename <new-host>              change the current project's hostname
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
