'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { Device, Platform } = require('../index');
const { ThinQClient } = require('../lib/client');
const caps = require('../lib/capabilities');
const enumProperty = values => ({ mode: ['r', 'w'], type: 'enum', value: { r: values, w: values } });
// Capability shape from the DHUM_231006_WW diagnostic (DD12GMWE0 / DD201MWE0), 2026-10-25.
function profile() {
  return { notification: { push: ['WATER_IS_FULL'] }, property: {
    operation: { dehumidifierOperationMode: enumProperty(['POWER_ON', 'POWER_OFF']) },
    airFlow: { windStrengthLevel: enumProperty(['LOW', 'AUTO', 'HIGH', 'MID']) },
    dehumidifierJobMode: { currentJobMode: enumProperty(['RAPID_HUMIDITY', 'AIR_CLEAN', 'QUIET_HUMIDITY', 'INTENSIVE_DRY', 'SMART_HUMIDITY']) },
    humidity: {
      currentHumidity: { type: 'range', mode: ['r'], value: { r: { min: 0, max: 100 } } },
      targetHumidity: { type: 'range', mode: ['r', 'w'], value: { w: { min: 30, max: 70, step: 5, except: [65] } } },
    },
  } };
}
function state() { return { operation: { dehumidifierOperationMode: 'POWER_ON' }, humidity: { currentHumidity: 63, targetHumidity: 50 }, airFlow: { windStrengthLevel: 'HIGH' }, dehumidifierJobMode: { currentJobMode: 'SMART_HUMIDITY' } }; }
const log = { info() {}, warn() {}, error() {} };
function setup(p = profile(), config = {}) {
  const platform = { api: { hap }, config, log, interval: 120000, client: { state: async () => state(), control: async () => {} } };
  const accessory = new hap.Accessory('Test Dehumidifier', hap.uuid.generate('unit-test'));
  const device = new Device(platform, accessory, { deviceId: 'test-id', deviceInfo: { modelName: 'Test Model' } }, p);
  return { device, accessory, platform };
}
function setupModel(config, modelName = 'DHUM_231006_WW') {
  const platform = { api: { hap }, config, log, interval: 120000, client: { state: async () => state(), control: async () => {} } };
  const accessory = new hap.Accessory('Test Dehumidifier', hap.uuid.generate(`m-${JSON.stringify(config)}`));
  const device = new Device(platform, accessory, { deviceId: 'test-id', deviceInfo: { modelName } }, profile());
  return { device, accessory, platform };
}

test('upgrade removes a legacy separate power switch and keeps the primary Active control', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  accessory.addService(hap.Service.Switch, 'LG Dehumidifier Power', 'power-control');
  const restored = new Device(platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(accessory.getServiceById(hap.Service.Switch, 'power-control'), undefined);
  const main = accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main');
  assert.equal(main.isPrimaryService, true); assert.equal(main.UUID, hap.Service.HumidifierDehumidifier.UUID);
  const sent = []; let power = 'POWER_ON';
  platform.client.state = async () => ({ ...state(), operation: { dehumidifierOperationMode: power } });
  platform.client.control = async (_id, payload) => { sent.push(payload); power = payload.operation.dehumidifierOperationMode; };
  await restored.refresh();
  const c = main.getCharacteristic(hap.Characteristic.Active);
  await c.handleSetRequest(0); await restored.refresh(); assert.equal(await c.handleGetRequest(), 0);
  await c.handleSetRequest(1); await restored.refresh(); assert.equal(await c.handleGetRequest(), 1);
  assert.deepEqual(sent, ['POWER_OFF', 'POWER_ON'].map(dehumidifierOperationMode => ({ operation: { dehumidifierOperationMode } })));
  assert.ok(restored.notification);
});

test('fan speed is one RotationSpeed slider ordered Auto, Low, Medium, High', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  const sent = []; let fan = 'HIGH';
  platform.client.state = async () => ({ ...state(), airFlow: { windStrengthLevel: fan } });
  platform.client.control = async (_id, payload) => { sent.push(payload); fan = payload.airFlow.windStrengthLevel; };
  await device.refresh();
  const c = accessory.getService(hap.Service.HumidifierDehumidifier).getCharacteristic(hap.Characteristic.RotationSpeed);
  assert.deepEqual([c.props.minValue, c.props.maxValue, c.props.minStep], [0, 100, 25]);
  assert.equal(await c.handleGetRequest(), 100); // state fan HIGH => top stop
  for (const [percent, code] of [[25, 'AUTO'], [50, 'LOW'], [75, 'MID'], [100, 'HIGH'], [0, 'AUTO'], [63, 'MID']]) {
    await c.handleSetRequest(percent);
    assert.equal(sent[sent.length - 1].airFlow.windStrengthLevel, code, `${percent}% -> ${code}`);
  }
  await device.refresh(); assert.equal(await c.handleGetRequest(), 75); // fan ended at MID
});

