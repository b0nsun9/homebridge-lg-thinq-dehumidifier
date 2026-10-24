# Fork: configurable region + water-full sensor (b0nsun9)

This is a fork of [Brantyen/homebridge-lg-thinq-dehumidifier](https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier) (MIT) with two changes; everything below this section is upstream's changelog.

**1. Region is configurable (no longer hard-coded to Taiwan).** Set your LG account's two-letter `country` in the plugin config (e.g. `NZ`, `TW`, `AU`, `KR`, `US`, `GB`). It drives both the `x-country` header and the `api-<region>.lgthinq.com` host (regions `kic`/`aic`/`eic`, mapped from LG's official SDK `country.py`). NZ and TW share the `kic` host. The Homebridge UI pre-fills `NZ`; required field.

**2. Water-tank-full sensor type is a choice.** Apple Home only pushes phone alerts for certain accessory types, so the `WATER_IS_FULL` event is published as one of them. Set `waterFullSensor`:
- `contact` — Contact sensor, "Opened" (default, quietest — upstream behaviour)
- `occupancy` — Occupancy sensor, "Detected"
- `leak` — Leak sensor (closest in meaning, but Apple raises a loud **Critical Alert**)
- `none` — do not create a water-full sensor

The alert *wording* cannot be changed in Apple Home (only the accessory's name); for custom text use a Shortcuts automation on the sensor, or Home Assistant. Switching type may need the accessory removed/re-added in Home for the icon to refresh.

**Install this fork** (not on npm):
```bash
npm install --prefix /var/lib/homebridge https://github.com/b0nsun9/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```
Still unverified on a real DD12GMWE0; local simulated tests only (`npm ci && npm test`).

---

# 0.1.10：恢復 0.1.4 電源控制，增加三／五／七小時定時

移除 0.1.8 額外新增的「LG 除濕機電源」獨立 Switch。電源恢復 0.1.4 的主 HumidifierDehumidifier 服務 Active 控制方式，原本主服務 UUID、subtype、濕度設定與顯示規則保留。無目標濕度能力的設備仍沿用 0.1.4 的主電源 Switch 備援。更新重啟並成功重新初始化後，自動移除舊 power-control 服務；不用刪除主配件或重新配對。

新增「除濕機定時三小時」、「除濕機定時五小時」、「除濕機定時七小時」開關。預設選項為 [1,2,3,4,5,7,8]，依使用者指定增加三、五、七小時，未另外增加六小時。若設定仍保存舊預設 [1,2,4,8]，會自動擴充；其他自訂清單維持原樣，可自行加入 3、5、7。沒有改動實機可設定的時間範圍，控制仍由 LG 回應決定是否接受。

總開關「除濕機定時」及 nativeTimerDefaultHours 設定保留；先開啟主除濕機，再開啟定時。Siri 可試「開啟除濕機定時三小時」、「開啟除濕機定時五小時」、「開啟除濕機定時七小時」。短名稱、實機確認後保持 On、取消、滿水通知與全部其他控制保留。獨立電源開關已移除，先前針對該獨立開關的情境需改選主除濕機。

26 項模擬測試通過，包括升級時刪除舊獨立電源、主除濕機 Active 開關指令、三／五／七小時 payload 與舊預設遷移。Apple 家庭實際畫面與新增時數的機器執行結果仍須實測。

在 Homebridge 網頁終端機執行以下指令後重啟 Homebridge，並重開家庭 App：

```bash
npm install --prefix /var/lib/homebridge https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```

---

## 歷史版本 0.1.9：簡短 Siri 指令

總定時開關預設名稱改為「除濕機定時」，各時數改成「除濕機定時一小時／二小時／四小時／八小時」。保留原本 service subtype、配件識別、獨立電源與滿水通知，不需重新配對。舊的預設名稱會自動遷移，使用者在家庭 App 自訂過的名稱則保留。

## 語音操作

先開啟除濕機，再說「嘿 Siri，開啟除濕機定時」，預設一小時。說「嘿 Siri，關閉除濕機定時」可取消。要指定預設選項，可說「嘿 Siri，開啟除濕機定時二小時」。已啟用的總定時開關再次開啟不會重新起算；要重新設定可關閉後再開啟，或使用指定時數開關。

這是 HomeKit 配件名稱與開關行為的簡化，並非新增 Siri 自然語言意圖。Siri 依家庭 App 的實際名稱、房間與其他配件解析；實機語音辨識仍須驗證，不能只憑模擬測試宣稱已修復 Siri。Apple 官方說明：https://support.apple.com/zh-tw/105027 。

若更新、重啟並重開家庭 App 後仍無法辨識，可先確認總開關的名稱確實是「除濕機定時」，且沒有同名配件。若自己曾改名，請自行改回此名稱。也可在家庭 App 建立固定情境「除濕機定時」，唯一動作是將原生「除濕機定時一小時」設為開啟，然後說「嘿 Siri，啟用除濕機定時情境」。此情境需要使用者在家庭 App 建立，本外掛不會自動建立情境。不要在同一情境同時設定其他時數為關閉，以免造成取消衝突。若機器未開機，請先開機再執行情境。

## 自訂

在既有平台設定可加入：

```json
{
  "nativeTimerName": "除濕機定時",
  "nativeTimerDefaultHours": 2
}
```

以上只是額外欄位，請勿覆蓋整份平台設定。預設小時數必須包含於 nativeTimerHours 的可用選項；未指定則使用第一個可用選項。名稱不必包含 LG。定時仍由設備原生 sleepTimer 執行，沒有新增本機倒數。

25 項自動測試通過，包含簡短名稱、指定預設時數、舊名稱遷移、自訂名稱保留與既有控制；尚未驗證使用者 Siri 實際語音結果。

## 更新

在 Homebridge 終端機執行以下指令並重新啟動 Homebridge，再重開家庭 App：

```bash
npm install --prefix /var/lib/homebridge https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```

---

## 歷史版本 0.1.8：定時保持狀態、Siri 開關與獨立電源

修正 0.1.7 的瞬時按鈕設計：定時開關不再自動回到 Off。LG 實機讀回 SET 且時數吻合後，選定的時數保持 On，直到實機回報取消或結束；倒數減少時不會自動切換成另一個時數。原生除濕機仍是主要服務，另外新增獨立「LG 除濕機電源」開關，提供明確的開關入口。滿水通知、濕度、模式和風速保留。

## 操作與 Siri

- 開機／關機：「開啟 LG 除濕機電源」／「關閉 LG 除濕機電源」。
- 先開機，再說：「開啟 LG 除濕機定時一小時」；其他預設為二、四、八小時。
- 取消：「關閉 LG 除濕機定時」。也可關閉目前啟用的時數開關。
- 開啟總「LG 除濕機定時」開關，在尚未定時時會設定第一個可用時數，預設為一小時。

名稱使用平台設定的 name 作前綴；若你在家庭 App 自訂過名稱，升級會保留，Siri 請使用該實際名稱。這些是 HomeKit 開關指令，外掛不新增 Siri 自然語言意圖；語音辨識與同名配件衝突仍需在手機驗證。可把名稱改成容易辨識的「除濕機一小時」。Apple 說明：https://support.apple.com/zh-tw/105027 。

## 顯示與狀態

更新並重啟後，重新開啟 Apple 家庭。如果電源或定時仍被合併到除濕機方塊，請在配件設定查看「顯示為個別方塊」選項；介面與圖示由 Apple 決定，本外掛提供獨立服務而不保證 Apple 版面的圖示位置。不要先刪除或重新配對配件。

指令接受後約三秒重新讀取 LG，雲端舊狀態仍可能延遲。定時的啟用依實機 SET／UNSET；未知或離線不假裝 Off。已確認的選定時數保存於 Homebridge 配件 context，重啟後可保留；此紀錄僅供顯示，不安排關機。在 ThinQ App 改設定時，若剩餘時間顯示明顯不同，會重新按實機剩餘整數小時推估顯示，因此 App 外部設定時看到的是剩餘時數區間。讀回沒有剩餘時數時，可能只有總定時開關能確認為 On。

## 定時能力

依 DHUM_231006_WW 實機 profile，只寫 sleepTimer.relativeHourToStop；取消只寫 relativeStopTimer: UNSET，不寫唯讀分鐘或不可寫的 SET。定時由機器執行；沒有本機倒數、到期電源指令或指定時刻預約。

平台可用 nativeTimerHours 自訂整數小時，預設 [1,2,4,8]。介面上限 24 小時不是機器能力上限；實際允許時間以 LG 回應為準。只支援 WATER_IS_FULL 滿水通知，沒有定時完成通知。

## 驗證與更新

24 項模擬測試通過，涵蓋保持 On、取消、倒數跨時數與重啟、延遲讀回、Siri 對應 On/Off 控制路徑、獨立電源與既有功能。使用者已確認 0.1.7 一小時設定可作用；本次 Siri 語音辨識、家庭 App 畫面及到期狀態仍待實機驗證。

在 Homebridge 網頁終端機執行後重啟：

```bash
npm install --prefix /var/lib/homebridge https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```

---

## 0.1.6：移除預約關機，保留滿水通知

依需求移除 0.1.5 新增的 Homebridge 倒數／預約關機功能與時間選項。更新並重啟後，既有預約不再執行，對應 HomeKit 開關會移除；原有電源、濕度、模式、風速與滿水事件保留。若設定中仍有 timerPresets，可移除；此版會忽略它。

「定時」指除濕機本身的功能，本版尚未加入原生定時控制。不能僅依 ThinQ App 有此功能便認定官方 API 可控制；診斷輸出新增 timer 與 sleepTimer 的能力／狀態（若設備提供），供確認實機支援。

目前通知僅處理 WATER_IS_FULL 滿水事件，需設備 profile 宣告該事件、PAT 具有推播權限、LG MQTT 連線成功，並在 Apple 家庭的「水箱滿通知事件」設定「狀態和通知」。它是觸發 10 秒的事件感測器，復位不代表水箱已倒空；斷線時可能漏報，不補發歷史事件。沒有定時完成、除濕完成、故障或預約完成的推播通知。請保留 ThinQ App 通知。

驗證：14 項既有自動測試通過，含滿水事件目標設備過濾、10 秒復位、MQTT 訂閱、TLS 與斷線狀態。尚未連接使用者實機或 iPhone 驗證。

# LG ThinQ 除濕機 Homebridge 外掛

這是提供給臺灣 LG ThinQ 帳號、以 DD201MWE0 為目標的 0.1.8 測試版。已完成程式及本機模擬測試，**尚未連接你的 LG 帳號、Raspberry Pi 或 DD201MWE0 實機，不代表已確認相容**。如果官方 API 不列出該設備或功能，程式不會改用猜測指令。

## 功能與限制

| 需求 | 實作方式 |
| --- | --- |
| 開關 | LG 官方 API 的電源指令 |
| 目前濕度 | 讀取設備回報；無資料或離線顯示無回應 |
| 目標濕度 | 依設備能力決定範圍、刻度及例外值；不寫死 30–70% |
| 風速 | 每個實機允許的風速各有一個選項開關 |
| 模式 | 每個實機允許的模式各有一個選項開關 |
| 水箱滿通知 | 僅當實機能力包含 `WATER_IS_FULL` 時訂閱官方 MQTT 推播 |

開啟模式或風速的選項開關代表「選擇此選項」。切換時開啟另一個選項即可；直接關閉目前選項會被拒絕，關機請使用主開關。部分模式可能禁止調整濕度或風速，這時會保留 LG 的拒絕結果，不擅自切換模式。

目前使用雲端介面，需要網際網路。狀態每 120 秒輪詢，指令接受後約 3 秒讀回，雲端延遲仍可能更長。斷線及限流會退避重試，沒有自動重送控制指令。單一設定支援一台設備；帳號有多台除濕機時必須指定識別碼。

HomeKit 的主設備類型為除濕機。LG 目前核實的欄位沒有壓縮機運轉狀態，因此 HomeKit 開機時的「閒置」只是介面相容用值，**不能用它判斷是否正在除濕**。若實機未開放目標濕度，會退回主開關與可讀的濕度感測器。

### 滿水通知不是水位計

「水箱滿通知事件」採用 HomeKit 接觸感測器。收到事件時開啟 10 秒，再結束事件；**結束不代表你已倒水或水箱未滿**。Apple 可能用「開啟／關閉」描述它，不能自訂成任意推播文字。十秒內重複事件會合併。

事件通道斷線會標示故障。外掛關閉、網路中斷或重新啟動期間發生的滿水事件可能錯過；啟動時不能查詢既有滿水狀態。請保留 ThinQ App 的滿水提醒，直到實機驗證完成。

## 從零安裝

以下假設 Raspberry Pi 已安裝可用的 Raspberry Pi OS、有管理員權限，而且未用 Docker。若尚未有作業系統，先依 [Homebridge 官方安裝入口](https://homebridge.io/install/) 的 Raspberry Pi 映像說明建立系統；寫入映像會覆蓋目標記憶卡資料。已經有作業系統則可按以下步驟安裝。

### 1. 安裝 Homebridge

在 Raspberry Pi 終端機依序執行官方套件庫安裝指令：

```bash
curl -sSfL https://repo.homebridge.io/KEY.gpg | sudo gpg --dearmor | sudo tee /usr/share/keyrings/homebridge.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/homebridge.gpg] https://repo.homebridge.io stable main" | sudo tee /etc/apt/sources.list.d/homebridge.list > /dev/null
sudo apt-get update
sudo apt-get install homebridge
hostname -I
```

瀏覽器開啟 `http://樹莓派IP:8581`，完成管理帳號設定。來源：[Homebridge 官方 Raspberry Pi 安裝說明](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Raspbian)。

在 Homebridge 網頁的終端機確認 `node -v`，本外掛要求 Node.js 22 或更新版本，以及 Homebridge 1.8 或更新版本。這份安裝說明不適用於第一代 Pi／舊 Pi Zero 的舊執行環境。

### 2. 取得 LG 個人存取權杖

開啟 [LG PAT 管理頁](https://connect-pat.lgthinq.com/)，使用與 ThinQ App 相同的臺灣 LG 帳號登入，新增權杖。授予裝置清單、裝置狀態、裝置控制與推播通知權限。本外掛不使用耗電量查詢或狀態事件訂閱。

權杖只輸入自己的 Raspberry Pi，不要貼到聊天、截圖或原始碼。PAT 建立流程可參考 [Home Assistant 官方 LG ThinQ 文件](https://www.home-assistant.io/integrations/lg_thinq/)。

在 **Homebridge 網頁終端機**執行以下指令，提示出現時貼上 PAT，按 Enter。貼上內容不會顯示：

```bash
umask 077
read -r -s -p "貼上 LG PAT：" LG_PAT
printf '\n'
printf '%s' "$LG_PAT" > /var/lib/homebridge/lg-thinq-token.txt
unset LG_PAT
chmod 600 /var/lib/homebridge/lg-thinq-token.txt
```

上述路徑適用於官方 Homebridge 服務的預設資料目錄。若你使用其他資料目錄，請同步修改所有 `tokenFile` 路徑。權杖檔案必須可由 Homebridge 服務帳號讀取。

### 3. 上傳並安裝外掛

從這個 GitHub 儲存庫安裝時，可直接在 **Homebridge 網頁終端機**執行，然後跳至第 4 步：

```bash
npm install --prefix /var/lib/homebridge https://github.com/Brantyen/homebridge-lg-thinq-dehumidifier/archive/refs/heads/main.tar.gz
```

儲存庫名稱為 `homebridge-lg-thinq-dehumidifier`，程式套件名稱維持 `homebridge-lg-thinq-dd201`，因此下方診斷指令使用後者。以下為已有離線安裝包時的替代方式，不需重複安裝。

將交付的 `homebridge-lg-thinq-dd201-0.1.0.tgz` 放到 Pi 的 `/tmp/`。例如在 Windows 下載檔所在目錄開啟 PowerShell，將下方帳號和 IP 替換成實際值：

```powershell
scp .\homebridge-lg-thinq-dd201-0.1.0.tgz 你的帳號@樹莓派IP:/tmp/
```

回到 **Homebridge 網頁終端機**執行：

```bash
npm install --prefix /var/lib/homebridge /tmp/homebridge-lg-thinq-dd201-0.1.0.tgz
```

請使用這個終端機，確保安裝到 Homebridge 使用的 Node.js 環境。若出現權限或找不到 npm 的錯誤，先保留完整錯誤訊息，不要反覆安裝到不同的 Node.js 目錄。本套件尚未發布到 npm，不能只搜尋外掛名稱安裝。

### 4. 先執行唯讀診斷

同樣在 Homebridge 網頁終端機執行：

```bash
cd /var/lib/homebridge
export LG_THINQ_TOKEN_FILE=/var/lib/homebridge/lg-thinq-token.txt
node /var/lib/homebridge/node_modules/homebridge-lg-thinq-dd201/diagnose.js
```

診斷會在目前目錄產生 `lg-thinq-diagnostic.json`，含模型、功能能力及目前功能值，不含 PAT、裝置識別碼、家庭別名或憑證。終端機另印出本機設定用識別碼，分享終端機內容前請遮蔽。工具會在權杖旁保存固定診斷用客戶端識別碼，避免每次執行建立不同客戶端。

LG 回報的內部模型名稱可能不同於 DD201MWE0 商品型號；不要因此自行改寫模型能力。

### 5. 加入設定與 Apple「家庭」

在 Homebridge 設定頁，將下列物件加入既有 `platforms` 陣列。不要覆蓋整份設定，保留原有 `bridge` 和其他外掛：

```json
{
  "platform": "LGThinQDehumidifier",
  "name": "LG 除濕機",
  "tokenFile": "/var/lib/homebridge/lg-thinq-token.txt",
  "pollInterval": 120
}
```

有多台除濕機時，增加 `"deviceId": "診斷顯示的目標設備識別碼"`。若需自訂模式中文名稱，可加 `"optionNames": { "CLOTHES_DRY": "乾衣" }`；未知代碼顯示原始代碼與「待核對」，請依診斷能力表對照，避免錯譯。

儲存並重啟 Homebridge。用 iPhone「家庭」新增配件，掃描 Homebridge 管理頁上的配對 QR 碼。若已配對 Homebridge，不需重複配對。

在「水箱滿通知事件」的「狀態和通知」開啟活動通知。外出接收 HomeKit 通知需家庭中樞，例如相容的 HomePod 或 Apple TV，詳見 [Apple 通知設定說明](https://support.apple.com/zh-tw/105042)。實際顯示文字及可用通知選項由 Apple「家庭」決定。

## 實機驗收

1. 核對讀取濕度與 ThinQ App；容許輪詢與雲端延遲。
2. 測試開關，確認設備確實動作。
3. 設定一個實機允許的目標濕度，再從 App 比對。
4. 逐一切換可用風速和模式；記錄哪些組合被 LG 拒絕。
5. 讓設備正常使用至滿水，核對 ThinQ App、外掛紀錄與 Apple 通知。不要用灌水或破壞感測器方式測試。
6. 重啟 Homebridge，確認配件不重複建立；暫時斷網後確認顯示故障，恢復網路後可讀回。

在完成上述步驟前，這是待驗證測試版。回傳診斷 JSON 和已遮蔽識別資訊的錯誤紀錄，才能進一步確認 DD201MWE0 的實際相容性。

## 常見錯誤

| 錯誤 | 檢查方向 |
| --- | --- |
| 1103／1218、HTTP 401 | PAT 失效或錯誤；更新檔案後重啟 |
| 1305／1308／1309、HTTP 403 | PAT 權限或帳號控制權限 |
| 1306／HTTP 429 | 請等待退避，不要縮短輪詢或反覆重啟 |
| 1219／1220／1221／2101 | 官方介面可能未開放此型號或功能 |
| 1222 | 設備未連線 |
| 2302／2304／2305 | 目前狀態、電源或模式不允許此指令 |
| 找不到 WATER_IS_FULL | 官方能力未開放此通知；繼續使用 ThinQ App |
| 滿水事件通道未就緒 | 檢查推播權限及對外 MQTT TLS 8883 連線；HTTPS 控制可能仍正常 |

## 開發與驗證

原始碼壓縮檔包含測試及相依版本鎖定；解壓後執行 `npm ci`、`npm test`。一般使用者安裝 `.tgz` 即可，不需要安裝測試相依套件。

本機驗證使用 Node.js 24.19.0、HAP-NodeJS 和模擬 LG 回應，涵蓋控制驗證、限流、不洩漏錯誤內容、未知狀態、序列控制、模式、通知、能力缺失、快取恢復及 MQTT 簽發／訂閱流程。沒有進行 Raspberry Pi、LG 雲端帳號或 Apple 手機端的端到端測試。

官方來源與比對版本請見 `NOTICE.md`。

## 0.1.1 更新

保留全部風速、模式及滿水通知服務，補上 Apple「家庭」使用的 ConfiguredName，避免控制項全部顯示同一配件名稱。升級維持原有配件 UUID 與服務 subtype，不需刪除配件或重新配對；後續重啟保留使用者自行修改的控制項名稱。未知模式仍顯示「選項 1」等名稱，不猜測實際用途。

官方 APT 環境請使用上方帶有 --prefix /var/lib/homebridge 的安裝指令，完成後重新啟動 Homebridge，再關閉並重開「家庭」。舊版 npm install -g 會裝到不同目錄；hb-service add 不接受本儲存庫壓縮檔網址。可執行 npm list --prefix /var/lib/homebridge homebridge-lg-thinq-dd201 確認版本為 0.1.1。

11 項本機測試通過，含舊配件快取升級及自訂名稱保留。Apple「家庭」實際顯示仍待使用者更新後確認。

## 0.1.2 濕度顯示

將原生除濕機指定為主服務，並在設備提供目前濕度時增加標準濕度感測服務。目標濕度仍透過主除濕機控制，不建立假冒環境讀值的目標濕度感測器。全部風速、模式及滿水事件服務保留；既有配件 UUID 與服務 subtype 不變，無須重新配對。

更新後重啟 Homebridge 並重開 Apple「家庭」。目前濕度可在房間／氣候資訊中查看；目標濕度在主除濕機的控制頁調整。如果仍看到多開關的合併畫面，可在配件設定查看是否有「顯示為個別方塊」選項，再開啟主除濕機。介面文字和呈現方式依 Apple「家庭」版本而異，外掛無法指定自訂儀表板或任意模式下拉選單。

本版以 HomeKit 原生服務為目標；啟用 Matter 並不等於已驗證這些服務的 Matter 轉換。12 項本機測試通過，涵蓋濕度讀值、目標設定範圍、舊版配件升級、資料缺失及服務不重複建立。實際手機顯示仍待更新後確認。

## 0.1.3 ThinQ 模式名稱對照

針對 DHUM_231006_WW 內部模型，依 ThinQ 顯示與模式切換讀回結果修正名稱；其他模型沿用原本名稱。

| API 代碼 | 顯示名稱 |
| --- | --- |
| SMART_HUMIDITY | 智慧除濕 Plus |
| QUIET_HUMIDITY | 靜音除濕 |
| RAPID_HUMIDITY | 衣物乾燥 |
| INTENSIVE_DRY | 烘鞋／衣櫥 |

AIR_CLEAN 是 API 提供但本次 ThinQ 模式選單未列出的選項，保留並註明 App 未列出，不把它混成氣流或自動清潔。風量 MID 改為 App 的「中」。POWER 推測可能對應 App 的 Turbo，但尚未取得該檔位讀回結果，先顯示 POWER（待核對）。其他未知選項改顯示原始代碼，不再用無法辨識的「選項 1」。

升級自動更新仍使用舊預設名稱的控制項；使用者在「家庭」自訂且不同於舊預設值的名稱會保留。控制代碼、配件 UUID 和服務 subtype 不變，所有模式、風速、濕度與滿水通知服務均保留。13 項本機測試通過，含衣物乾燥／烘鞋模式指令與快取名稱遷移。

## 0.1.4 Turbo 風量名稱

使用者實機確認 POWER 對應 ThinQ 的 Turbo。此版本將 DD201 的風速 POWER（待核對）更新為風速 Turbo，控制仍送出 POWER；保留自訂名稱及既有配件識別。

## 0.1.4 Apple Home 濕度滑桿相容修正

Apple Home 的目標濕度特性改用標準 0～100%、步進 1 的範圍；送出指令前，依 LG 設備能力表限制至 30～70%、最接近的有效 5% 刻度。這是百分比原值，不將 100% 換算成 70%；例如 60 仍送 60，80 則限制為 70。讀回實機狀態後顯示實際目標值。

此相容策略參考 Home Assistant HomeKit 的 type_humidifiers.py。已通過 14 項本機測試，包括由 40 提高至 60、再降低、範圍與刻度校正；尚未在使用者 iPhone 上確認滑桿問題消失，不能把模擬測試當作實機驗證。保留配件識別，不必先移除或重新配對。