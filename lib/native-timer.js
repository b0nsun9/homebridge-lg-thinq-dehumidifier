'use strict';
// Device-hosted sleep timer. No local countdown, scheduled power command or absolute reservation.
function supported(profile) {
  const p = profile?.property?.sleepTimer;
  return ['number', 'range'].includes(p?.relativeHourToStop?.type) &&
    ['r', 'w'].every(m => p.relativeHourToStop.mode?.includes(m)) &&
    p.relativeStopTimer?.type === 'enum' &&
    ['r', 'w'].every(m => p.relativeStopTimer.mode?.includes(m)) &&
    p.relativeStopTimer.value?.w?.includes('UNSET');
}
function hours(value = [1, 2, 3, 4, 5, 7, 8]) {
  // UI limit only; actual allowed values may be narrower and LG remains authoritative.
  if (!Array.isArray(value) || value.length > 12 || value.some(h => !Number.isInteger(h) || h < 1 || h > 24)) {
    throw new Error('nativeTimerHours must contain at most 12 whole hours from 1 to 24');
  }
  const result = [...new Set(value)];
  // Migrate the old default even when Homebridge UI has saved it explicitly.
  if (result.length === 4 && [1, 2, 4, 8].every(h => result.includes(h))) return [1, 2, 3, 4, 5, 7, 8];
  return result;
}
function command(profile, hour) {
  if (!supported(profile)) throw new Error('Device does not expose a writable native sleep timer');
  if (hour === null) return { sleepTimer: { relativeStopTimer: 'UNSET' } };
  hours([hour]);
  const rule = profile.property.sleepTimer.relativeHourToStop.value?.w;
  if (rule && ((!Array.isArray(rule) && (
    (Number.isFinite(rule.min) && hour < rule.min) ||
    (Number.isFinite(rule.max) && hour > rule.max) ||
    (Number.isFinite(rule.step) && rule.step > 0 && Math.abs((hour - (rule.min ?? 0)) / rule.step - Math.round((hour - (rule.min ?? 0)) / rule.step)) > 1e-6) ||
    rule.except?.includes(hour))) || (Array.isArray(rule) && !rule.includes(hour)))) {
    throw new Error('Requested timer duration is outside the device profile');
  }
  // Minutes are read-only on DHUM_231006_WW. SET is also not writable.
  return { sleepTimer: { relativeHourToStop: hour } };
}
function active(device) {
  device.assertOnline();
  const value = device.state.sleepTimer?.relativeStopTimer;
  if (!['SET', 'UNSET'].includes(value)) throw device.error();
  return value === 'SET';
}
function remaining(device) {
  const state = device.state.sleepTimer;
  const h = state?.relativeHourToStop, m = state?.relativeMinuteToStop;
  if (!Number.isInteger(h) || h < 0 || (m !== undefined && (!Number.isInteger(m) || m < 0 || m > 59))) return null;
  return h * 3600 + (m ?? 0) * 60;
}
function selection(device) { return device.accessory.context?.nativeTimerSelection; }
function remember(device, value) {
  device.accessory.context ||= {};
  if (!value && !selection(device)) return;
  if (JSON.stringify(selection(device)) === JSON.stringify(value)) return;
  if (value) device.accessory.context.nativeTimerSelection = value;
  else delete device.accessory.context.nativeTimerSelection;
  device.platform.api.updatePlatformAccessories?.([device.accessory]);
}
function reconcile(device) {
  if (!supported(device.profile)) return;
  if (!['SET', 'UNSET'].includes(device.state.sleepTimer?.relativeStopTimer)) return;
  const enabled = active(device), seconds = remaining(device), now = Date.now();
  const pending = device.nativeTimerPending;
  if (pending) {
    if (pending.hour === null && !enabled) {
      remember(device, null); delete device.nativeTimerPending; return;
    }
    if (pending.hour !== null && enabled && (
      (seconds !== null && seconds <= pending.hour * 3600 && seconds >= pending.hour * 3600 - 120) ||
      (seconds === null && pending.previouslyActive === false))) {
      remember(device, { hour: pending.hour, endsAt: seconds === null ? null : now + seconds * 1000 });
      delete device.nativeTimerPending; return;
    }
    if (now - pending.requestedAt < 30000) return; // Old cloud readback is not confirmation.
    device.platform.log.warn('Timer command not yet confirmed by device state; please check the ThinQ app.');
    delete device.nativeTimerPending;
  }
  if (!enabled) { remember(device, null); return; }
  const saved = selection(device);
  // Keep the originally selected duration while it counts down. Infer a remaining-hour
  // bucket only for timers started elsewhere or visibly changed in ThinQ.
  if (seconds !== null && seconds > 0 && (!saved ||
    (Number.isFinite(saved.endsAt) && Math.abs(saved.endsAt - (now + seconds * 1000)) > 180000))) {
    remember(device, { hour: Math.ceil(seconds / 3600), endsAt: now + seconds * 1000 });
  }
}
function bind(device) {
  if (!supported(device.profile)) return;
  const { S, C } = device;
  const name = device.platform.config.nativeTimerName ?? 'Dehumidifier Timer';
  if (typeof name !== 'string' || !name.trim() || name.length > 48) throw new Error('nativeTimerName must be a non-empty name up to 48 characters');
  const choices = hours(device.platform.config.nativeTimerHours).filter(hour => {
    try { command(device.profile, hour); return true; } catch { return false; }
  });
  const defaultHour = device.platform.config.nativeTimerDefaultHours ?? choices[0];
  if (defaultHour !== undefined && !choices.includes(defaultHour)) throw new Error('nativeTimerDefaultHours must be one of the available nativeTimerHours');
  const status = device.service(S.Switch, name.trim(), 'native-sleep-timer');
  device.bind(status, C.On, () => active(device), async on => {
    if (on) {
      if (!active(device)) {
        const hour = defaultHour;
        if (hour === undefined) throw new Error('No timer duration is available');
        await device.writeNativeTimer(hour);
      }
    }
    else await device.writeNativeTimer(null);
  });
  for (const hour of choices) {
    const service = device.service(S.Switch, `${name.trim()} ${hour}h`, `native-sleep-timer:${hour}`);
    device.bind(service, C.On, () => active(device) && selection(device)?.hour === hour, async on => {
      if (on) await device.writeNativeTimer(hour);
      else if (active(device) && selection(device)?.hour === hour &&
        (!device.nativeTimerPending || device.nativeTimerPending.hour === hour)) await device.writeNativeTimer(null);
    });
  }
}
module.exports = { supported, hours, command, active, bind, reconcile, selection, remaining };