test('mode switches: default is Clothes Dry only, radio-group select, turning one off is rejected', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop()); await device.refresh();
  assert.ok(accessory.getServiceById(hap.Service.Switch, 'mode:RAPID_HUMIDITY'));
  for (const m of ['SMART_HUMIDITY', 'AIR_CLEAN', 'QUIET_HUMIDITY', 'INTENSIVE_DRY']) {
    assert.equal(accessory.getServiceById(hap.Service.Switch, `mode:${m}`), undefined);
  }
  const received = []; platform.client.control = async (_id, payload) => received.push(payload);
  const sw = accessory.getServiceById(hap.Service.Switch, 'mode:RAPID_HUMIDITY').getCharacteristic(hap.Characteristic.On);
  assert.equal(await sw.handleGetRequest(), false); // device is in SMART_HUMIDITY
  await assert.rejects(sw.handleSetRequest(false)); assert.equal(received.length, 0);
  await sw.handleSetRequest(true);
  assert.deepEqual(received, [{ dehumidifierJobMode: { currentJobMode: 'RAPID_HUMIDITY' } }]);
});

test('modeSwitches config picks which modes show, with model-specific names; empty shows none', t => {
  const { accessory } = setupModel({ modeSwitches: ['RAPID_HUMIDITY', 'INTENSIVE_DRY'] });
  const nameOf = v => accessory.getServiceById(hap.Service.Switch, `mode:${v}`)?.getCharacteristic(hap.Characteristic.ConfiguredName).value;
  assert.equal(nameOf('RAPID_HUMIDITY'), 'Clothes Dry');
  assert.equal(nameOf('INTENSIVE_DRY'), 'Shoe/Closet Dry');
  assert.equal(accessory.getServiceById(hap.Service.Switch, 'mode:SMART_HUMIDITY'), undefined);
  const empty = setupModel({ modeSwitches: [] });
  assert.equal(empty.accessory.services.some(s => s.subtype && s.subtype.startsWith('mode:')), false);
});

test('separate humidity sensor is on by default and hidden by showHumiditySensor:false', t => {
  const on = setup(); t.after(() => on.device.stop());
  assert.ok(on.accessory.getServiceById(hap.Service.HumiditySensor, 'humidity'));
  const off = setup(profile(), { showHumiditySensor: false }); t.after(() => off.device.stop());
  assert.equal(off.accessory.getServiceById(hap.Service.HumiditySensor, 'humidity'), undefined);
});

test('native off-timer is gone: no timer services even when the profile exposes sleepTimer', t => {
  const p = profile();
  p.property.sleepTimer = {
    relativeHourToStop: { type: 'number', mode: ['r', 'w'] },
    relativeStopTimer: { type: 'enum', mode: ['r', 'w'], value: { r: ['SET', 'UNSET'], w: ['UNSET'] } },
  };
  const { device, accessory } = setup(p); t.after(() => device.stop());
  assert.equal(accessory.services.some(s => s.subtype && s.subtype.startsWith('native-sleep-timer')), false);
  assert.equal(typeof device.writeNativeTimer, 'undefined');
});

