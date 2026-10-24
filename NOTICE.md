# Interface sources and verification boundary

Checked: 2026-10-12.

- LG official SDK: [thinq-connect/pythinqconnect](https://github.com/thinq-connect/pythinqconnect), read at commit `2617a12e6cc8e7fec0f1c831211216970d870b3f`. Files compared: `thinq_api.py`, `country.py`, `const.py`, `mqtt_client.py`, `devices/dehumidifier.py`, and `devices/connect_device.py`. Confirmed Taiwan maps to `kic`, the PAT headers, the capability format, the control fields, and the MQTT registration/certificate flow. That SDK is copyright LG Electronics under Apache-2.0; this plugin reimplements the interface in JavaScript and does not bundle the Python SDK.
- Home Assistant official [dehumidifier capability fixture](https://github.com/home-assistant/core/blob/dev/tests/components/lg_thinq/fixtures/dehumidifier/profile.json) and [MQTT implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/lg_thinq/mqtt.py): confirmed the `WATER_IS_FULL` and `deviceId`/`pushCode` message formats. The fixture's model is `DHUM_056905_KR`, **not** DD201MWE0; used only for protocol study, and does not imply your model is compatible. Dev-branch links may change later.
- [Homebridge HAP-NodeJS service definitions](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/lib/definitions/ServiceDefinitions.ts): the dehumidifier, switch, and contact-sensor services.

Tests use self-built simulated data and include no user device data. This version is provided on GitHub, is not published to npm, and does not access or operate any user appliance.

## Fork changes (b0nsun9, 2026-10-24)

Fork of upstream `Brantyen/homebridge-lg-thinq-dehumidifier` (MIT). Two changes, no change to the LG API surface or the security boundary above:

1. **Region/country is now configurable, not hard-coded.** Upstream hard-coded `x-country: 'TW'` and the `api-kic.lgthinq.com` host in `lib/client.js`. This fork adds a required `country` config field and derives both the `x-country` header and the `api-<region>.lgthinq.com` host from it, via a new `lib/regions.js`. The country→region (`kic`/`aic`/`eic`) table is reused from the official SDK's `country.py` (Apache-2.0, cited above); NZ and TW are both `kic`, so NZ uses the same host upstream used.
2. **Water-full notification sensor type is now a choice.** Upstream always exposed the `WATER_IS_FULL` event as a HomeKit **Contact** sensor. This fork adds a `waterFullSensor` config field: `contact` (default, unchanged behaviour), `occupancy`, `leak` (Apple raises a Critical Alert), or `none` (no sensor). The event logic is unchanged; only the service/characteristic it is published on varies.

Upstream remains unverified on a real DD12GMWE0 (NZ 24 L model); these edits are covered by the local simulated test suite only.
