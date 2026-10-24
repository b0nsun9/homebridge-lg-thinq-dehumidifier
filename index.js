'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ThinQClient } = require('./lib/client');
const { PushConnection } = require('./lib/push');
const caps = require('./lib/capabilities');
const nativeTimer = require('./lib/native-timer');
const PLUGIN = 'homebridge-lg-thinq-dd201';
const PLATFORM = 'LGThinQDehumidifier';
const labels = {
  LOW: '低速', MID: '中速', MEDIUM: '中速', HIGH: '高速', AUTO: '自動',
  SMART_HUMIDITY: '智慧除濕', INTENSIVE_DRY: '強力乾燥',
  RAPID_HUMIDITY: '快速除濕', QUIET_HUMIDITY: '安靜除濕', CLOTHES_DRY: '衣物乾燥',
};
// 依 DD201MWE0 的 ThinQ 畫面及使用者切換後讀回的代碼核對。
const modelLabels = {
  DHUM_231006_WW: {
    SMART_HUMIDITY: '智慧除濕 Plus', QUIET_HUMIDITY: '靜音除濕',
    RAPID_HUMIDITY: '衣物乾燥', INTENSIVE_DRY: '烘鞋／衣櫥',
    MID: '中', POWER: 'Turbo', AIR_CLEAN: '自動清潔',
  },
};
// 滿水通知在「家庭」只能借用會推播的感測器類型。使用者可選；每種都用 1=觸發、0=解除。
// contact=開門感測（最安靜）、occupancy=有人感測、leak=漏水感測（Apple 會升級為緊急警示）、none=停用。
const WATER_SENSORS = {
  contact: { service: 'ContactSensor', state: 'ContactSensorState' },
  occupancy: { service: 'OccupancySensor', state: 'OccupancyDetected' },
  leak: { service: 'LeakSensor', state: 'LeakDetected' },
};

class Platform {
  constructor(log, config, api) {
    Object.assign(this, { log, config: config || {}, api });
    this.cached = []; this.devices = []; this.stopped = false;
    this.interval = Math.max(60, Number(config?.pollInterval) || 120) * 1000;
    api.on('didFinishLaunching', () => void this.launch());
    api.on('shutdown', () => {
      this.stopped = true; clearTimeout(this.retry);
      this.push?.stop(); this.devices.forEach(d => d.stop());
    });
  }
  configureAccessory(accessory) {
    this.cached.push(accessory);
    // 啟動期間不得把 Homebridge 的預設值當作實機狀態。
    for (const service of accessory.services) {
      if (service.UUID === this.api.hap.Service.AccessoryInformation.UUID) continue;
      for (const c of service.characteristics) {
        if (c.UUID === this.api.hap.Characteristic.Name.UUID || c.UUID === this.api.hap.Characteristic.ConfiguredName.UUID) continue;
        if (c.props.perms.includes('pr')) c.onGet(() => { throw new this.api.hap.HapStatusError(-70402); });
        if (c.props.perms.includes('pw')) c.onSet(() => { throw new this.api.hap.HapStatusError(-70402); });
      }
    }
  }
  async launch() {
    try {
      if (!this.client) {
        const file = path.join(this.api.user.storagePath(), 'lg-thinq-dd201-client-id');
        let id;
        try { id = fs.readFileSync(file, 'utf8').trim(); }
        catch (e) {
          if (e.code !== 'ENOENT') throw e;
          id = randomUUID(); fs.writeFileSync(file, id, { mode: 0o600, flag: 'wx' });
        }
        this.client = new ThinQClient(this.config, id);
      }
      const list = await this.client.list();
      if (!Array.isArray(list)) throw new Error('LG 設備清單格式不符預期。');
      let selected = list.filter(d => d.deviceInfo?.deviceType === 'DEVICE_DEHUMIDIFIER');
      if (this.config.deviceId) selected = selected.filter(d => d.deviceId === this.config.deviceId);
      if (selected.length !== 1) throw new Error(`找到 ${selected.length} 台符合條件的除濕機；請執行診斷並設定 deviceId。`);
      const device = selected[0], profile = await this.client.profile(device.deviceId);
      if (!caps.values(profile, 'power').includes('POWER_ON') || !caps.values(profile, 'power').includes('POWER_OFF')) {
        throw new Error('此設備未在官方 API 開放預期的開關指令，無法啟用。');
      }
      const uuid = this.api.hap.uuid.generate(`${PLUGIN}:${device.deviceId}`);
      let accessory = this.cached.find(a => a.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) accessory = new this.api.platformAccessory(this.config.name || 'LG 除濕機', uuid);
      const controller = new Device(this, accessory, device, profile);
      this.devices.push(controller);
      if (isNew) this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      else this.api.updatePlatformAccessories([accessory]);
      for (const old of this.cached.filter(a => a.UUID !== uuid)) this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [old]);
      await controller.poll();
      if (controller.notification) {
        this.push = new PushConnection(this.client, [device.deviceId],
          m => controller.message(m), online => controller.pushStatus(online), this.log);
        void this.push.start();
      } else this.log.warn('設備能力未列出 WATER_IS_FULL；本機不提供滿水通知。');
      this.log.info('外掛已初始化；請逐項比對 ThinQ App 與實機。');
    } catch (e) {
      this.log.error(`初始化失敗：${e.message}`);
      if (!this.stopped) this.retry = setTimeout(() => void this.launch(), 300000);
    }
  }
}