test('capability checks for humidity range, step, exceptions, and mode', () => {
  assert.deepEqual(caps.command(profile(), 'target', 55), { humidity: { targetHumidity: 55 } });
  for (const value of [29, 71, 52, 65, NaN, '55']) assert.throws(() => caps.command(profile(), 'target', value));
  assert.throws(() => caps.command(profile(), 'mode', 'UNKNOWN'));
  assert.throws(() => caps.command(profile(), 'current', 50));
});
test('endpoint region comes from the configured country, unique message IDs, correct control headers and unwrap', async () => {
  const requests = [];
  const client = new ThinQClient({ token: 'test-secret', country: 'nz' }, 'unique-client', async (url, options) => {
    requests.push({ url, options }); return new Response(JSON.stringify({ response: { ok: true } }));
  });
  await client.control('a/b', { humidity: { targetHumidity: 50 } });
  await client.list();
  assert.equal(requests[0].url, 'https://api-kic.lgthinq.com/devices/a%2Fb/control');
  assert.equal(requests[0].options.headers['x-country'], 'NZ');
  assert.equal(requests[0].options.headers['x-conditional-control'], 'true');
  assert.notEqual(requests[0].options.headers['x-message-id'], requests[1].options.headers['x-message-id']);
});
test('country code maps to the right region host; missing or unsupported codes are rejected', async () => {
  const hostFor = async country => {
    let seen;
    const client = new ThinQClient({ token: 't', country }, 'id', async url => { seen = url; return new Response(JSON.stringify({ response: {} })); });
    await client.list();
    return seen;
  };
  assert.equal(await hostFor('NZ'), 'https://api-kic.lgthinq.com/devices');
  assert.equal(await hostFor('TW'), 'https://api-kic.lgthinq.com/devices');
  assert.equal(await hostFor('US'), 'https://api-aic.lgthinq.com/devices');
  assert.equal(await hostFor('DE'), 'https://api-eic.lgthinq.com/devices');
  assert.throws(() => new ThinQClient({ token: 't' }, 'id'));                 // missing country
  assert.throws(() => new ThinQClient({ token: 't', country: 'ZZ' }, 'id'));   // unsupported country
  assert.throws(() => new ThinQClient({ token: 't', country: 'NZL' }, 'id'));  // not two letters
});
test('API errors do not leak server text or the token, and rate-limit backs off', async () => {
  let count = 0;
  const client = new ThinQClient({ token: 'secret', country: 'NZ' }, 'id', async () => {
    count++; return new Response(JSON.stringify({ error: { code: '1306', message: 'secret' } }), { status: 429 });
  });
  await assert.rejects(client.list(), e => e.code === '1306' && !e.message.includes('secret'));
  await assert.rejects(client.list(), /rate-limited/); assert.equal(count, 1);
});
test('real HAP services build; unknown, stale, or offline humidity never reports zero', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  assert.throws(() => device.humidity('current'));
  await device.refresh(); assert.equal(device.humidity('current'), 63);
  const service = accessory.getService(hap.Service.HumidifierDehumidifier);
  assert.ok(service);
  assert.deepEqual(service.getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState).props.validValues, [2]);
  device.lastUpdate = Date.now() - 400000; assert.throws(() => device.power());
  platform.client.state = async () => { throw new Error('offline'); };
  await assert.rejects(device.refresh()); assert.throws(() => device.humidity('current'));
});
test('control is serialized; a failure does not block the next command or fabricate state', async t => {
  const { device, platform } = setup(); t.after(() => device.stop()); await device.refresh();
  const received = []; let running = 0;
  platform.client.control = async (_id, payload) => {
    assert.equal(running++, 0); await new Promise(resolve => setImmediate(resolve));
    received.push(payload); running--; if (received.length === 1) throw new Error('rejected');
  };
  const results = await Promise.allSettled([device.write('target', 45), device.write('target', 55)]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.equal(device.humidity('target'), 50); assert.equal(received.length, 2);
});
test('water-full event accepts only the target device and ends after ten seconds instead of claiming the tank is empty', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { device } = setup(); t.after(() => device.stop()); device.pushStatus(true);
  device.message({ deviceId: 'other', pushCode: 'WATER_IS_FULL' }); assert.equal(device.eventActive, false);
  device.message({ deviceId: 'test-id', pushCode: 'WATER_IS_FULL' }); assert.equal(device.eventActive, true);
  t.mock.timers.tick(10001); assert.equal(device.eventActive, false);
  device.pushStatus(false);
  assert.equal(device.notification.getCharacteristic(hap.Characteristic.StatusFault).value, 1);
});
test('no water-full capability creates no sensor; no target humidity falls back to a switch', t => {
  const p = profile(); delete p.notification; delete p.property.humidity.targetHumidity;
  const { device, accessory } = setup(p); t.after(() => device.stop());
  assert.equal(device.notification, undefined);
  assert.equal(accessory.getService(hap.Service.HumidifierDehumidifier), undefined);
  assert.ok(accessory.getServiceById(hap.Service.Switch, 'power'));
});
test('a restored cached accessory keeps its identity and rebinds services', async t => {
  const { device, accessory } = setup(); t.after(() => device.stop());
  const api = new EventEmitter(); api.hap = hap;
  const platform = new Platform(log, {}, api); platform.configureAccessory(accessory);
  assert.equal(accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main').getCharacteristic(hap.Characteristic.Name).getHandler, undefined);
  const restored = new Device(device.platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  await restored.refresh(); assert.equal(restored.humidity('current'), 63);
});
test('upgrade fills control names, keeps services and user renames, and the set is the clean layout', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  const services = accessory.services.filter(s => s.UUID !== hap.Service.AccessoryInformation.UUID);
  assert.deepEqual(services.map(s => s.subtype), ['main', 'mode:RAPID_HUMIDITY', 'water-full-event', 'humidity']);
  for (const s of services) s.removeCharacteristic(s.getCharacteristic(hap.Characteristic.ConfiguredName));
  const restoredAccessory = hap.Accessory.deserialize(hap.Accessory.serialize(accessory));
  const restored = new Device(platform, restoredAccessory, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(restoredAccessory.UUID, accessory.UUID);
  assert.deepEqual(restoredAccessory.services.filter(s => s.subtype).map(s => s.getCharacteristic(hap.Characteristic.ConfiguredName).value),
    ['LG Dehumidifier', 'Rapid Dehumidify', 'Water Tank Full', 'LG Dehumidifier Humidity']);
  const mode = restoredAccessory.getServiceById(hap.Service.Switch, 'mode:RAPID_HUMIDITY');
  await mode.getCharacteristic(hap.Characteristic.ConfiguredName).handleSetRequest('Laundry');
  const again = new Device(platform, restoredAccessory, device.info, device.profile); t.after(() => again.stop());
  assert.equal(mode.getCharacteristic(hap.Characteristic.ConfiguredName).value, 'Laundry');
});

test('humidity as the main dehumidifier and a sensor output; upgrading an old accessory keeps control services', async t => {
  const p = profile(); delete p.property.humidity.targetHumidity.value.w.except;
  p.property.humidity.currentHumidity.value.r.step = 1;
  p.property.humidity.targetHumidity.value.r = { min: 30, max: 70, step: 5 };
  const { device, accessory, platform } = setup(p); t.after(() => device.stop());
  // Simulate a 0.1.1 accessory: no primary service set, and no separate humidity sensor.
  accessory.removeService(accessory.getServiceById(hap.Service.HumiditySensor, 'humidity'));
  accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main').setPrimaryService(false);
  const oldServices = accessory.services.map(s => [s.UUID, s.subtype]);
  const cached = hap.Accessory.deserialize(hap.Accessory.serialize(accessory));
  const restored = new Device(platform, cached, device.info, p); t.after(() => restored.stop());
  platform.client.state = async () => ({ ...state(), humidity: { currentHumidity: 59, targetHumidity: 50 } });
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  await restored.refresh();
  const main = cached.getServiceById(hap.Service.HumidifierDehumidifier, 'main');
  const sensor = cached.getServiceById(hap.Service.HumiditySensor, 'humidity');
  assert.equal(main.isPrimaryService, true);
  assert.equal(cached.services.filter(s => s.isPrimaryService).length, 1);
  assert.deepEqual(cached.services.slice(0, -1).map(s => [s.UUID, s.subtype]), oldServices);
  assert.equal(main.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).value, 59);
  assert.equal(sensor.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).value, 59);
  const target = main.getCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold);
  assert.equal(target.value, 50);
  assert.deepEqual([target.props.minValue, target.props.maxValue, target.props.minStep], [0, 100, 1]);
  await target.handleSetRequest(55);
  assert.deepEqual(sent, [{ humidity: { targetHumidity: 55 } }]);
  // Polling still uses the device actual value and does not treat the setpoint as current humidity.
  await restored.refresh();
  assert.equal(target.value, 50);
  assert.equal(sensor.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).value, 59);
  platform.client.state = async () => ({ ...state(), humidity: { targetHumidity: 50 } });
  await restored.refresh();
  await assert.rejects(sensor.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest());
  const again = new Device(platform, cached, device.info, p); t.after(() => again.stop());
  assert.equal(cached.services.filter(s => s.UUID === hap.Service.HumiditySensor.UUID).length, 1);
});

