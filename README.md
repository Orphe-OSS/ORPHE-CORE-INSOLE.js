# ORPHE Core-Insole.js

ORPHE CORE / ORPHE INSOLE を Web Bluetooth で扱う SDK。

```ts
import { OrpheCoreInsole, insoleProfile } from 'orphe-core-insole';

const ble = new OrpheCoreInsole({ profile: insoleProfile() });
ble.on('converted_press', (press) => console.log(press.values)); // 6ch 圧力 [N]
ble.on('euler', (euler) => console.log(euler.roll, euler.pitch, euler.yaw));
await ble.begin('SENSOR_VALUES', { autoReconnect: true });
```

## 特長

- CORE / INSOLE を同じ API で扱える
- 接続したデバイスで使えるモードだけを `availableModes` で返す
- 切断時の自動再接続と、記憶デバイスへの chooser なし再接続
- FIFO ロスレス収録と歩容解析（CSV 出力付き）
- タブ間の接続共有

## 動作環境

- Web Bluetooth に対応したブラウザ（Chrome / Edge。HTTPS または localhost）
- 開発には Node.js 22 以上

## インストール

### CDN（`<script>` で読み込む）

jsDelivr から配信しています。`@v<version>` には [リリースタグ](https://github.com/Orphe-OSS/ORPHE-CORE-INSOLE.js/tags) を指定します。

```html
<!-- SDK 本体。公開 API はグローバル OrpheCoreInsoleJS に入る -->
<script src="https://cdn.jsdelivr.net/gh/Orphe-OSS/ORPHE-CORE-INSOLE.js@v0.2.0/dist/browser/orphe-core-insole.js"></script>
<!-- 接続 UI（buildCoreToolkit / buildInsoleToolkit）を使う場合のみ。SDK 本体の後に読み込む -->
<script src="https://cdn.jsdelivr.net/gh/Orphe-OSS/ORPHE-CORE-INSOLE.js@v0.2.0/dist/browser/orphe-core-insole-toolkit.js"></script>
<script>
  const { OrpheCoreInsole, coreProfile } = OrpheCoreInsoleJS;
  const ble = new OrpheCoreInsole({ profile: coreProfile() });
  ble.on('converted_acc', (acc) => console.log(acc.x, acc.y, acc.z));
  button.onclick = () => ble.begin('SENSOR_VALUES');
</script>
```

新 API（`OrpheCoreInsole` など）はトップレベルのグローバルには置かず、`OrpheCoreInsoleJS` から取り出します。
旧ライブラリ互換の `Orphe` / `OrpheInsole` などは移行用に同名のグローバルにも置いています（[旧 API からの移行](#旧-api-からの移行)）。

縮小版は `orphe-core-insole.min.js` / `orphe-core-insole-toolkit.min.js` です。
CDN 版を使ったサンプル集は [ORPHE-CORE-INSOLE.js-EXAMPLE](https://orphe-oss.github.io/ORPHE-CORE-INSOLE.js-EXAMPLE/)（[ソース](https://github.com/Orphe-OSS/ORPHE-CORE-INSOLE.js-EXAMPLE)）にあります。

### ソースからビルドする

npm には未公開です。クローンしてビルドします。

```bash
git clone https://github.com/Orphe-OSS/ORPHE-CORE-INSOLE.js.git
cd ORPHE-CORE-INSOLE.js
npm install
npm run build           # dist/ に ESM と型定義を出力
npm run build:browser   # dist/browser/ に <script> 用のファイルを出力
```

### リリース

`main` に push すると、`package.json` の version に対応するタグ（`v<version>`）が無ければ
GitHub Actions（`.github/workflows/release.yml`）が `dist/browser` をビルドしてタグを作ります。
jsDelivr はそのタグから配信します。版を上げるときは `npm version patch` で version を更新して `main` に反映します。

## 開発

```bash
npm test             # ユニットテスト
npm run check        # 型チェック + テスト
npm run build        # dist/ に出力
npm run example      # サンプル（example/）を起動
```

## 使い方

### 接続と購読

```ts
import { OrpheCoreInsole, coreProfile, insoleProfile } from 'orphe-core-insole';

const ble = new OrpheCoreInsole({
  profile: insoleProfile(),   // CORE なら coreProfile()
  id: 0,                      // 複数台つなぐときのスロット番号
  events: {
    onConnect: () => console.log('接続'),
    onDisconnect: () => console.log('切断'),
    onError: (error) => console.error(error),
  },
});

ble.on('acc', (acc) => { /* 加速度 */ });
ble.on('*', (sample) => { /* 1 サンプル全体 */ });

await ble.begin('SENSOR_VALUES', { autoReconnect: true });
// ...
ble.stop();
```

### CORE / INSOLE を自動で判別する

`profile` を省略すると `autoProfile()` になり、chooser に CORE と INSOLE の両方が出ます。選んだデバイスの名前で種別を判別します（`INS` で始まる名前なら INSOLE、それ以外は CORE）。

```ts
import { OrpheCoreInsole } from 'orphe-core-insole';

const ble = new OrpheCoreInsole();
await ble.begin();   // 種別を省略すると、CORE は STEP_ANALYSIS、INSOLE は SENSOR_VALUES で開始する
ble.profile.kind;    // 'core' | 'insole'（接続前は 'auto'）
```

判別後に使うプロファイルへオプションを渡すときは `autoProfile()` を明示します。

```ts
import { OrpheCoreInsole, autoProfile } from 'orphe-core-insole';

const ble = new OrpheCoreInsole({
  profile: autoProfile({ core: { /* coreProfile() のオプション */ }, insole: { /* insoleProfile() のオプション */ } }),
});
```

記憶デバイスの保存先は `coreProfile()` / `insoleProfile()` とは別になります。`availableModes` は `readFirmwareInfo()` か `begin()` で接続して種別が決まるまで空です。

### 購読できるフィールド

| プロファイル | フィールド |
|---|---|
| CORE | `acc` `gyro` `quat` `converted_acc` `converted_gyro` `gait` `stride` `pronation` `steps_number` `calorie` ほか |
| INSOLE | `acc` `gyro` `quat` `euler` `press` `converted_acc` `converted_gyro` `converted_press` `ble_frequency` `lost_data` |

### 取得モード

```ts
await ble.readFirmwareInfo();   // 接続だけ先に済ませる
ble.availableModes;             // [{ id: 'STREAMING_4', label: 'Full sensor 100 Hz' }, ...]
```

| プロファイル | `begin()` の種別 | オプション |
|---|---|---|
| CORE | `SENSOR_VALUES` / `STEP_ANALYSIS` / `STEP_ANALYSIS_AND_SENSOR_VALUES` | `range`（加速度・角速度のレンジ） |
| INSOLE | `SENSOR_VALUES` | `streamingMode`: 1（姿勢）/ 3（圧力 + IMU）/ 4（全センサー） |

`STREAMING_*` のモード id は `insoleStreamingModeOf(id)` で `streamingMode` の番号にできます。

### FIFO ロスレス収録

```ts
import { FifoRecorder } from 'orphe-core-insole';

const fifo = new FifoRecorder(ble);
fifo.onSamples = (deviceId, samples) => { /* 回収したサンプル */ };
fifo.onDataLoss = (info) => console.warn(`欠損 ${info.dropped}`);

await fifo.start();     // 使えないデバイスでは false
// ...
await fifo.stop();
fifo.download('capture.csv');
```

### 歩容解析（INSOLE）

```ts
import { InsoleGait } from 'orphe-core-insole';

const gait = new InsoleGait(ble);
gait.onGait = (deviceId, row) => { /* 1 歩ぶんの歩容パラメーター */ };
await gait.start();
// ...
await gait.stop();
gait.download('gait.csv');
```

### 自動再接続

```ts
await ble.begin('SENSOR_VALUES', {
  autoReconnect: true,
  reconnect: { intervalMs: 3000, maxAttempts: 120 },
});
```

進行は `onReconnectAttempt` / `onReconnectSuccess` / `onReconnectFailed` で受け取れます。

### ライフサイクルイベント

コンストラクタの `events` のほか、`onEvent()` で構築後に何個でも購読できます（toolkit が作ったインスタンスにも使えます）。解除関数を返します。

```ts
const off = ble.onEvent('onConnect', (uuid) => console.log('接続', uuid));
ble.onEvent('onDisconnect', () => console.log('切断'));
ble.onEvent('onReconnectAttempt', (info) => console.log(`${info.attempt}/${info.maxAttempts}`));
off();
```

### デバイスコマンド

`ble.commands` にデバイス固有のコマンドがあります。プロファイルごとに型が決まります（autoProfile は接続して種別が決まってから使えます）。

| プロファイル | コマンド |
|---|---|
| CORE | `setLED(on, pattern)` `setLEDBrightness(0..255)` `setRange({ acc, gyro })` `setMountPosition(0..3)` `resetAttitude()` `resetAnalysisLogs()` `readDeviceInformation()` `writeDeviceInformation(settings)` |
| INSOLE | `setDataStreamingMode(1 \| 3 \| 4)` `resetAnalysisLogs()` `readDeviceInformation()` |

```ts
await ble.commands.setLED(true, 2);
const info = await ble.commands.readDeviceInformation();   // ble.profile.device_information も更新される
console.log(info.battery);
```

時刻は `ble.readDateTime()` / `ble.writeDateTime(date)` / `ble.syncTime()` で扱えます（begin() の中でも自動で同期します）。
直近に begin() で開始した種別は `ble.lastBeginType` でわかります。

### シミュレータ（実機なしで動かす）

`createInsoleSimulator()` は擬似 INSOLE につながった `OrpheCoreInsole` を返します。実機と同じパース経路を通るので、`on()` / `commands` / `lost_data` / `ble_frequency` がそのまま動きます。

```ts
const ble = location.search.includes('sim=1')
  ? createInsoleSimulator(0, { preset: 'walk' })       // 'walk' | 'stand' | 'sway'、または frames で再生
  : new OrpheCoreInsole({ profile: insoleProfile() });
ble.on('press', (press) => draw(press.values));
await ble.begin('SENSOR_VALUES', { streamingMode: 4 });
```

FIFO・歩容解析（STEP_ANALYSIS）・FW 情報は持ちません。`buildInsoleToolkit(…, { simulator: true })` でも使えます。

### アドバタイズの監視（INSOLE）

```ts
await ble.watchAdvertisements();   // 未対応の環境では false
ble.on('status', (status) => console.log(status.battery, status.version));
```

### 複数台とタブ間共有

- 複数台は `id` を変えて `OrpheCoreInsole` を台数ぶん作ります。`deviceGuard` で二重割当を防げます。
- `begin(type, { useSharedBridge: true })` にすると、同じスロットの BLE 接続を別タブと共有します。別タブが接続中なら BLE に触らずそのタブから受信し（`ble.sharedBridgeRole === 'secondary'`）、いなければ自分が接続して配信します（`'primary'`）。

### 接続 UI（toolkit）

`orphe-core-insole-toolkit.js` を読み込むと、`buildCoreToolkit()` / `buildInsoleToolkit()` / `buildCoreCompanionToolkit()` で接続トグルと設定モーダルを作れます（Bootstrap 5 と bootstrap-icons が必要）。
操作対象の `cores`（= `bles`）/ `insoles` / `orpheCore` は `OrpheCoreInsole` です。

```js
buildCoreToolkit(document.querySelector('#toolkit'), 'CORE 01', 0, 'SENSOR_VALUES');
cores[0].on('converted_acc', (acc) => { /* … */ });
cores[0].onEvent('onConnect', () => { /* … */ });

buildInsoleToolkit(document.querySelector('#toolkit1'), 'INSOLE 01', 1, { streamingMode: 4 });
insoles[1].on('press', (press) => { /* … */ });
const session = getInsoleToolkitSession(1);   // 計測（リアルタイム / FIFO / 歩容）の制御
```

### エラー

```ts
try {
  await ble.begin();
} catch (error) {
  if (error instanceof TransportError && error.code === 'NO_DEVICE') { /* chooser でキャンセル */ }
}
```

## 旧 API からの移行

ORPHE-CORE.js の `Orphe` と ORPHE-INSOLE.js の `OrpheInsole` は、互換クラスとして残しています（`new Orphe(0)` + `gotAcc = …` のまま動きます）。
新しく書くコードでは次の対応で `OrpheCoreInsole` を使ってください。

| 旧 API | 新 API |
|---|---|
| `new Orphe(0)` / `new OrpheInsole(0)` | `new OrpheCoreInsole({ profile: coreProfile({ namePrefix: 'CR-' }), id: 0 })` / `insoleProfile()` |
| `ble.setup()` | 不要 |
| `ble.gotAcc = function (acc) {…}` | `ble.on('acc', (acc) => {…})`（`gotConvertedAcc` → `'converted_acc'` のように snake_case） |
| `ble.gotBLEFrequency` / `ble.lostData(serial, prev)` | `ble.on('ble_frequency', …)` / `ble.on('lost_data', ({ serial, prev }) => …)` |
| `ble.gotData = function (data, uuid)` | `ble.onRaw((uuid, data) => …)`（引数の順が逆） |
| `ble.onConnect = …` など | `ble.onEvent('onConnect', …)` またはコンストラクタの `events` |
| `setLED` / `resetMotionSensorAttitude` / `resetAnalysisLogs` / `getDeviceInformation` / `setDeviceInformation` | `ble.commands.setLED` / `resetAttitude` / `resetAnalysisLogs` / `readDeviceInformation` / `writeDeviceInformation` |
| `setDataStreamingMode(m)`（INSOLE） | `ble.commands.setDataStreamingMode(m)` |
| `ble.device_information` / `ble.streaming_mode` | `ble.profile.device_information` / `ble.profile.streaming_mode` |
| `ble.notification_type` | `ble.lastBeginType` |
| `read` / `write` / `startNotify` / `stopNotify` / `bluetoothDevice` | `ble.transport.read` など / `ble.transport.device` |
| `forgetLastBluetoothDevice()` | `ble.transport.forgetRememberedDevice()` |
| `getDateTime()` / `syncCoreTime()` | `ble.readDateTime()` / `ble.syncTime()` |
| `OrpheInsoleFifo` / `OrpheInsoleGait` | `FifoRecorder` / `InsoleGait` |
| `OrpheInsoleSimulator` | `createInsoleSimulator()` |
| `begin(…, { useSharedBridge: true })` / `isBridgeSecondary` | 同じオプション / `ble.sharedBridgeRole === 'secondary'` |

v0.2.0 から toolkit の `cores` / `insoles` / `orpheCore` は `OrpheCoreInsole` になりました。
toolkit を使う既存コードで `cores[0].gotAcc = …` の書き方を続ける場合は、`attachLegacyCallbacks(cores[0])` を 1 回呼んでください。
