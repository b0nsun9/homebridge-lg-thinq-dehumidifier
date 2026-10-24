'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { Device, Platform } = require('../index');
const { ThinQClient } = require('../lib/client');
const caps = require('../lib/capabilities');
const nativeTimer = require('../lib/native-timer');
const enumProperty = values => ({ mode: ['r', 'w'], type: 'enum', value: { r: values, w: values } });
function profile() {
  return { notification: { push: ['WATER_IS_FULL'] }, property: {
    operation: { dehumidifierOperationMode: enumProperty(['POWER_ON', 'POWER_OFF']) },
    airFlow: { windStrengthLevel: enumProperty(['LOW', 'HIGH']) },
    dehumidifierJobMode: { currentJobMode: enumProperty(['SMART_HUMIDITY', 'CLOTHES_DRY']) },
    humidity: {
      currentHumidity: { type: 'range', mode: ['r'], value: { r: { min: 0, max: 100 } } },
      targetHumidity: { type: 'range', mode: ['r', 'w'], value: { w: { min: 30, max: 70, step: 5, except: [65] } } },
    },
  } };
}
function state() { return { operation: { dehumidifierOperationMode: 'POWER_ON' }, humidity: { currentHumidity: 63, targetHumidity: 50 }, airFlow: { windStrengthLevel: 'HIGH' }, dehumidifierJobMode: { currentJobMode: 'SMART_HUMIDITY' } }; }
const log = { info() {}, warn() {}, error() {} };
function setup(p = profile()) {
  const platform = { api: { hap }, config: {}, log, interval: 120000, client: { state: async () => state(), control: async () => {} } };
  const accessory = new hap.Accessory('測試除濕機', hap.uuid.generate('unit-test'));
  const device = new Device(platform, accessory, { deviceId: 'test-id', deviceInfo: { modelName: '測試模型' } }, p);
  return { device, accessory, platform };
}

