'use strict';
const paths = {
  power: ['operation', 'dehumidifierOperationMode'],
  current: ['humidity', 'currentHumidity'],
  target: ['humidity', 'targetHumidity'],
  fan: ['airFlow', 'windStrengthLevel'],
  mode: ['dehumidifierJobMode', 'currentJobMode'],
};
function property(profile, key) {
  const [r, p] = paths[key];
  return profile?.property?.[r]?.[p];
}
function values(profile, key) {
  const p = property(profile, key);
  return p?.mode?.includes('w') && Array.isArray(p.value?.w) ? p.value.w : [];
}
function range(profile) {
  const p = property(profile, 'target'), r = p?.value?.w;
  if (!p?.mode?.includes('w') || p.type !== 'range' || !r) return null;
  if (![r.min, r.max, r.step ?? 1].every(Number.isFinite) || r.min < 0 || r.max > 100 || r.min > r.max || (r.step ?? 1) <= 0) return null;
  return { ...r, step: r.step ?? 1 };
}
function command(profile, key, value) {
  const p = property(profile, key);
  if (!p?.mode?.includes('w')) throw new Error('Device does not expose this control.');
  if (p.type === 'enum' || p.type === 'list') {
    if (!values(profile, key).includes(value)) throw new Error('Device does not support this option.');
  } else if (key === 'target') {
    const r = range(profile);
    if (!r || !Number.isFinite(value) || value < r.min || value > r.max ||
      Math.abs((value - r.min) / r.step - Math.round((value - r.min) / r.step)) > 1e-6 || r.except?.includes(value)) {
      throw new Error('Target humidity is outside the device\'s allowed range or step.');
    }
  } else throw new Error('This control data format is not supported yet.');
  const [r, k] = paths[key];
  return { [r]: { [k]: value } };
}
function read(state, key) { const [r, p] = paths[key]; return state?.[r]?.[p]; }
function mergeState(state, report) {
  const result = { ...state };
  for (const resource of new Set(Object.values(paths).map(p => p[0]))) {
    if (report?.[resource] && typeof report[resource] === 'object' && !Array.isArray(report[resource])) {
      result[resource] = { ...result[resource], ...report[resource] };
    }
  }
  return result;
}
module.exports = { paths, property, values, range, command, read, mergeState };