class Device {
  constructor(platform, accessory, info, profile) {
    Object.assign(this, { platform, accessory, info, profile });
    this.hap = platform.api.hap; this.C = this.hap.Characteristic; this.S = this.hap.Service;
    this.state = {}; this.lastUpdate = 0; this.online = false;
    this.queue = Promise.resolve(); this.bindings = []; this.wanted = new Set();
    this.failures = 0; this.eventActive = false; this.pushOnline = false; this.waterState = null;
    const information = accessory.getService(this.S.AccessoryInformation);
    information.setCharacteristic(this.C.Manufacturer, 'LG')
      .setCharacteristic(this.C.Model, info.deviceInfo.modelName || 'DD201MWE0（待核實）')
      .setCharacteristic(this.C.SerialNumber, this.hap.uuid.generate(info.deviceId))
      .setCharacteristic(this.C.FirmwareRevision, require('./package.json').version);
    const name = platform.config.name || 'LG 除濕機';
    const target = caps.range(profile);
    if (target && caps.property(profile, 'current')?.mode?.includes('r')) {
      const service = this.service(this.S.HumidifierDehumidifier, name, 'main');
      service.setPrimaryService(true);
      this.bind(service, this.C.Active, () => this.power() ? 1 : 0, v => this.write('power', v ? 'POWER_ON' : 'POWER_OFF'));
      this.bind(service, this.C.CurrentRelativeHumidity, () => this.humidity('current'));
      this.bind(service, this.C.TargetHumidifierDehumidifierState, () => 2, v => {
        if (v !== 2) throw this.error();
      }, { validValues: [2], minValue: 2, maxValue: 2 });
      // 官方介面沒有壓縮機狀態；開機僅顯示 IDLE，不推測正在除濕。
      this.bind(service, this.C.CurrentHumidifierDehumidifierState, () => this.power() ? 1 : 0);
      this.bind(service, this.C.RelativeHumidityDehumidifierThreshold, () => this.humidity('target'),
        v => this.write('target', this.normalizeTarget(v)), { minValue: 0, maxValue: 100, minStep: 1 });
    } else {
      const service = this.service(this.S.Switch, name, 'power');
      service.setPrimaryService(true);
      this.bind(service, this.C.On, () => this.power(), v => this.write('power', v ? 'POWER_ON' : 'POWER_OFF'));
      platform.log.warn('實機未提供可用的目標濕度範圍；僅建立開關與可讀感測器。');
    }
    // 每個選項獨立開關，避免把未保證順序的列舉值誤當成百分比。
    for (const [key, prefix] of [['fan', '風速'], ['mode', '模式']]) {
      for (const value of caps.values(profile, key)) {
        const display = platform.config.optionNames?.[value] || modelLabels[info.deviceInfo.modelName]?.[value] || labels[value] || `${value}（待核對）`;
        const service = this.service(this.S.Switch, `${prefix} ${display}`, `${key}:${value}`);
        this.bind(service, this.C.On, () => {
          this.assertOnline();
          if (caps.read(this.state, key) === undefined) throw this.error();
          return caps.read(this.state, key) === value;
        }, async on => {
          if (!on) throw new Error('此為選項開關；請開啟另一個選項，或使用除濕機主開關。');
          await this.write(key, value);
        });
      }
    }
    if (profile.notification?.push?.includes('WATER_IS_FULL')) {
      const choice = String(platform.config.waterFullSensor || 'contact').toLowerCase();
      const sensor = WATER_SENSORS[choice];
      if (choice === 'none') {
        platform.log.info('滿水通知已依設定停用（waterFullSensor=none）。');
      } else if (!sensor) {
        platform.log.warn(`未知的 waterFullSensor「${choice}」；停用滿水通知。可用值：contact、occupancy、leak、none。`);
      } else {
        this.waterState = this.C[sensor.state];
        this.notification = this.service(this.S[sensor.service], '水箱滿通知事件', 'water-full-event');
        this.notification.getCharacteristic(this.waterState).onGet(() => {
          if (!this.pushOnline) throw this.error();
          return this.eventActive ? 1 : 0;
        });
        this.notification.getCharacteristic(this.C.StatusFault).onGet(() => this.pushOnline ? 0 : 1);
      }
    }
    // 將目前濕度另以標準感測器提供，供「家庭」的氣候資訊使用。
    // 目標濕度仍屬於主除濕機，不把設定值偽裝成環境感測值。
    if (caps.property(profile, 'current')?.mode?.includes('r')) {
      this.bind(this.service(this.S.HumiditySensor, `${name} 目前濕度`, 'humidity'), this.C.CurrentRelativeHumidity, () => this.humidity('current'));
    }
    nativeTimer.bind(this);
    for (const service of [...accessory.services]) {
      if (service.UUID !== this.S.AccessoryInformation.UUID && !this.wanted.has(service)) accessory.removeService(service);
    }
  }
  // HomeKit 使用標準百分比範圍；實際指令依設備刻度及例外值校正。
  normalizeTarget(value) {
    const r = caps.range(this.profile);
    if (!r || typeof value !== 'number' || !Number.isFinite(value)) throw this.error();
    const allowed = [];
    for (let n = r.min; n <= r.max; n += r.step) {
      if (!r.except?.includes(n)) allowed.push(n);
    }
    if (!allowed.length) throw this.error();
    return allowed.reduce((best, n) => Math.abs(n - value) < Math.abs(best - value) ? n : best);
  }
  error() { return new this.hap.HapStatusError(-70402); }
  assertOnline() {
    if (!this.online || Date.now() - this.lastUpdate > this.platform.interval * 3) throw this.error();
  }
  power() {
    this.assertOnline();
    const value = caps.read(this.state, 'power');
    if (!['POWER_ON', 'POWER_OFF'].includes(value)) throw this.error();
    return value === 'POWER_ON';
  }
  humidity(key) {
    this.assertOnline(); const value = caps.read(this.state, key);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw this.error();
    return value;
  }
  service(type, name, subtype) {
    let service = this.accessory.getServiceById(type, subtype);
    if (!service) service = this.accessory.addService(type, name, subtype);
    const previousName = service.getCharacteristic(this.C.Name).value;
    service.setCharacteristic(this.C.Name, name);
    // Apple「家庭」以 ConfiguredName 區分同一配件內的控制項。
    // 首次升級補上名稱，之後保留使用者在「家庭」自訂的名稱。
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addCharacteristic(this.C.ConfiguredName).setValue(name);
    } else if (service.getCharacteristic(this.C.ConfiguredName).value === previousName) {
      // 只遷移舊預設名稱；與舊 Name 不同的名稱視為使用者自訂。
      service.setCharacteristic(this.C.ConfiguredName, name);
    }
    this.wanted.add(service); return service;
  }
  bind(service, type, get, set, props) {
    const characteristic = service.getCharacteristic(type);
    if (props) {
      characteristic.value = null;
      characteristic.setProps(props);
    }
    characteristic.onGet(get);
    if (set) characteristic.onSet(async value => {
      try { await set(value); }
      catch (e) { this.platform.log.warn(`控制未完成：${e.message}`); throw this.error(); }
    });
    this.bindings.push({ characteristic, get });
  }
  update() {
    for (const { characteristic, get } of this.bindings) {
      try { characteristic.updateValue(get()); } catch { characteristic.updateValue(this.error()); }
    }
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const state = await this.platform.client.state(this.info.deviceId);
        if (!state || typeof state !== 'object' || Array.isArray(state) || !state.operation) throw new Error('設備狀態回應不完整。');
        this.state = state; this.online = true; this.lastUpdate = Date.now();
        nativeTimer.reconcile(this);
        this.failures = 0; this.update();
      } catch (e) {
        this.online = false; this.failures++; this.update(); throw e;
      }
    })();
    try { await this.pending; } finally { this.pending = null; }
  }
  async poll() {
    try { await this.refresh(); } catch (e) { this.platform.log.warn(`狀態讀取失敗：${e.message}`); }
    if (!this.platform.stopped) this.timer = setTimeout(() => void this.poll(),
      Math.min(this.platform.interval * 2 ** Math.min(this.failures, 4), 1800000));
  }
  write(key, value) {
    const payload = caps.command(this.profile, key, value);
    const task = this.queue.then(async () => {
      this.assertOnline();
      await this.platform.client.control(this.info.deviceId, payload);
      // 成功僅表示 API 接受指令；讀回實際狀態，不直接捏造新狀態。
      clearTimeout(this.afterWrite);
      this.afterWrite = setTimeout(() => void this.refresh().catch(e => this.platform.log.warn(e.message)), 3000);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  pushStatus(online) {
    this.pushOnline = online;
    if (!this.notification) return;
    this.notification.updateCharacteristic(this.C.StatusFault, online ? 0 : 1);
    this.notification.updateCharacteristic(this.waterState, online ? (this.eventActive ? 1 : 0) : this.error());
  }
  writeNativeTimer(hour) {
    const payload = nativeTimer.command(this.profile, hour);
    const task = this.queue.then(async () => {
      if (this.pending) await this.pending;
      this.assertOnline();
      if (this.platform.stopped) throw new Error('Homebridge is shutting down');
      if (hour !== null && !this.power()) throw new Error('請先開啟除濕機再設定定時關機');
      const previouslyActive = this.state.sleepTimer?.relativeStopTimer === 'SET';
      await this.platform.client.control(this.info.deviceId, payload);
      this.nativeTimerPending = { hour, previouslyActive, requestedAt: Date.now() };
      // As with other controls, acknowledge acceptance but only publish state read from LG.
      clearTimeout(this.afterWrite);
      this.afterWrite = setTimeout(() => void this.refresh().catch(e => this.platform.log.warn(e.message)), 3000);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  message(message) {
    if (message.deviceId !== this.info.deviceId || message.pushCode !== 'WATER_IS_FULL' || !this.notification) return;
    this.eventActive = true;
    this.notification.updateCharacteristic(this.waterState, 1);
    this.platform.log.warn('收到水箱滿通知；請倒水並確認實機。');
    clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => {
      this.eventActive = false;
      this.notification.updateCharacteristic(this.waterState, this.pushOnline ? 0 : this.error());
    }, 10000);
  }
  stop() {
    clearTimeout(this.timer); clearTimeout(this.afterWrite); clearTimeout(this.eventTimer);
  }
}
module.exports = api => api.registerPlatform(PLUGIN, PLATFORM, Platform);
module.exports.Platform = Platform;
module.exports.Device = Device;