// Sleep-timer capability from the user's DHUM_231006_WW diagnostic, 2026-10-20.
function sleepProfile() {
  const p = profile();
  p.property.sleepTimer = {
    relativeHourToStop: { type: 'number', mode: ['r', 'w'] },
    relativeMinuteToStop: { type: 'number', mode: ['r'] },
    relativeStopTimer: { type: 'enum', mode: ['r', 'w'], value: { r: ['SET', 'UNSET'], w: ['UNSET'] } },
  };
  return p;
}
test('new three five seven hour switches and saved old defaults send native hour payloads', async t => {
  assert.deepEqual(nativeTimer.hours(), [1, 2, 3, 4, 5, 7, 8]);
  assert.deepEqual(nativeTimer.hours([1, 2, 4, 8]), [1, 2, 3, 4, 5, 7, 8]);
  assert.deepEqual(nativeTimer.hours([2, 5]), [2, 5]);
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  platform.client.state = async () => ({ ...state(), sleepTimer: { relativeStopTimer: 'UNSET' } });
  await device.refresh();
  for (const [hour, label] of [[3, '三'], [5, '五'], [7, '七']]) {
    const s = accessory.getServiceById(hap.Service.Switch, `native-sleep-timer:${hour}`);
    assert.equal(s.getCharacteristic(hap.Characteristic.ConfiguredName).value, `除濕機定時${label}小時`);
    await s.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  }
  assert.deepEqual(sent, [3, 5, 7].map(relativeHourToStop => ({ sleepTimer: { relativeHourToStop } })));
});
test('timer selection survives countdown and restart without switching to a shorter preset', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  let actual = { relativeStopTimer: 'UNSET' };
  platform.client.state = async () => ({ ...state(), sleepTimer: actual });
  await device.refresh(); await device.writeNativeTimer(2);
  actual = { relativeStopTimer: 'SET', relativeHourToStop: 1, relativeMinuteToStop: 59 };
  await device.refresh();
  assert.equal(nativeTimer.selection(device).hour, 2);
  device.stop(); // Simulate Homebridge offline while the device continues its own countdown.
  t.mock.timers.tick(3600000);
  actual = { relativeStopTimer: 'SET', relativeHourToStop: 0, relativeMinuteToStop: 59 };
  await device.refresh();
  assert.equal(nativeTimer.selection(device).hour, 2);
  const restored = new Device(platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  await restored.refresh();
  assert.equal(await accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:2').getCharacteristic(hap.Characteristic.On).handleGetRequest(), true);
  assert.equal(await accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:1').getCharacteristic(hap.Characteristic.On).handleGetRequest(), false);
  actual = { relativeStopTimer: 'UNSET' }; await restored.refresh();
  assert.equal(nativeTimer.selection(restored), undefined);
});
test('generic Siri timer switch can start a default duration and uniquely named presets work', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  platform.client.state = async () => ({ ...state(), sleepTimer: { relativeStopTimer: 'UNSET' } });
  await device.refresh();
  await accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer').getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(sent, [{ sleepTimer: { relativeHourToStop: 1 } }]);
  const preset = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:1');
  assert.equal(preset.getCharacteristic(hap.Characteristic.ConfiguredName).value, '除濕機定時一小時');
  assert.equal(accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer').getCharacteristic(hap.Characteristic.ConfiguredName).value, '除濕機定時');
});
test('simple Siri switch uses configured duration and migrates old defaults while preserving custom names', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  const old = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer');
  old.setCharacteristic(hap.Characteristic.Name, 'LG 除濕機定時').setCharacteristic(hap.Characteristic.ConfiguredName, 'LG 除濕機定時');
  const preset = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:1');
  preset.setCharacteristic(hap.Characteristic.ConfiguredName, '我的一小時');
  platform.config.nativeTimerDefaultHours = 2;
  const restored = new Device(platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(old.getCharacteristic(hap.Characteristic.ConfiguredName).value, '除濕機定時');
  assert.equal(preset.getCharacteristic(hap.Characteristic.ConfiguredName).value, '我的一小時');
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  platform.client.state = async () => ({ ...state(), sleepTimer: { relativeStopTimer: 'UNSET' } });
  await restored.refresh(); await old.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  assert.deepEqual(sent, [{ sleepTimer: { relativeHourToStop: 2 } }]);
});
test('upgrade removes separated power switch and retains 0.1.4 primary Active control', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  accessory.addService(hap.Service.Switch, 'LG 除濕機電源', 'power-control');
  const restored = new Device(platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(accessory.getServiceById(hap.Service.Switch, 'power-control'), undefined);
  const main = accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main');
  assert.equal(main.isPrimaryService, true); assert.equal(main.UUID, hap.Service.HumidifierDehumidifier.UUID);
  const sent = []; let power = 'POWER_ON';
  platform.client.state = async () => ({ ...state(), operation: { dehumidifierOperationMode: power }, sleepTimer: { relativeStopTimer: 'UNSET' } });
  platform.client.control = async (_id, payload) => { sent.push(payload); power = payload.operation.dehumidifierOperationMode; };
  await restored.refresh();
  const c = main.getCharacteristic(hap.Characteristic.Active);
  await c.handleSetRequest(0); await restored.refresh(); assert.equal(await c.handleGetRequest(), 0);
  await c.handleSetRequest(1); await restored.refresh(); assert.equal(await c.handleGetRequest(), 1);
  assert.deepEqual(sent, ['POWER_OFF', 'POWER_ON'].map(dehumidifierOperationMode => ({ operation: { dehumidifierOperationMode } })));
  assert.ok(restored.notification);
});
test('old readback and turning another preset off do not cancel a newly selected duration', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  let actual = { relativeStopTimer: 'SET', relativeHourToStop: 1, relativeMinuteToStop: 0 }; const sent = [];
  platform.client.state = async () => ({ ...state(), sleepTimer: actual });
  platform.client.control = async (_id, payload) => sent.push(payload);
  await device.refresh(); await device.writeNativeTimer(2);
  await device.refresh(); assert.equal(nativeTimer.selection(device).hour, 1);
  await accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:1').getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.equal(sent.length, 1);
  actual = { relativeStopTimer: 'SET', relativeHourToStop: 2, relativeMinuteToStop: 0 };
  await device.refresh(); assert.equal(nativeTimer.selection(device).hour, 2);
});
test('native sleep-timer payload writes hours only, cancellation writes UNSET only', () => {
  const p = sleepProfile();
  assert.equal(nativeTimer.supported(p), true);
  assert.deepEqual(nativeTimer.command(p, 2), { sleepTimer: { relativeHourToStop: 2 } });
  assert.deepEqual(nativeTimer.command(p, null), { sleepTimer: { relativeStopTimer: 'UNSET' } });
  for (const h of [0, -1, 1.5, NaN, '2', 25, 'SET']) assert.throws(() => nativeTimer.command(p, h));
  assert.equal(nativeTimer.supported(profile()), false);
  p.property.sleepTimer.relativeHourToStop.mode = ['r'];
  assert.equal(nativeTimer.supported(p), false);
  assert.throws(() => nativeTimer.command(p, 2));
});
test('native timer respects advertised limits and validates configurable presets', () => {
  const p = sleepProfile();
  p.property.sleepTimer.relativeHourToStop.value = { w: { min: 1, max: 7, step: 2, except: [5] } };
  assert.doesNotThrow(() => nativeTimer.command(p, 3));
  for (const h of [2, 5, 8]) assert.throws(() => nativeTimer.command(p, h));
  assert.deepEqual(nativeTimer.hours([1, 1, 3]), [1, 3]);
  for (const h of [null, [0], [1.5], ['2'], Array(13).fill(1)]) assert.throws(() => nativeTimer.hours(h));
});
test('native timer switches stay on after confirmed readback and off cancels', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  let actual = { relativeStopTimer: 'UNSET' }; const sent = [];
  platform.client.state = async () => ({ ...state(), sleepTimer: actual });
  platform.client.control = async (_id, payload) => sent.push(payload);
  await device.refresh();
  const status = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer').getCharacteristic(hap.Characteristic.On);
  const two = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer:2').getCharacteristic(hap.Characteristic.On);
  await two.handleSetRequest(true);
  assert.deepEqual(sent, [{ sleepTimer: { relativeHourToStop: 2 } }]);
  assert.equal(await status.handleGetRequest(), false);
  actual = { relativeStopTimer: 'SET', relativeHourToStop: 2, relativeMinuteToStop: 0 };
  await device.refresh(); assert.equal(await status.handleGetRequest(), true);
  assert.equal(await two.handleGetRequest(), true); assert.equal(two.value, true);
  await two.handleSetRequest(false);
  assert.deepEqual(sent[1], { sleepTimer: { relativeStopTimer: 'UNSET' } });
  actual = { relativeStopTimer: 'UNSET' }; await device.refresh();
  assert.equal(await status.handleGetRequest(), false); assert.equal(await two.handleGetRequest(), false);
  assert.equal(sent.some(p => p.operation), false);
});
test('native timer rejects offline or powered-off setting but supports cancelling when powered off', async t => {
  const { device, platform } = setup(sleepProfile()); t.after(() => device.stop());
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  await assert.rejects(device.writeNativeTimer(1)); assert.equal(sent.length, 0);
  platform.client.state = async () => ({ ...state(), operation: { dehumidifierOperationMode: 'POWER_OFF' }, sleepTimer: { relativeStopTimer: 'UNSET' } });
  await device.refresh(); await assert.rejects(device.writeNativeTimer(1));
  await device.writeNativeTimer(null); assert.equal(sent.length, 1);
});
test('native timer unknown status does not report off; rejected commands preserve actual state', async t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  await device.refresh();
  const c = accessory.getServiceById(hap.Service.Switch, 'native-sleep-timer').getCharacteristic(hap.Characteristic.On);
  await assert.rejects(c.handleGetRequest());
  platform.client.state = async () => ({ ...state(), sleepTimer: { relativeStopTimer: 'SET' } });
  await device.refresh(); platform.client.control = async () => { throw new Error('rejected'); };
  await assert.rejects(device.writeNativeTimer(4));
  assert.equal(await c.handleGetRequest(), true);
});
test('native timer cache upgrade removes legacy reservation switches and preserves notifications', t => {
  const { device, accessory, platform } = setup(sleepProfile()); t.after(() => device.stop());
  accessory.addService(hap.Service.Switch, 'Old reservation', 'off-timer:60');
  const cached = hap.Accessory.deserialize(hap.Accessory.serialize(accessory));
  const restored = new Device(platform, cached, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(cached.getServiceById(hap.Service.Switch, 'off-timer:60'), undefined);
  assert.equal(cached.services.filter(s => s.subtype === 'native-sleep-timer').length, 1);
  assert.ok(restored.notification);
  assert.equal(cached.UUID, accessory.UUID);
});

test('濕度範圍、刻度、例外值與模式均依能力檢查', () => {
  assert.deepEqual(caps.command(profile(), 'target', 55), { humidity: { targetHumidity: 55 } });
  for (const value of [29, 71, 52, 65, NaN, '55']) assert.throws(() => caps.command(profile(), 'target', value));
  assert.throws(() => caps.command(profile(), 'mode', 'UNKNOWN'));
  assert.throws(() => caps.command(profile(), 'current', 50));
});
test('端點區域依設定國家決定、每次不同訊息 ID、正確控制標頭與解包', async () => {
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
test('國家代碼對應正確區域主機，缺少或不支援的代碼會被拒絕', async () => {
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
  assert.throws(() => new ThinQClient({ token: 't' }, 'id'));                 // 缺少國家
  assert.throws(() => new ThinQClient({ token: 't', country: 'ZZ' }, 'id'));   // 不支援的國家
  assert.throws(() => new ThinQClient({ token: 't', country: 'NZL' }, 'id'));  // 非兩碼
});
test('API 錯誤不洩漏伺服器文字或權杖，並退避限流', async () => {
  let count = 0;
  const client = new ThinQClient({ token: 'secret', country: 'NZ' }, 'id', async () => {
    count++; return new Response(JSON.stringify({ error: { code: '1306', message: 'secret' } }), { status: 429 });
  });
  await assert.rejects(client.list(), e => e.code === '1306' && !e.message.includes('secret'));
  await assert.rejects(client.list(), /限流/); assert.equal(count, 1);
});
test('真實 HAP 服務可建立，未知、過期、離線濕度不會回報零', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  assert.throws(() => device.humidity('current'));
  await device.refresh(); assert.equal(device.humidity('current'), 63);
  const service = accessory.getService(hap.Service.HumidifierDehumidifier);
  assert.ok(service);
  assert.deepEqual(service.getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState).props.validValues, [2]);
  device.lastUpdate = Date.now() - 400000; assert.throws(() => device.power());
  platform.client.state = async () => { throw new Error('離線'); };
  await assert.rejects(device.refresh()); assert.throws(() => device.humidity('current'));
});
test('控制序列化，失敗不阻擋下一指令，也不捏造新狀態', async t => {
  const { device, platform } = setup(); t.after(() => device.stop()); await device.refresh();
  const received = []; let running = 0;
  platform.client.control = async (_id, payload) => {
    assert.equal(running++, 0); await new Promise(resolve => setImmediate(resolve));
    received.push(payload); running--; if (received.length === 1) throw new Error('拒絕');
  };
  const results = await Promise.allSettled([device.write('target', 45), device.write('target', 55)]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
  assert.equal(device.humidity('target'), 50); assert.equal(received.length, 2);
});
test('模式與風速開關只選擇有效選項，關閉不會誤關主機', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop()); await device.refresh();
  const received = []; platform.client.control = async (_id, payload) => received.push(payload);
  const mode = accessory.getServiceById(hap.Service.Switch, 'mode:CLOTHES_DRY').getCharacteristic(hap.Characteristic.On);
  await assert.rejects(mode.handleSetRequest(false)); assert.equal(received.length, 0);
  await mode.handleSetRequest(true); assert.deepEqual(received[0], { dehumidifierJobMode: { currentJobMode: 'CLOTHES_DRY' } });
});
test('滿水事件只接受目標設備，十秒後結束事件而非宣稱水箱已空', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { device } = setup(); t.after(() => device.stop()); device.pushStatus(true);
  device.message({ deviceId: 'other', pushCode: 'WATER_IS_FULL' }); assert.equal(device.eventActive, false);
  device.message({ deviceId: 'test-id', pushCode: 'WATER_IS_FULL' }); assert.equal(device.eventActive, true);
  t.mock.timers.tick(10001); assert.equal(device.eventActive, false);
  device.pushStatus(false);
  assert.equal(device.notification.getCharacteristic(hap.Characteristic.StatusFault).value, 1);
});
test('缺少滿水能力不建立感測器；缺少目標濕度退回開關', t => {
  const p = profile(); delete p.notification; delete p.property.humidity.targetHumidity;
  const { device, accessory } = setup(p); t.after(() => device.stop());
  assert.equal(device.notification, undefined);
  assert.equal(accessory.getService(hap.Service.HumidifierDehumidifier), undefined);
  assert.ok(accessory.getServiceById(hap.Service.Switch, 'power'));
});
test('快取配件恢復後保留識別資訊並重新綁定服務', async t => {
  const { device, accessory } = setup(); t.after(() => device.stop());
  const api = new EventEmitter(); api.hap = hap;
  const platform = new Platform(log, {}, api); platform.configureAccessory(accessory);
  assert.equal(accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main').getCharacteristic(hap.Characteristic.Name).getHandler, undefined);
  const restored = new Device(device.platform, accessory, device.info, device.profile); t.after(() => restored.stop());
  await restored.refresh(); assert.equal(restored.humidity('current'), 63);
});
test('舊版配件升級補齊控制項名稱，保留全部服務與使用者改名', async t => {
  const { device, accessory, platform } = setup(); t.after(() => device.stop());
  const services = accessory.services.filter(s => s.UUID !== hap.Service.AccessoryInformation.UUID);
  assert.equal(services.length, 7);
  for (const s of services) s.removeCharacteristic(s.getCharacteristic(hap.Characteristic.ConfiguredName));
  const restoredAccessory = hap.Accessory.deserialize(hap.Accessory.serialize(accessory));
  const restored = new Device(platform, restoredAccessory, device.info, device.profile); t.after(() => restored.stop());
  assert.equal(restoredAccessory.UUID, accessory.UUID);
  assert.deepEqual(restoredAccessory.services.map(s => [s.UUID, s.subtype]), accessory.services.map(s => [s.UUID, s.subtype]));
  assert.deepEqual(restoredAccessory.services.filter(s => s.subtype).map(s => s.getCharacteristic(hap.Characteristic.ConfiguredName).value),
    ['LG 除濕機', '風速 低速', '風速 高速', '模式 智慧除濕', '模式 衣物乾燥', '水箱滿通知事件', 'LG 除濕機 目前濕度']);
  const fan = restoredAccessory.getServiceById(hap.Service.Switch, 'fan:LOW');
  await fan.getCharacteristic(hap.Characteristic.ConfiguredName).handleSetRequest('我的低速');
  const again = new Device(platform, restoredAccessory, device.info, device.profile); t.after(() => again.stop());
  assert.equal(fan.getCharacteristic(hap.Characteristic.ConfiguredName).value, '我的低速');
});

test('濕度作為主除濕機與感測器輸出，舊配件升級保留控制服務', async t => {
  const p = profile(); delete p.property.humidity.targetHumidity.value.w.except;
  p.property.humidity.currentHumidity.value.r.step = 1;
  p.property.humidity.targetHumidity.value.r = { min: 30, max: 70, step: 5 };
  const { device, accessory, platform } = setup(p); t.after(() => device.stop());
  // 模擬 0.1.1 配件：未指定主服務，也沒有獨立濕度感測服務。
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
  // 輪詢仍以設備實際值為準，不把目標值當目前濕度。
  await restored.refresh();
  assert.equal(target.value, 50);
  assert.equal(sensor.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).value, 59);
  platform.client.state = async () => ({ ...state(), humidity: { targetHumidity: 50 } });
  await restored.refresh();
  await assert.rejects(sensor.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest());
  const again = new Device(platform, cached, device.info, p); t.after(() => again.stop());
  assert.equal(cached.services.filter(s => s.UUID === hap.Service.HumiditySensor.UUID).length, 1);
});

