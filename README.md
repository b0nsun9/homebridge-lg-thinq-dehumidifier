# Homebridge LG ThinQ Dehumidifier

A Homebridge plugin that brings an LG ThinQ dehumidifier into Apple Home through LG's official ThinQ Connect API (Personal Access Token). It exposes power, current humidity, target humidity, fan speed, mode, an off-timer, and a water-tank-full notification.

This is a fork of [Brantyen/homebridge-lg-thinq-dehumidifier](https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier) (MIT). The upstream repo's detailed changelog and install guide are in Traditional Chinese; this fork is in English and adds two configurable settings.

## Fork changes (b0nsun9)

**1. Region is configurable (no longer hard-coded to Taiwan).** Set your LG account's two-letter `country` in the plugin config (e.g. `NZ`, `TW`, `AU`, `KR`, `US`, `GB`). It drives both the `x-country` header and the `api-<region>.lgthinq.com` host (regions `kic` / `aic` / `eic`, mapped from LG's official SDK `country.py`). NZ and TW share the `kic` host. The Homebridge UI pre-fills `NZ`; it is a required field.

**2. Water-tank-full sensor type is a choice.** Apple Home only pushes phone alerts for certain accessory types, so the `WATER_IS_FULL` event is published as one of them. Set `waterFullSensor`:
- `contact` — Contact sensor, "Opened" (default, quietest — upstream behaviour)
- `occupancy` — Occupancy sensor, "Detected"
- `leak` — Leak sensor (closest in meaning, but Apple raises a loud **Critical Alert**)
- `none` — do not create a water-full sensor

The alert *wording* cannot be changed in Apple Home (only the accessory's name); for custom text use a Shortcuts automation on the sensor, or Home Assistant. Switching type may need the accessory removed/re-added in Home for the icon to refresh.

## Install (not on npm)

Run in the Homebridge web terminal, then restart Homebridge:
```bash
npm install --prefix /var/lib/homebridge https://github.com/b0nsun9/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```
Requires Node.js 22+ and Homebridge 1.8+. Still unverified on a real DD12GMWE0; local simulated tests only (`npm ci && npm test`).

## Get an LG Personal Access Token (PAT)

Open [connect-pat.lgthinq.com](https://connect-pat.lgthinq.com/), sign in with the same LG account as the ThinQ app, and create a token. Grant the device list, device state, device control, and push-notification scopes. Enter the token only on your own server — never paste it into chat, screenshots, or source. See the [Home Assistant LG ThinQ docs](https://www.home-assistant.io/integrations/lg_thinq/) for the PAT flow.

## Configure

In the Homebridge UI, open the plugin settings and set:

| Field | Notes |
| --- | --- |
| `country` | 2-letter ISO code of your LG account's country (default `NZ`). |
| `token` / `tokenFile` | The PAT string, or a path to a file containing only the PAT. |
| `waterFullSensor` | `contact` (default) / `occupancy` / `leak` / `none`. |
| `deviceId` | Required only when the account has more than one dehumidifier. |
| `pollInterval` | Status poll seconds (minimum 60, default 120). |

Save, restart Homebridge, then add the bridge in the iPhone Home app by scanning the QR code on the Homebridge dashboard.

## Features and limitations

| Need | How it works |
| --- | --- |
| Power | Official API power command |
| Current humidity | Read from the device; shows "no response" when missing or offline |
| Target humidity | Range, step, and exceptions taken from the device profile; not hard-coded 30–70% |
| Fan speed | One option switch per fan speed the device allows |
| Mode | One option switch per mode the device allows |
| Water-full | Subscribes to the official MQTT push only when the profile lists `WATER_IS_FULL` |

- A mode/fan option switch means "select this option". To change, turn another option on; turning the current option off is rejected — use the main switch to power off.
- Cloud-based: needs the internet. State is polled every `pollInterval` seconds; after a command is accepted it reads back after ~3s, and cloud lag can be longer. Rate-limit and disconnects back off; commands are not auto-resent.
- One device per platform entry; set `deviceId` if the account has several dehumidifiers.
- The HomeKit primary type is a dehumidifier. The official API exposes no compressor state, so "Idle" when on is just a HomeKit compatibility value — do not read it as "currently dehumidifying".

### Water-full is not a water-level gauge

The event sensor turns on for 10 seconds when `WATER_IS_FULL` arrives, then clears; clearing does not mean you emptied the tank. Events during a disconnect or restart can be missed, and there is no query for current water state at startup. Keep the ThinQ app's water reminder as a backstop.

## Read-only diagnostic

```bash
cd /var/lib/homebridge
export LG_THINQ_TOKEN_FILE=/var/lib/homebridge/lg-thinq-token.txt
node /var/lib/homebridge/node_modules/homebridge-lg-thinq-dd201/diagnose.js
```
Writes `lg-thinq-diagnostic.json` with model, capabilities, and current values — no PAT, device IDs, aliases, or certificates. Mask any IDs printed to the terminal before sharing.

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
