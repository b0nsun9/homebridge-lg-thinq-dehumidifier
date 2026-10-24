'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const mqtt = require('mqtt');
const forge = require('node-forge');

class PushConnection {
  constructor(client, ids, onMessage, onStatus, log, connect = mqtt.connect) {
    Object.assign(this, { client, ids, onMessage, onStatus, log });
    this.stopped = false;
    this.delay = 30000;
    this.connect = connect;
  }
  async start() {
    if (this.stopped) return;
    try {
      const route = await this.client.request('GET', 'route');
      const url = new URL(route.mqttServer);
      if (!['mqtts:', 'ssl:'].includes(url.protocol) || !url.hostname.endsWith('.amazonaws.com')) {
        throw new Error('Unexpected LG MQTT route format.');
      }
      await this.client.request('POST', 'client', { type: 'MQTT', 'service-code': 'SVC202', 'device-type': '607', allowExist: true });
      const keys = await promisify(crypto.generateKeyPair)('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const csr = forge.pki.createCertificationRequest();
      csr.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
      csr.setSubject([{ name: 'commonName', value: 'lg_thinq' }]);
      csr.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha512.create());
      const issued = await this.client.request('POST', 'client/certificate', {
        'service-code': 'SVC202', csr: forge.pki.certificationRequestToPem(csr).split(/\r?\n/).filter(x => x && !x.startsWith('---')).join(''),
      });
      const { certificatePem, subscriptions } = issued?.result || {};
      if (!certificatePem || !Array.isArray(subscriptions) || !subscriptions.length) throw new Error('Incomplete LG MQTT certificate response.');
      for (const id of this.ids) {
        try { await this.client.request('POST', `push/${encodeURIComponent(id)}/subscribe`); }
        catch (e) { if (e.code !== '1207') throw e; }
      }
      if (this.stopped) return;
      const connection = this.connect(`mqtts://${url.hostname}:${url.port || 8883}`, {
        clientId: this.client.clientId, cert: certificatePem, key: keys.privateKey,
        rejectUnauthorized: true, clean: true, keepalive: 30,
        reconnectPeriod: 10000, connectTimeout: 15000, protocolVersion: 4,
      });
      this.connection = connection;
      connection.on('connect', () => connection.subscribe(subscriptions, { qos: 1 }, err => {
        this.onStatus(!err);
        if (!err) this.delay = 30000;
        else {
          connection.end(true);
          clearTimeout(this.timer);
          if (!this.stopped) this.timer = setTimeout(() => void this.start(), this.delay);
          this.delay = Math.min(this.delay * 2, 900000);
        }
      }));
      connection.on('offline', () => this.onStatus(false));
      connection.on('close', () => this.onStatus(false));
      connection.on('error', () => this.onStatus(false));
      connection.on('message', (_topic, data) => {
        if (data.length > 65536) return;
        try {
          const message = JSON.parse(data.toString());
          if (this.ids.includes(message.deviceId)) this.onMessage(message);
        } catch { this.log.warn('Ignoring an unparseable LG push message.'); }
      });
      // Re-issue periodically so a long-running process never uses an expired certificate.
      const expiry = new crypto.X509Certificate(certificatePem).validTo;
      const renewIn = Math.max(60000, Math.min(12 * 3600000, Date.parse(expiry) - Date.now() - 3600000));
      this.timer = setTimeout(() => { connection.end(true); this.onStatus(false); void this.start(); }, renewIn);
    } catch (e) {
      this.onStatus(false);
      this.log.warn(`Water-full event channel not ready yet: ${e.message}`);
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.start(), this.delay);
        this.delay = Math.min(this.delay * 2, 900000);
      }
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.connection?.end(true); }
}
module.exports = { PushConnection };