test('DD201 模式名稱遷移保留識別與自訂名稱，控制仍送出核對過的代碼', async t => {
  const p = profile();
  p.property.dehumidifierJobMode.currentJobMode = enumProperty(['AIR_CLEAN', 'QUIET_HUMIDITY', 'RAPID_HUMIDITY', 'INTENSIVE_DRY', 'SMART_HUMIDITY']);
  p.property.airFlow.windStrengthLevel = enumProperty(['AUTO', 'POWER', 'MID', 'LOW', 'HIGH']);
  const { device, accessory, platform } = setup(p); t.after(() => device.stop());
  const air = accessory.getServiceById(hap.Service.Switch, 'mode:AIR_CLEAN');
  air.setCharacteristic(hap.Characteristic.Name, '模式 選項 1').setCharacteristic(hap.Characteristic.ConfiguredName, '模式 選項 1');
  const power = accessory.getServiceById(hap.Service.Switch, 'fan:POWER');
  power.setCharacteristic(hap.Characteristic.Name, '風速 POWER（待核對）').setCharacteristic(hap.Characteristic.ConfiguredName, '風速 POWER（待核對）');
  accessory.getServiceById(hap.Service.Switch, 'fan:LOW').setCharacteristic(hap.Characteristic.ConfiguredName, '我的低速');
  const before = accessory.services.map(s => [s.UUID, s.subtype]);
  const cached = hap.Accessory.deserialize(hap.Accessory.serialize(accessory));
  const info = { ...device.info, deviceInfo: { modelName: 'DHUM_231006_WW' } };
  const restored = new Device(platform, cached, info, p); t.after(() => restored.stop());
  const nameOf = subtype => cached.getServiceById(hap.Service.Switch, subtype).getCharacteristic(hap.Characteristic.ConfiguredName).value;
  assert.deepEqual(cached.services.map(s => [s.UUID, s.subtype]), before);
  assert.deepEqual(['SMART_HUMIDITY', 'QUIET_HUMIDITY', 'RAPID_HUMIDITY', 'INTENSIVE_DRY', 'AIR_CLEAN'].map(v => nameOf(`mode:${v}`)),
    ['模式 智慧除濕 Plus', '模式 靜音除濕', '模式 衣物乾燥', '模式 烘鞋／衣櫥', '模式 自動清潔']);
  assert.equal(nameOf('fan:LOW'), '我的低速');
  assert.equal(nameOf('fan:MID'), '風速 中');
  assert.equal(nameOf('fan:POWER'), '風速 Turbo');
  await restored.refresh();
  const sent = []; platform.client.control = async (_id, payload) => sent.push(payload);
  for (const mode of ['RAPID_HUMIDITY', 'INTENSIVE_DRY']) {
    await cached.getServiceById(hap.Service.Switch, `mode:${mode}`).getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
  }
  assert.deepEqual(sent, ['RAPID_HUMIDITY', 'INTENSIVE_DRY'].map(currentJobMode => ({ dehumidifierJobMode: { currentJobMode } })));
  platform.config.optionNames = { RAPID_HUMIDITY: '曬衣模式' };
  const again = new Device(platform, cached, info, p); t.after(() => again.stop());
  assert.equal(nameOf('mode:RAPID_HUMIDITY'), '模式 曬衣模式');
  assert.equal(nameOf('fan:LOW'), '我的低速');
});

