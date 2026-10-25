'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ThinQClient } = require('./lib/client');
const caps = require('./lib/capabilities');

(async () => {
  const tokenFile = process.env.LG_THINQ_TOKEN_FILE;
  if (!tokenFile) throw new Error('Set LG_THINQ_TOKEN_FILE to a text file containing only the PAT.');
  const idFile = `${tokenFile}.diagnostic-client-id`;
  let id;
  try { id = fs.readFileSync(idFile, 'utf8').trim(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; id = randomUUID(); fs.writeFileSync(idFile, id, { mode: 0o600 }); }
  // Country sets the LG server region; override with LG_THINQ_COUNTRY (2-letter ISO), default NZ.
  const country = (process.env.LG_THINQ_COUNTRY || 'NZ').trim();
  const client = new ThinQClient({ tokenFile, country }, id);
  console.log(`Using country ${country.toUpperCase()} (set LG_THINQ_COUNTRY to override).`);
  const devices = (await client.list()).filter(d => d.deviceInfo?.deviceType === 'DEVICE_DEHUMIDIFIER');
  console.log(`Found ${devices.length} dehumidifier(s). The IDs below are for local config only; mask them before sharing.`);
  const results = [];
  for (const device of devices) {
    console.log(`Device ID: ${device.deviceId}`);
    const profile = await client.profile(device.deviceId);
    const state = await client.state(device.deviceId);
    // Output only the listed capability fields; no device ID, alias, PAT, or MQTT certificate.
    results.push({
      model: device.deviceInfo.modelName,
      capabilities: Object.fromEntries(Object.keys(caps.paths).map(k => [k, caps.property(profile, k)])),
      current: Object.fromEntries(Object.keys(caps.paths).map(k => [k, caps.read(state, k)])),
      nativeTimers: Object.fromEntries(['timer', 'sleepTimer'].filter(key => profile.property?.[key]).map(key => [key, { capability: profile.property[key], current: state[key] ?? null }])),
      waterFullNotification: profile.notification?.push?.includes('WATER_IS_FULL') === true,
      notifications: profile.notification?.push || [],
    });
  }
  const output = path.resolve('lg-thinq-diagnostic.json');
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  console.log(`Wrote ${output}; this run only read device data and did not control any appliance.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
