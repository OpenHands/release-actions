// registry.mjs against canned registry answers. Run: `npm test`.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compare, parseExpect, parsePins, resolve, resolveExpected} from './registry.mjs';

const PYPI = 'application/vnd.pypi.simple.v1+json';
const sdist = (name, version, yanked = false) => ({filename: `${name}-${version}.tar.gz`, yanked});
const wheel = (name, version, yanked = false) => ({filename: `${name}-${version}-py3-none-any.whl`, yanked});
const simple = (name, files) => ({versions: [...new Set(files.map(file => /-(\d[^-]*?)(-|\.tar\.gz)/.exec(file.filename)[1]))], files});

// A registry that answers from `docs` ({url: document}) and records each request.
function registry(docs) {
  const requests = [];
  const getJson = async (url, accept) => {
    requests.push([url, accept]);
    if (!(url in docs)) throw new Error(`GET ${url}: HTTP 404`);
    return typeof docs[url] === 'function' ? docs[url]() : docs[url];
  };
  return {getJson, requests};
}

test('parsePins reads names, registries and packages, skipping blanks and comments', () => {
  assert.deepEqual(
    parsePins('\n# the SDK\nSDK=pypi:openhands-sdk\n  EXTENSIONS = npm:@openhands/extensions  \nCORE=pypi:openhands-sdk required-by SDK\n'),
    [
      {name: 'SDK', registry: 'pypi', pkg: 'openhands-sdk', requiredBy: undefined},
      {name: 'EXTENSIONS', registry: 'npm', pkg: '@openhands/extensions', requiredBy: undefined},
      {name: 'CORE', registry: 'pypi', pkg: 'openhands-sdk', requiredBy: 'SDK'},
    ],
  );
});

test('parsePins rejects what it cannot resolve', () => {
  for (const [text, message] of [
    ['', /No pins given/],
    ['SDK=openhands-sdk', /Invalid pin/],
    ['SDK=gem:rails', /Invalid pin/],
    ['sdk=pypi:openhands-sdk', /Invalid pin name/],
    ['SDK=pypi:a\nSDK=pypi:b', /declared twice/],
    ['SDK=pypi:a required-by OTHER', /not declared/],
    ['A=npm:a\nB=pypi:b required-by A', /two PyPI pins/],
    ['A=pypi:a\nB=npm:b required-by A', /two PyPI pins/],
    ['A=pypi:a\nB=pypi:b required-by A\nC=pypi:c required-by B', /must not use required-by itself/],
  ]) {
    assert.throws(() => parsePins(text), message, text);
  }
});

test('parseExpect accepts only declared pins and stable versions', () => {
  const pins = parsePins('SDK=pypi:openhands-sdk');
  assert.deepEqual(parseExpect('', pins), {});
  assert.deepEqual(parseExpect(' SDK = 1.63.0 \n', pins), {SDK: '1.63.0'});
  for (const text of ['OTHER=1.0.0', 'SDK=1.63', 'SDK=1.63.0rc1', 'SDK', 'SDK=1.0.0=2.0.0']) {
    assert.throws(() => parseExpect(text, pins), /Invalid expect/, text);
  }
});

test('compare orders versions numerically', () => {
  assert.deepEqual(['1.9.0', '1.10.0', '1.2.10', '1.2.9'].sort(compare), ['1.2.9', '1.2.10', '1.9.0', '1.10.0']);
});

test('PyPI: the newest stable release wins, read from the index installers use', async () => {
  const {getJson, requests} = registry({
    'https://pypi.org/simple/openhands-sdk/': simple('openhands_sdk', [
      sdist('openhands_sdk', '1.9.0'), wheel('openhands_sdk', '1.9.0'),
      sdist('openhands_sdk', '1.10.0'), wheel('openhands_sdk', '1.10.0'),
      sdist('openhands_sdk', '1.11.0rc1'), sdist('openhands_sdk', '2.0.0.dev1'),
    ]),
  });
  assert.deepEqual(await resolve(parsePins('SDK=pypi:OpenHands_SDK'), getJson), {SDK: '1.10.0'});
  assert.deepEqual(requests, [['https://pypi.org/simple/openhands-sdk/', PYPI]]);
});

test('PyPI: a release whose files are all yanked is skipped', async () => {
  const {getJson} = registry({
    'https://pypi.org/simple/pkg/': simple('pkg', [
      sdist('pkg', '1.0.0'),
      // One file left: still installable.
      sdist('pkg', '1.1.0', 'broken build'), wheel('pkg', '1.1.0'),
      sdist('pkg', '1.2.0', true), wheel('pkg', '1.2.0', 'bad release'),
      // Not 1.2.0's file, although its name starts the same way.
      sdist('pkg', '1.2.0.post1'),
    ]),
  });
  assert.deepEqual(await resolve(parsePins('PKG=pypi:pkg'), getJson), {PKG: '1.1.0'});
});

test('PyPI: no stable release is an error', async () => {
  const {getJson} = registry({'https://pypi.org/simple/pkg/': simple('pkg', [sdist('pkg', '1.0.0rc1')])});
  await assert.rejects(resolve(parsePins('PKG=pypi:pkg'), getJson), /pypi:pkg has no stable release/);
});

