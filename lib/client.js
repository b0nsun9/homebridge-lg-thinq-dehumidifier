'use strict';
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { regionFor } = require('./regions');

class ThinQClient {
  constructor(config, clientId, fetcher = globalThis.fetch) {
    this.token = (config.tokenFile ? fs.readFileSync(config.tokenFile, 'utf8') : config.token || '').trim();
    if (!this.token) throw new Error('Set tokenFile or a Personal Access Token.');
    // Country code sets the x-country header and the API server region; configurable, not hard-coded.
    this.country = String(config.country || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(this.country)) throw new Error('Set a 2-letter country code (country) in the config, e.g. NZ.');
    this.region = regionFor(this.country);
    if (!this.region) throw new Error(`Unsupported LG ThinQ country code: ${this.country}.`);
    this.host = `api-${this.region}.lgthinq.com`;
    this.clientId = clientId;
    this.fetcher = fetcher;
    this.blockedUntil = 0;
  }
  async request(method, endpoint, body) {
    if (Date.now() < this.blockedUntil) throw new Error('LG API rate-limited; please retry later.');
    let response;
    try {
      response = await this.fetcher(`https://${this.host}/${endpoint}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.token}`, 'x-country': this.country,
          'x-message-id': randomBytes(16).toString('base64url'),
          'x-client-id': this.clientId,
          // LG's public SDK service identifier, not a user password or personal token.
          'x-api-key': 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3',
          'x-service-phase': 'OP', 'Content-Type': 'application/json',
          ...(endpoint.endsWith('/control') ? { 'x-conditional-control': 'true' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('LG connection failed or timed out; check your network.'); }
    let payload;
    try { payload = await response.json(); } catch { throw new Error('LG response is not valid JSON.'); }
    if (!response.ok || payload.error) {
      const code = String(payload.error?.code || response.status).replace(/[^0-9]/g, '').slice(0, 8);
      if (response.status === 429 || code === '1306') {
        const seconds = Number(response.headers.get('retry-after'));
        this.blockedUntil = Date.now() + Math.max(300, Number.isFinite(seconds) ? seconds : 300) * 1000;
      }
      const err = new Error(`LG API error ${code} (HTTP ${response.status}); see the documentation.`);
      err.code = code;
      throw err;
    }
    return payload.response;
  }
  list() { return this.request('GET', 'devices'); }
  profile(id) { return this.request('GET', `devices/${encodeURIComponent(id)}/profile`); }
  state(id) { return this.request('GET', `devices/${encodeURIComponent(id)}/state`); }
  control(id, body) { return this.request('POST', `devices/${encodeURIComponent(id)}/control`, body); }
}
module.exports = { ThinQClient };
