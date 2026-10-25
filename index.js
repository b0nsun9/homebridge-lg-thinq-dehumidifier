'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ThinQClient } = require('./lib/client');
const { PushConnection } = require('./lib/push');
const caps = require('./lib/capabilities');
const PLUGIN = 'homebridge-lg-thinq-dd201';
const PLATFORM = 'LGThinQDehumidifier';
const labels = {
  LOW: 'Low', MID: 'Medium', MEDIUM: 'Medium', HIGH: 'High', AUTO: 'Auto',
  SMART_HUMIDITY: 'Smart Dehumidify', INTENSIVE_DRY: 'Intensive Dry',
  RAPID_HUMIDITY: 'Rapid Dehumidify', QUIET_HUMIDITY: 'Quiet Dehumidify', CLOTHES_DRY: 'Clothes Dry',
};
// Checked against the DD201MWE0 ThinQ screens and the codes read back after switching.
const modelLabels = {
  DHUM_231006_WW: {
    SMART_HUMIDITY: 'Smart Dehumidify Plus', QUIET_HUMIDITY: 'Quiet Dehumidify',
    RAPID_HUMIDITY: 'Clothes Dry', INTENSIVE_DRY: 'Shoe/Closet Dry',
    MID: 'Medium', POWER: 'Turbo', AIR_CLEAN: 'Auto Clean',
  },
};
// The water-full notification can only borrow an Apple Home sensor type that pushes alerts.
// User-selectable; each uses 1 = triggered, 0 = cleared.
// contact = contact sensor (quietest), occupancy, leak (Apple raises a Critical Alert), none = disabled.
const WATER_SENSORS = {
  contact: { service: 'ContactSensor', state: 'ContactSensorState' },
  occupancy: { service: 'OccupancySensor', state: 'OccupancyDetected' },
  leak: { service: 'LeakSensor', state: 'LeakDetected' },
};
// Fan speeds ordered low-to-high for one RotationSpeed slider. AUTO sits at the bottom because the
// HomeKit slider is linear and has no separate "auto" position; unknown codes sort after the known ones.
const FAN_ORDER = ['AUTO', 'SLEEP', 'QUIET', 'SILENT', 'LOW', 'MID', 'MEDIUM', 'HIGH', 'POWER', 'TURBO'];
// Modes shown as switches unless overridden; default to Clothes Dry only (the unit is always in one mode).
const DEFAULT_MODE_SWITCHES = ['RAPID_HUMIDITY'];

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
    // During startup, never treat Homebridge's cached defaults as real device state.
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
      if (!Array.isArray(list)) throw new Error('Unexpected LG device list format.');
      let selected = list.filter(d => d.deviceInfo?.deviceType === 'DEVICE_DEHUMIDIFIER');
      if (this.config.deviceId) selected = selected.filter(d => d.deviceId === this.config.deviceId);
      if (selected.length !== 1) throw new Error(`Found ${selected.length} matching dehumidifier(s); run diagnose and set deviceId.`);
      const device = selected[0], profile = await this.client.profile(device.deviceId);
      if (!caps.values(profile, 'power').includes('POWER_ON') || !caps.values(profile, 'power').includes('POWER_OFF')) {
        throw new Error('This device does not expose the expected power commands in the official API; cannot enable.');
      }
      const uuid = this.api.hap.uuid.generate(`${PLUGIN}:${device.deviceId}`);
      let accessory = this.cached.find(a => a.UUID === uuid);
      const isNew = !accessory;
      if (!accessory) accessory = new this.api.platformAccessory(this.config.name || 'LG Dehumidifier', uuid);
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
      } else this.log.warn('Device capability does not list WATER_IS_FULL; no water-full notification.');
      this.log.info('Plugin initialized; verify each item against the ThinQ app and the real device.');
    } catch (e) {
      this.log.error(`Initialization failed: ${e.message}`);
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
      .setCharacteristic(this.C.Model, info.deviceInfo.modelName || 'DD201MWE0 (unverified)')
      .setCharacteristic(this.C.SerialNumber, this.hap.uuid.generate(info.deviceId))
      .setCharacteristic(this.C.FirmwareRevision, require('./package.json').version);
    const name = platform.config.name || 'LG Dehumidifier';
    // Fan speeds for the single RotationSpeed slider, ordered low-to-high (Auto lowest).
    this.fans = caps.values(profile, 'fan').slice()
      .sort((a, b) => (FAN_ORDER.indexOf(a) + 1 || FAN_ORDER.length + 1) - (FAN_ORDER.indexOf(b) + 1 || FAN_ORDER.length + 1));
    // Basic mode (config.basicSwitch): expose only a power on/off switch plus the readable sensors
    // (current humidity + water-full). Hides target humidity, fan, and mode controls.
    const basic = platform.config.basicSwitch === true;
    const target = caps.range(profile);
    if (!basic && target && caps.property(profile, 'current')?.mode?.includes('r')) {
      const service = this.service(this.S.HumidifierDehumidifier, name, 'main');
      service.setPrimaryService(true);
      this.bind(service, this.C.Active, () => this.power() ? 1 : 0, v => this.write('power', v ? 'POWER_ON' : 'POWER_OFF'));
      this.bind(service, this.C.CurrentRelativeHumidity, () => this.humidity('current'));
      this.bind(service, this.C.TargetHumidifierDehumidifierState, () => 2, v => {
        if (v !== 2) throw this.error();
      }, { validValues: [2], minValue: 2, maxValue: 2 });
      // The official API has no compressor state; when on, report IDLE and do not infer active dehumidifying.
      this.bind(service, this.C.CurrentHumidifierDehumidifierState, () => this.power() ? 1 : 0);
      // Constrain the Home slider to the device's own allowed values (e.g. 30-70% in 5% steps) so only
      // valid targets can be picked; normalizeTarget still snaps as a safety net (and for any excluded value).
      this.bind(service, this.C.RelativeHumidityDehumidifierThreshold, () => this.humidity('target'),
        v => this.write('target', this.normalizeTarget(v)), { minValue: target.min, maxValue: target.max, minStep: target.step });
      this.bindFan(service);
    } else {
      const service = this.service(this.S.Switch, name, 'power');
      service.setPrimaryService(true);
      this.bind(service, this.C.On, () => this.power(), v => this.write('power', v ? 'POWER_ON' : 'POWER_OFF'));
      if (!basic) platform.log.warn('The device exposes no usable target-humidity range; creating only a switch and readable sensors.');
    }
    // Mode switches: only the ones chosen in config (default Clothes Dry). The unit is always in exactly
    // one job mode, so these behave as a radio group — turning one off is rejected, turn on another instead.
    const requestedModes = basic ? []
      : platform.config.modeSwitches === undefined ? DEFAULT_MODE_SWITCHES
      : Array.isArray(platform.config.modeSwitches) ? platform.config.modeSwitches : [];
    for (const value of caps.values(profile, 'mode').filter(m => requestedModes.includes(m))) {
      const display = modelLabels[info.deviceInfo.modelName]?.[value] || labels[value] || value;
      const service = this.service(this.S.Switch, display, `mode:${value}`);
      this.bind(service, this.C.On, () => {
        this.assertOnline();
        if (caps.read(this.state, 'mode') === undefined) throw this.error();
        return caps.read(this.state, 'mode') === value;
      }, async on => {
        if (!on) throw new Error('This is a mode switch; turn on another mode instead.');
        await this.write('mode', value);
      });
    }
    if (profile.notification?.push?.includes('WATER_IS_FULL')) {
      const choice = String(platform.config.waterFullSensor || 'contact').toLowerCase();
      const sensor = WATER_SENSORS[choice];
      if (choice === 'none') {
        platform.log.info('Water-full notification disabled by config (waterFullSensor=none).');
      } else if (!sensor) {
        platform.log.warn(`Unknown waterFullSensor "${choice}"; disabling water-full notification. Allowed values: contact, occupancy, leak, none.`);
      } else {
        this.waterState = this.C[sensor.state];
        this.notification = this.service(this.S[sensor.service], 'Water Tank Full', 'water-full-event');
        this.notification.getCharacteristic(this.waterState).onGet(() => {
          if (!this.pushOnline) throw this.error();
          return this.eventActive ? 1 : 0;
        });
        this.notification.getCharacteristic(this.C.StatusFault).onGet(() => this.pushOnline ? 0 : 1);
      }
    }
    // Optional standalone humidity sensor (default on; set showHumiditySensor:false to hide). The main
    // tile already shows current humidity; this is for separate automations/history. A setpoint is never
    // disguised as an ambient reading, so target humidity stays only on the main dehumidifier.
    if (platform.config.showHumiditySensor !== false && caps.property(profile, 'current')?.mode?.includes('r')) {
      this.bind(this.service(this.S.HumiditySensor, `${name} Humidity`, 'humidity'), this.C.CurrentRelativeHumidity, () => this.humidity('current'));
    }
    for (const service of [...accessory.services]) {
      if (service.UUID !== this.S.AccessoryInformation.UUID && !this.wanted.has(service)) accessory.removeService(service);
    }
  }
  // HomeKit uses a standard percentage range; actual commands are corrected to the device's step and exception values.
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
  // Fan speed on one RotationSpeed slider: N speeds map to N evenly spaced stops (Auto is the lowest).
  bindFan(service) {
    if (!this.fans.length) return;
    const step = 100 / this.fans.length;
    this.bind(service, this.C.RotationSpeed, () => {
      this.assertOnline();
      const index = this.fans.indexOf(caps.read(this.state, 'fan'));
      if (index < 0) throw this.error();
      return (index + 1) * step;
    }, async value => {
      const index = Math.min(this.fans.length, Math.max(1, Math.round(value / step)));
      await this.write('fan', this.fans[index - 1]);
    }, { minValue: 0, maxValue: 100, minStep: step });
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
    // Apple Home uses ConfiguredName to tell controls within one accessory apart.
    // Fill the name on first upgrade, then keep any name the user set in the Home app.
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addCharacteristic(this.C.ConfiguredName).setValue(name);
    } else if (service.getCharacteristic(this.C.ConfiguredName).value === previousName) {
      // Migrate only the old default name; a name different from the old Name is treated as user-customized.
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
      catch (e) { this.platform.log.warn(`Control did not complete: ${e.message}`); throw this.error(); }
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
        if (!state || typeof state !== 'object' || Array.isArray(state) || !state.operation) throw new Error('Incomplete device state response.');
        this.state = state; this.online = true; this.lastUpdate = Date.now();
        this.failures = 0; this.update();
      } catch (e) {
        this.online = false; this.failures++; this.update(); throw e;
      }
    })();
    try { await this.pending; } finally { this.pending = null; }
  }
  async poll() {
    try { await this.refresh(); } catch (e) { this.platform.log.warn(`State read failed: ${e.message}`); }
    if (!this.platform.stopped) this.timer = setTimeout(() => void this.poll(),
      Math.min(this.platform.interval * 2 ** Math.min(this.failures, 4), 1800000));
  }
  write(key, value) {
    const payload = caps.command(this.profile, key, value);
    const task = this.queue.then(async () => {
      this.assertOnline();
      await this.platform.client.control(this.info.deviceId, payload);
      // Success only means the API accepted the command; read the real state back rather than fabricating it.
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
  message(message) {
    if (message.deviceId !== this.info.deviceId || message.pushCode !== 'WATER_IS_FULL' || !this.notification) return;
    this.eventActive = true;
    this.notification.updateCharacteristic(this.waterState, 1);
    this.platform.log.warn('Water-full notification received; empty the tank and check the device.');
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