test('MQTT issuance, TLS, and subscription use the official protocol; wrong-device events are filtered', async t => {
  const forge = require('node-forge');
  const { PushConnection } = require('../lib/push');
  const { generateKeyPairSync } = require('node:crypto');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const cert = forge.pki.createCertificate(); cert.publicKey = forge.pki.publicKeyFromPem(key.publicKey);
  cert.serialNumber = '01'; cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'test' }]); cert.setIssuer([{ name: 'commonName', value: 'test' }]);
  cert.sign(forge.pki.privateKeyFromPem(key.privateKey));
  const emitter = new EventEmitter(); emitter.end = () => {}; emitter.subscribe = (_topics, _options, cb) => cb(null);
  let opts, messageCount = 0;
  const connect = (_url, options) => { opts = options; return emitter; };
  const client = { clientId: 'stable-id', request: async (_method, endpoint, body) => {
    if (endpoint === 'route') return { mqttServer: 'mqtts://example.iot.ap-northeast-2.amazonaws.com:8883' };
    if (endpoint === 'client/certificate') {
      const csr = forge.pki.certificationRequestFromPem(`-----BEGIN CERTIFICATE REQUEST-----\n${body.csr}\n-----END CERTIFICATE REQUEST-----`);
      assert.equal(csr.verify(), true);
      return { result: { certificatePem: forge.pki.certificateToPem(cert), subscriptions: ['test/topic'] } };
    }
    return {};
  } };
  let online = false;
  const push = new PushConnection(client, ['test-id'], () => messageCount++, v => { online = v; }, log, connect);
  t.after(() => push.stop()); await push.start();
  assert.equal(opts.rejectUnauthorized, true); assert.equal(opts.clientId, 'stable-id');
  emitter.emit('connect'); assert.equal(online, true);
  emitter.emit('message', 'test/topic', Buffer.from('{"deviceId":"other"}'));
  emitter.emit('message', 'test/topic', Buffer.from('{"deviceId":"test-id","pushCode":"WATER_IS_FULL"}'));
  assert.equal(messageCount, 1); emitter.emit('offline'); assert.equal(online, false);
});

