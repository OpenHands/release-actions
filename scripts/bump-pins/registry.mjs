// Resolves dependency pins to the latest release that is actually published.
//
// A pin is one `NAME=<registry>:<package>` line. `pypi` and `npm` are the
// registries; only stable `X.Y.Z` releases count:
//
//   SDK=pypi:openhands-sdk
//   EXTENSIONS=npm:@openhands/extensions
//
// `required-by` follows a dependency instead of taking the newest release: the
// pin resolves to the version another pin's release requires with `==`. It keeps
// two pins that must agree in step, and holds one back until the other catches
// up (PyPI packages only):
//
//   AUTOMATION=pypi:openhands-automation
//   SDK=pypi:openhands-sdk required-by AUTOMATION

const NAME = /^[A-Z][A-Z0-9_]*$/;
const STABLE = /^\d+\.\d+\.\d+$/;
const PIN = /^([^=\s]+)\s*=\s*(pypi|npm):(\S+?)(?:\s+required-by\s+(\S+))?$/;

const normalize = name => name.toLowerCase().replace(/[-_.]+/g, '-');
const lines = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

export function compare(a, b) {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function parsePins(text) {
  const pins = lines(text).map(line => {
    const match = PIN.exec(line);
    if (!match) throw new Error(`Invalid pin "${line}": expected NAME=pypi:<package> or NAME=npm:<package>`);
    const [, name, registry, pkg, requiredBy] = match;
    if (!NAME.test(name)) throw new Error(`Invalid pin name "${name}": use upper case letters, digits and "_"`);
    return {name, registry, pkg, requiredBy};
  });
  if (!pins.length) throw new Error('No pins given');
  for (const pin of pins) {
    if (pins.filter(other => other.name === pin.name).length > 1) throw new Error(`Pin "${pin.name}" is declared twice`);
    if (!pin.requiredBy) continue;
    const parent = pins.find(other => other.name === pin.requiredBy);
    if (!parent) throw new Error(`Pin "${pin.name}" is required-by "${pin.requiredBy}", which is not declared`);
    if (parent.requiredBy || parent.registry !== 'pypi' || pin.registry !== 'pypi') {
      throw new Error(`Pin "${pin.name}": required-by needs two PyPI pins, and "${parent.name}" must not use required-by itself`);
    }
  }
  return pins;
}

// `NAME=X.Y.Z` lines: releases the caller knows were just published, to wait for.
export function parseExpect(text, pins) {
  return Object.fromEntries(lines(text).map(line => {
    const [name, version, ...rest] = line.split('=').map(part => part.trim());
    if (rest.length || !pins.some(pin => pin.name === name) || !STABLE.test(version ?? '')) {
      throw new Error(`Invalid expect "${line}": expected <declared pin name>=X.Y.Z`);
    }
    return [name, version];
  }));
}

// The index installers resolve against (PEP 691), not the JSON API, which lists
// a release before `pip` and `uv` can install it. A release is installable while
// at least one of its files is not yanked.
async function pypiLatest(pkg, getJson) {
  const index = await getJson(`https://pypi.org/simple/${normalize(pkg)}/`, 'application/vnd.pypi.simple.v1+json');
  const stable = (index.versions ?? []).filter(version => STABLE.test(version)).sort(compare).reverse();
  return stable.find(version => {
    const file = new RegExp(`-${version.replaceAll('.', '\\.')}(-|\\.tar\\.gz$|\\.zip$)`);
    return (index.files ?? []).some(({filename, yanked}) => !yanked && file.test(filename));
  });
}

async function npmLatest(pkg, getJson) {
  const doc = await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, 'application/vnd.npm.install-v1+json');
  const latest = doc['dist-tags']?.latest;
  return STABLE.test(latest ?? '') && doc.versions?.[latest] ? latest : undefined;
}

async function pypiRequirement(parent, parentVersion, pkg, getJson) {
  const doc = await getJson(`https://pypi.org/pypi/${normalize(parent)}/${parentVersion}/json`, 'application/json');
  for (const requirement of doc.info?.requires_dist ?? []) {
    const match = /^([A-Za-z0-9._-]+)\s*\(?==\s*(\d+\.\d+\.\d+)\)?\s*$/.exec(requirement);
    if (match && normalize(match[1]) === normalize(pkg)) return match[2];
  }
  throw new Error(`${parent}==${parentVersion} does not require ${pkg} with an exact "==X.Y.Z" pin`);
}

// {NAME: 'X.Y.Z'} for every pin, in the order declared.
export async function resolve(pins, getJson) {
  const versions = {};
  for (const pin of pins.filter(pin => !pin.requiredBy)) {
    const latest = await (pin.registry === 'pypi' ? pypiLatest : npmLatest)(pin.pkg, getJson);
    if (!latest) throw new Error(`${pin.registry}:${pin.pkg} has no stable release`);
    versions[pin.name] = latest;
  }
  for (const pin of pins.filter(pin => pin.requiredBy)) {
    const parent = pins.find(other => other.name === pin.requiredBy);
    versions[pin.name] = await pypiRequirement(parent.pkg, versions[parent.name], pin.pkg, getJson);
  }
  return Object.fromEntries(pins.map(pin => [pin.name, versions[pin.name]]));
}

// Resolves until every expected release (or a newer one) is visible. A registry
// serves a new release some time after the publish job reports success, so a run
// dispatched by that job would otherwise resolve the previous release and stop.
export async function resolveExpected(pins, expect, {getJson, timeoutMs, intervalMs = 20_000, sleep, now = Date.now, log = console.log}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let waiting;
    try {
      const versions = await resolve(pins, getJson);
      const behind = Object.entries(expect).filter(([name, version]) => compare(versions[name], version) < 0);
      if (!behind.length) return versions;
      waiting = behind.map(([name, version]) => `${name} is ${versions[name]}, expected ${version}`).join('; ');
    } catch (error) {
      // Without expectations there is nothing to wait for: fail on the first error.
      if (!Object.keys(expect).length) throw error;
      waiting = error.message;
    }
    if (now() >= deadline) throw new Error(`Timed out waiting for the expected releases: ${waiting}`);
    log(`Waiting: ${waiting}`);
    await sleep(intervalMs);
  }
}

// GET with three attempts, so one dropped connection does not fail the run. A
// 404 is an answer (unknown package or release), not a failure to retry.
export async function getJson(url, accept) {
  for (let attempt = 1; ; attempt++) {
    let status;
    try {
      const response = await fetch(url, {headers: {accept}});
      if (response.ok) return await response.json();
      status = response.status;
    } catch (error) {
      if (attempt === 3) throw new Error(`GET ${url}: ${error.message}`);
    }
    if (status === 404 || (status && attempt === 3)) throw new Error(`GET ${url}: HTTP ${status}`);
    await new Promise(done => setTimeout(done, 2000 * attempt));
  }
}