test('npm: the latest dist-tag wins when it is a published stable release', async () => {
  const url = 'https://registry.npmjs.org/@openhands%2Fextensions';
  const {getJson, requests} = registry({[url]: {'dist-tags': {latest: '0.42.0', alpha: '0.50.0-alpha'}, versions: {'0.41.0': {}, '0.42.0': {}, '0.50.0-alpha': {}}}});
  assert.deepEqual(await resolve(parsePins('EXTENSIONS=npm:@openhands/extensions'), getJson), {EXTENSIONS: '0.42.0'});
  assert.deepEqual(requests, [[url, 'application/vnd.npm.install-v1+json']]);

  for (const doc of [{'dist-tags': {latest: '1.0.0-beta.1'}, versions: {'1.0.0-beta.1': {}}}, {'dist-tags': {latest: '1.0.0'}, versions: {}}, {}]) {
    await assert.rejects(resolve(parsePins('X=npm:x'), registry({'https://registry.npmjs.org/x': doc}).getJson), /npm:x has no stable release/);
  }
});

test('required-by resolves to the version the other pin requires, in declared order', async () => {
  const {getJson} = registry({
    'https://pypi.org/simple/openhands-automation/': simple('openhands_automation', [sdist('openhands_automation', '1.32.0'), sdist('openhands_automation', '1.32.1')]),
    'https://pypi.org/pypi/openhands-automation/1.32.1/json': {info: {requires_dist: ['fastapi>=0.1', 'openhands-workspace==1.62.0', 'openhands_sdk (==1.62.0)']}},
  });
  const versions = await resolve(parsePins('SDK=pypi:openhands-sdk required-by AUTOMATION\nAUTOMATION=pypi:openhands-automation'), getJson);
  assert.deepEqual(Object.entries(versions), [['SDK', '1.62.0'], ['AUTOMATION', '1.32.1']]);
});

test('required-by fails unless the requirement is one exact stable pin', async () => {
  for (const requirement of ['openhands-sdk>=1.62.0', 'openhands-sdk==1.62.*', 'openhands-sdk==1.62.0; extra == "sdk"', 'openhands-sdk-extra==1.62.0']) {
    const {getJson} = registry({
      'https://pypi.org/simple/app/': simple('app', [sdist('app', '2.0.0')]),
      'https://pypi.org/pypi/app/2.0.0/json': {info: {requires_dist: [requirement]}},
    });
    await assert.rejects(
      resolve(parsePins('APP=pypi:app\nSDK=pypi:openhands-sdk required-by APP'), getJson),
      /app==2\.0\.0 does not require openhands-sdk with an exact/,
      requirement,
    );
  }
});

// A clock that only moves when the code under test sleeps.
function clock() {
  let time = 0;
  const waits = [];
  return {now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, waits, log() {}};
}

test('resolveExpected waits until the expected release is served', async () => {
  const pins = parsePins('SDK=pypi:openhands-sdk');
  const answers = [[sdist('openhands_sdk', '1.62.0')], [sdist('openhands_sdk', '1.62.0')], [sdist('openhands_sdk', '1.62.0'), sdist('openhands_sdk', '1.63.0')]];
  const {getJson} = registry({'https://pypi.org/simple/openhands-sdk/': () => simple('openhands_sdk', answers.shift())});
  const time = clock();
  assert.deepEqual(await resolveExpected(pins, {SDK: '1.63.0'}, {getJson, timeoutMs: 60_000, intervalMs: 20_000, ...time}), {SDK: '1.63.0'});
  assert.deepEqual(time.waits, [20_000, 20_000]);
});

test('resolveExpected accepts a release newer than the expected one', async () => {
  const {getJson} = registry({'https://pypi.org/simple/openhands-sdk/': simple('openhands_sdk', [sdist('openhands_sdk', '1.64.0')])});
  const time = clock();
  assert.deepEqual(await resolveExpected(parsePins('SDK=pypi:openhands-sdk'), {SDK: '1.63.0'}, {getJson, timeoutMs: 60_000, ...time}), {SDK: '1.64.0'});
  assert.deepEqual(time.waits, []);
});

test('resolveExpected gives up at the deadline, naming what it was waiting for', async () => {
  const {getJson} = registry({'https://pypi.org/simple/openhands-sdk/': simple('openhands_sdk', [sdist('openhands_sdk', '1.62.0')])});
  const time = clock();
  await assert.rejects(
    resolveExpected(parsePins('SDK=pypi:openhands-sdk'), {SDK: '1.63.0'}, {getJson, timeoutMs: 60_000, intervalMs: 20_000, ...time}),
    /Timed out waiting for the expected releases: SDK is 1\.62\.0, expected 1\.63\.0/,
  );
  assert.deepEqual(time.waits, [20_000, 20_000, 20_000]);
});

test('resolveExpected keeps waiting through registry errors, but only when a release is expected', async () => {
  const pins = parsePins('APP=pypi:app\nSDK=pypi:openhands-sdk required-by APP');
  const docs = {'https://pypi.org/simple/app/': simple('app', [sdist('app', '2.0.0')])};
  // The index lists 2.0.0 before its metadata is served.
  const time = clock();
  const sleep = async ms => {
    await time.sleep(ms);
    docs['https://pypi.org/pypi/app/2.0.0/json'] = {info: {requires_dist: ['openhands-sdk==1.63.0']}};
  };
  assert.deepEqual(
    await resolveExpected(pins, {APP: '2.0.0'}, {getJson: registry(docs).getJson, timeoutMs: 60_000, ...time, sleep}),
    {APP: '2.0.0', SDK: '1.63.0'},
  );

  const quiet = clock();
  await assert.rejects(
    resolveExpected(parsePins('PKG=pypi:missing'), {}, {getJson: registry({}).getJson, timeoutMs: 60_000, ...quiet}),
    /HTTP 404/,
  );
  assert.deepEqual(quiet.waits, []);
});
