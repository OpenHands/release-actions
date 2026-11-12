// Step 1 of bump-pins: resolve the pins and hand them to the caller's command as
// PIN_<NAME> environment variables (and to the publish step as one JSON output).

import {appendFileSync} from 'node:fs';
import {getJson, parseExpect, parsePins, resolveExpected} from './registry.mjs';

const pins = parsePins(process.env.BUMP_PINS ?? '');
const expect = parseExpect(process.env.BUMP_EXPECT ?? '', pins);
const versions = await resolveExpected(pins, expect, {
  getJson,
  timeoutMs: Number(process.env.BUMP_WAIT_MINUTES || 20) * 60_000,
  sleep: ms => new Promise(done => setTimeout(done, ms)),
});

for (const pin of pins) {
  console.log(`${pin.name} = ${versions[pin.name]}  (${pin.registry}:${pin.pkg}${pin.requiredBy ? `, required by ${pin.requiredBy}` : ''})`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `PIN_${pin.name}=${versions[pin.name]}\n`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `versions=${JSON.stringify(versions)}\n`);