test('MQTT 簽發、TLS 及訂閱使用官方協定，錯誤設備事件被過濾', async t => {
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

test('HomeKit 標準濕度範圍可上下設定，LG 指令仍符合設備刻度', async t => {
  const p = profile(); delete p.property.humidity.targetHumidity.value.w.except;
  const { device, accessory, platform } = setup(p); t.after(() => device.stop());
  let actual = 40; const sent = [];
  platform.client.state = async () => ({ ...state(), humidity: { currentHumidity: 52, targetHumidity: actual } });
  platform.client.control = async (_id, payload) => { sent.push(payload.humidity.targetHumidity); actual = payload.humidity.targetHumidity; };
  const c = accessory.getServiceById(hap.Service.HumidifierDehumidifier, 'main').getCharacteristic(hap.Characteristic.RelativeHumidityDehumidifierThreshold);
  for (const [requested, expected] of [[60,60], [40,40], [65,65], [99,70], [1,30], [56,55]]) {
    await device.refresh(); await c.handleSetRequest(requested); await device.refresh();
    assert.equal(c.value, expected);
    assert.deepEqual([c.props.minValue,c.props.maxValue,c.props.minStep], [0,100,1]);
  }
  assert.deepEqual(sent,[60,40,65,70,30,55]);
  assert.equal(device.normalizeTarget(50),50);
  assert.throws(() => device.normalizeTarget(NaN));
});

function setupWith(config) {
  const platform = { api: { hap }, config, log, interval: 120000, client: { state: async () => state(), control: async () => {} } };
  const accessory = new hap.Accessory('測試除濕機', hap.uuid.generate(`wf-${config.waterFullSensor || 'default'}`));
  const device = new Device(platform, accessory, { deviceId: 'test-id', deviceInfo: { modelName: '測試模型' } }, profile());
  return { device, accessory, platform };
}
test('滿水感測器類型可設定（occupancy、leak），none 則停用', t => {
  for (const [choice, svc, ch] of [
    ['contact', hap.Service.ContactSensor, hap.Characteristic.ContactSensorState],
    ['occupancy', hap.Service.OccupancySensor, hap.Characteristic.OccupancyDetected],
    ['leak', hap.Service.LeakSensor, hap.Characteristic.LeakDetected],
  ]) {
    const { device, accessory } = setupWith({ waterFullSensor: choice }); t.after(() => device.stop());
    assert.ok(device.notification, `${choice} 應建立通知感測器`);
    assert.equal(device.notification.UUID, svc.UUID);
    assert.equal(device.waterState, ch);
    // 選定類型以外的感測器不應存在。
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
test('未知的滿水感測器類型會停用通知而非崩潰', t => {
  const { device } = setupWith({ waterFullSensor: 'banana' }); t.after(() => device.stop());
  assert.equal(device.notification, undefined);
  assert.equal(device.waterState, null);
});