test('HomeKit standard humidity range sets up and down; LG commands still match the device step', async t => {
  const p = profile(); delete p.property.humidity.targetHumidity.value.w.except;
  const { device, accessory, platform } = setup(p); t.after(() => device.stop());
  let actual = 40; const sent = [];
  platform.client.state = async () => ({ ...state(), humidity: { currentHumidity: 52, targetHumidity: actual } });
  platform.client.control = async (_id, payload) => { sent.push(payload.humidity.targetHumidity); actual = payload.humidity.targetHumidity; };
  const c = accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main').getCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold);
  for (const [requested, expected] of [[60, 60], [40, 40], [65, 65], [99, 70], [1, 30], [56, 55]]) {
    await device.refresh(); await c.handleSetRequest(requested); await device.refresh();
    assert.equal(c.value, expected);
    assert.deepEqual([c.props.minValue, c.props.maxValue, c.props.minStep], [0, 100, 1]);
  }
  assert.deepEqual(sent, [60, 40, 65, 70, 30, 55]);
  assert.equal(device.normalizeTarget(50), 50);
  assert.throws(() => device.normalizeTarget(NaN));
});

function setupWith(config) {
  const platform = { api: { hap }, config, log, interval: 120000, client: { state: async () => state(), control: async () => {} } };
  const accessory = new hap.Accessory('Test Dehumidifier', hap.uuid.generate(`wf-${config.waterFullSensor || 'default'}`));
  const device = new Device(platform, accessory, { deviceId: 'test-id', deviceInfo: { modelName: 'Test Model' } }, profile());
  return { device, accessory, platform };
}
test('water-full sensor type is configurable (occupancy, leak); none disables it', t => {
  for (const [choice, svc, ch] of [
    ['contact', hap.Service.ContactSensor, hap.Characteristic.ContactSensorState],
    ['occupancy', hap.Service.OccupancySensor, hap.Characteristic.OccupancyDetected],
    ['leak', hap.Service.LeakSensor, hap.Characteristic.LeakDetected],
  ]) {
    const { device, accessory } = setupWith({ waterFullSensor: choice }); t.after(() => device.stop());
    assert.ok(device.notification, `${choice} should create a notification sensor`);
    assert.equal(device.notification.UUID, svc.UUID);
    assert.equal(device.waterState, ch);
    // Sensors other than the selected type must not exist.
    for (const other of [hap.Service.ContactSensor, hap.Service.OccupancySensor, hap.Service.LeakSensor]) {
      if (other.UUID !== svc.UUID) assert.equal(accessory.getServiceById(other, 'water-full-event'), undefined);
    }
    device.pushStatus(true);
    device.message({ deviceId: 'test-id', pushCode: 'WATER_IS_FULL' });
    assert.equal(device.notification.getCharacteristic(ch).value, 1);
  }
  const { device, accessory } = setupWith({ waterFullSensor: 'none' }); t.after(() => device.stop());
  assert.equal(device.notification, undefined);
  assert.equal(device.waterState, null);
  for (const svc of [hap.Service.ContactSensor, hap.Service.OccupancySensor, hap.Service.LeakSensor]) {
    assert.equal(accessory.getServiceById(svc, 'water-full-event'), undefined);
  }
});
test('an unknown water-full sensor type disables the notification instead of crashing', t => {
  const { device } = setupWith({ waterFullSensor: 'banana' }); t.after(() => device.stop());
  assert.equal(device.notification, undefined);
  assert.equal(device.waterState, null);
});
