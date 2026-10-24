# 介面來源與驗證界線

查核日期：2026-10-12。

- LG 官方 SDK：[thinq-connect/pythinqconnect](https://github.com/thinq-connect/pythinqconnect)，讀取版本 `2617a12e6cc8e7fec0f1c831211216970d870b3f`。比對檔案為 `thinq_api.py`、`country.py`、`const.py`、`mqtt_client.py`、`devices/dehumidifier.py` 及 `devices/connect_device.py`。確認臺灣對應 `kic`、PAT 標頭、能力格式、控制欄位及 MQTT 註冊／憑證流程。該 SDK 著作權屬 LG Electronics，採 Apache-2.0；本外掛以 JavaScript 重新實作介面，不打包 Python SDK。
- Home Assistant 官方[除濕機能力樣本](https://github.com/home-assistant/core/blob/dev/tests/components/lg_thinq/fixtures/dehumidifier/profile.json)與 [MQTT 實作](https://github.com/home-assistant/core/blob/dev/homeassistant/components/lg_thinq/mqtt.py)：確認 `WATER_IS_FULL` 及 `deviceId`／`pushCode` 訊息格式。樣本的模型為 `DHUM_056905_KR`，**不是 DD201MWE0**；僅用於協定研究，不能推論你的型號必然相容。開發分支連結可能後續變動。
- [Homebridge HAP-NodeJS 服務定義](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/lib/definitions/ServiceDefinitions.ts)：除濕機、開關及接觸感測器服務。

程式測試採自行建構的模擬資料，未包含使用者裝置資料。此版本提供於 GitHub，尚未發布 npm，也沒有存取或操作使用者家電。

## Fork changes (b0nsun9, 2026-10-24)

Fork of upstream `Brantyen/homebridge-lg-thinq-dehumidifier` (MIT). Two changes, no change to the LG API surface or the security boundary above:

1. **Region/country is now configurable, not hard-coded.** Upstream hard-coded `x-country: 'TW'` and the `api-kic.lgthinq.com` host in `lib/client.js`. This fork adds a required `country` config field and derives both the `x-country` header and the `api-<region>.lgthinq.com` host from it, via a new `lib/regions.js`. The country→region (`kic`/`aic`/`eic`) table is reused from the official SDK's `country.py` (Apache-2.0, cited above); NZ and TW are both `kic`, so NZ uses the same host upstream used.
2. **Water-full notification sensor type is now a choice.** Upstream always exposed the `WATER_IS_FULL` event as a HomeKit **Contact** sensor. This fork adds a `waterFullSensor` config field: `contact` (default, unchanged behaviour), `occupancy`, `leak` (Apple raises a Critical Alert), or `none` (no sensor). The event logic is unchanged; only the service/characteristic it is published on varies.

Upstream remains unverified on a real DD12GMWE0 (NZ 24 L model); these edits are covered by the local simulated test suite only.
