# Homebridge LG ThinQ Dehumidifier

A Homebridge plugin that brings an LG ThinQ dehumidifier into Apple Home through LG's official ThinQ Connect API (Personal Access Token). It exposes power, current humidity, target humidity, fan speed, and a water-tank-full notification on one tile, plus optional mode switches.

This is a fork of [Brantyen/homebridge-lg-thinq-dehumidifier](https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier) (MIT). The upstream repo's detailed changelog and install guide are in Traditional Chinese; this fork is in English, makes region and water-sensor type configurable, and gives Apple Home a clean single-tile layout.

## Fork changes (b0nsun9)

**1. Region is configurable (no longer hard-coded to Taiwan).** Set your LG account's two-letter `country` in the plugin config (e.g. `NZ`, `TW`, `AU`, `KR`, `US`, `GB`). It drives both the `x-country` header and the `api-<region>.lgthinq.com` host (regions `kic` / `aic` / `eic`, mapped from LG's official SDK `country.py`). NZ and TW share the `kic` host. The Homebridge UI pre-fills `NZ`; it is a required field.

**2. Water-tank-full sensor type is a choice.** Apple Home only pushes phone alerts for certain accessory types, so the `WATER_IS_FULL` event is published as one of them. Set `waterFullSensor`:
- `contact` — Contact sensor, "Opened" (default, quietest — upstream behaviour)
- `occupancy` — Occupancy sensor, "Detected"
- `leak` — Leak sensor (closest in meaning, but Apple raises a loud **Critical Alert**)
- `none` — do not create a water-full sensor

The alert *wording* cannot be changed in Apple Home (only the accessory's name); for custom text use a Shortcuts automation on the sensor, or Home Assistant. Switching type may need the accessory removed/re-added in Home for the icon to refresh.

**3. Clean single-tile Apple Home layout.** Upstream exposed every fan speed and every mode as its own switch (plus a native off-timer with one switch per hour), so one dehumidifier became 15–20 tiles. This fork puts **fan speed on the main tile as one RotationSpeed slider** (the device's speeds ordered low-to-high, with `AUTO` as the lowest step since the HomeKit slider is linear), shows **only the mode switches you pick** (`modeSwitches`, default Clothes Dry; they act as a radio group), makes the standalone humidity sensor optional (`showHumiditySensor`, default on), and **removes the native off-timer entirely**. Default result: one dehumidifier tile + the water-full sensor.

## Install (not on npm)

Global install (macOS and other npm setups), then restart Homebridge:
```bash
sudo npm install -g "https://github.com/b0nsun9/homebridge-lg-thinq-dehumidifier/archive/refs/tags/v0.3.0.tar.gz"
```
On a Homebridge box that keeps plugins under its storage path, use `npm install --prefix /var/lib/homebridge <same URL>` instead. Requires Node.js 22+ and Homebridge 1.8+. Verified against the DD12GMWE0 / DD201MWE0 capability profile (model `DHUM_231006_WW`); local simulated tests only (`npm ci && npm test`).

## Get an LG Personal Access Token (PAT)

Open [connect-pat.lgthinq.com](https://connect-pat.lgthinq.com/), sign in with the same LG account as the ThinQ app, and create a token. Grant the device list, device state, device control, and push-notification scopes. Enter the token only on your own server — never paste it into chat, screenshots, or source. See the [Home Assistant LG ThinQ docs](https://www.home-assistant.io/integrations/lg_thinq/) for the PAT flow.

## Configure

In the Homebridge UI, open the plugin settings and set:

| Field | Notes |
| --- | --- |
| `country` | 2-letter ISO code of your LG account's country (default `NZ`). |
| `token` / `tokenFile` | The PAT string, or a path to a file containing only the PAT. |
| `waterFullSensor` | `contact` (default) / `occupancy` / `leak` / `none`. |
| `modeSwitches` | Which modes appear as switches. Default `["RAPID_HUMIDITY"]` (Clothes Dry). Tick more in the UI, or leave empty for none. |
| `showHumiditySensor` | Show a separate humidity sensor tile (default `true`; the main tile already shows humidity). |
| `deviceId` | Required only when the account has more than one dehumidifier. |
| `pollInterval` | Status poll seconds (minimum 60, default 120). |

Save, restart Homebridge, then add the bridge in the iPhone Home app by scanning the QR code on the Homebridge dashboard.

## Features and limitations

| Need | How it works |
| --- | --- |
| Power | Official API power command |
| Current humidity | Read from the device; shows "no response" when missing or offline |
| Target humidity | Range, step, and exceptions taken from the device profile; not hard-coded 30–70% |
| Fan speed | A single RotationSpeed slider on the main tile; the device's speeds, ordered low-to-high, with `AUTO` as the lowest step |
| Mode | Switches only for the modes you pick (`modeSwitches`, default Clothes Dry); radio-group behaviour |
| Water-full | Subscribes to the official MQTT push only when the profile lists `WATER_IS_FULL` |

- A mode switch means "select this mode". To change, turn another mode on; turning the current mode off is rejected (the unit is always in some mode) — use the main tile to power off.
- Cloud-based: needs the internet. State is polled every `pollInterval` seconds; after a command is accepted it reads back after ~3s, and cloud lag can be longer. Rate-limit and disconnects back off; commands are not auto-resent.
- One device per platform entry; set `deviceId` if the account has several dehumidifiers.
- The HomeKit primary type is a dehumidifier. The official API exposes no compressor state, so "Idle" when on is just a HomeKit compatibility value — do not read it as "currently dehumidifying".

### Water-full is not a water-level gauge

The event sensor turns on for 10 seconds when `WATER_IS_FULL` arrives, then clears; clearing does not mean you emptied the tank. Events during a disconnect or restart can be missed, and there is no query for current water state at startup. Keep the ThinQ app's water reminder as a backstop.

## Read-only diagnostic

```bash
cd /var/lib/homebridge
export LG_THINQ_TOKEN_FILE=/var/lib/homebridge/lg-thinq-token.txt
export LG_THINQ_COUNTRY=NZ   # optional; 2-letter ISO, defaults to NZ
node /var/lib/homebridge/node_modules/homebridge-lg-thinq-dd201/diagnose.js
```
On a global npm install (e.g. macOS), the plugin lives under `` `$(npm root -g)`/homebridge-lg-thinq-dd201/diagnose.js ``.

The diagnostic needs the same country as the plugin config, so it builds the right server region; it reads `LG_THINQ_COUNTRY` (default `NZ`). Writes `lg-thinq-diagnostic.json` with model, capabilities, and current values — no PAT, device IDs, aliases, or certificates. Mask any IDs printed to the terminal before sharing.

## Common errors

| Error | What to check |
| --- | --- |
| 1103 / 1218, HTTP 401 | PAT invalid or wrong; update the file and restart |
| 1305 / 1308 / 1309, HTTP 403 | PAT scopes or account control permission |
| 1306 / HTTP 429 | Rate-limited — wait for backoff; do not shorten polling or keep restarting |
| 1219 / 1220 / 1221 / 2101 | The official API may not expose this model or feature |
| 1222 | Device offline |
| 2302 / 2304 / 2305 | Current state/power/mode does not allow this command |
| WATER_IS_FULL not found | The official capability does not expose this notification; keep using the ThinQ app |
| Water-full channel not ready | Check push scope and outbound MQTT TLS 8883; HTTPS control may still work |

## Develop

`npm ci` then `npm test`. Local verification uses HAP-NodeJS and simulated LG responses; there is no end-to-end test against a Raspberry Pi, the LG cloud, or an iPhone. Interface sources and the versions compared are in `NOTICE.md`.
