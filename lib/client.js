'use strict';
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { regionFor } = require('./regions');

class ThinQClient {
  constructor(config, clientId, fetcher = globalThis.fetch) {
    this.token = (config.tokenFile ? fs.readFileSync(config.tokenFile, 'utf8') : config.token || '').trim();
    if (!this.token) throw new Error('請設定 tokenFile 或個人存取權杖。');
    // 國家代碼決定 x-country 標頭與 API 伺服器區域；不再寫死，改由設定帶入。
    this.country = String(config.country || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(this.country)) throw new Error('請在設定填入兩碼國家代碼（country），例如 NZ。');
    this.region = regionFor(this.country);
    if (!this.region) throw new Error(`LG ThinQ 不支援的國家代碼：${this.country}。`);
    this.host = `api-${this.region}.lgthinq.com`;
    this.clientId = clientId;
    this.fetcher = fetcher;
    this.blockedUntil = 0;
  }
  async request(method, endpoint, body) {
    if (Date.now() < this.blockedUntil) throw new Error('LG API 暫時限流，請稍後再試。');
    let response;
    try {
      response = await this.fetcher(`https://${this.host}/${endpoint}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.token}`, 'x-country': this.country,
          'x-message-id': randomBytes(16).toString('base64url'),
          'x-client-id': this.clientId,
          // LG 公開 SDK 的服務識別值，並非使用者密碼或個人權杖。
          'x-api-key': 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3',
          'x-service-phase': 'OP', 'Content-Type': 'application/json',
          ...(endpoint.endsWith('/control') ? { 'x-conditional-control': 'true' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('LG 連線失敗或逾時；請確認網路。'); }
    let payload;
    try { payload = await response.json(); } catch { throw new Error('LG 回應不是有效 JSON。'); }
    if (!response.ok || payload.error) {
      const code = String(payload.error?.code || response.status).replace(/[^0-9]/g, '').slice(0, 8);
      if (response.status === 429 || code === '1306') {
        const seconds = Number(response.headers.get('retry-after'));
        this.blockedUntil = Date.now() + Math.max(300, Number.isFinite(seconds) ? seconds : 300) * 1000;
      }
      const err = new Error(`LG API 錯誤 ${code}（HTTP ${response.status}）；請查閱說明文件。`);
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
