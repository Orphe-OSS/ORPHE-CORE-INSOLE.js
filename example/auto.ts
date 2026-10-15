/**
 * ORPHE CORE / INSOLE Auto Profile — OrpheCoreInsole + autoProfile() のサンプル。
 *
 *   1. 接続ボタン    … chooser に CORE と INSOLE の両方が出る。readFirmwareInfo() で
 *                      選んだデバイスの名前から CORE / INSOLE を判別し、FW 情報を読む
 *   2. モードが出る  … ble.availableModes（判別した種別のモードを FW で絞り込み済み）で作る
 *   3. モードを選ぶ  … begin() で計測開始。接続中の変更はその場で切り替わる
 *
 * 表示は共通の IMU に加えて、INSOLE なら圧力、CORE なら歩数を出す。
 * FIFO 収録は CORE / INSOLE とも対応 FW でモードに出る。歩容解析は insole.html を参照。
 *
 * 複数台つなぎたい場合はこのページを台数ぶん開く（SDK 側は 1 インスタンス 1 台）。
 */
import { FifoRecorder, OrpheCoreInsole, autoProfile, insoleStreamingModeOf } from '../src/index.ts';
import type { AutoSensorFields } from '../src/index.ts';

/** モード id → 画面に出す名前。ここに無いモード（INSOLE の歩容解析）はセレクタに出さない */
const MODE_LABELS: Record<string, string> = {
  // CORE
  STEP_ANALYSIS_AND_SENSOR_VALUES: '歩行解析 + センサー値',
  STEP_ANALYSIS: '歩行解析',
  SENSOR_VALUES: 'センサー値',
  // INSOLE
  STREAMING_4: 'リアルタイム — 圧力 + IMU + 姿勢',
  STREAMING_3: 'リアルタイム高速 — 圧力 + IMU（姿勢なし）',
  STREAMING_1: 'リアルタイム高速 — IMU + 姿勢（圧力なし）',
  // 共通（対応 FW のみ）
  FIFO: 'FIFO 収録（ロスレス）',
};

const q = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
};

const logEl = q<HTMLDivElement>('[data-log]');
const log = (message: string, isWarn = false) => {
  const line = document.createElement('div');
  if (isWarn) line.className = 'warn';
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 100) logEl.firstElementChild?.remove();
  logEl.scrollTop = logEl.scrollHeight;
};

const debugLogInput = document.getElementById('shared-debug') as HTMLInputElement;
const autoReconnectInput = document.getElementById('shared-reconnect') as HTMLInputElement;

// ── デバイス ────────────────────────────────────────────────────────
// 名前が 'CR-' で始まる CORE も chooser に出す（INSOLE は 'INS' の名前で出る）。
// CORE は header 50 の 104 バイト版パケットも受け付ける（既定では捨てられ、センサー値が出ない）
const profile = autoProfile({ core: { namePrefix: 'CR-', acceptExtendedSensorValues: true } });

const ble = new OrpheCoreInsole({
  profile,
  events: {
    onScan: (deviceName) => { q('[data-device]').textContent = deviceName ?? '(no name)'; },
    onStartNotify: (uuid) => log(`startNotify: ${uuid}`),
    onDisconnect: () => { log('切断されました'); markDisconnected(); },
    onReconnectAttempt: (info) => log(`再接続中... ${info.attempt}/${info.maxAttempts}`),
    onReconnectSuccess: (info) => { log(`再接続成功 (attempt ${info.attempt})`); void resumeAfterReconnect(); },
    onReconnectFailed: () => log('自動再接続を諦めました', true),
    onError: (error) => log(`エラー: ${error}`, true),
  },
  log: (message, detail) => {
    console.debug('[AUTO]', message, detail ?? '');
    if (debugLogInput.checked) log(`⚙ ${message}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  },
});

const latest: Partial<AutoSensorFields> = {};
let lostCount = 0;
let pressScale = 2000; // 圧力バーのピークホールド自動スケール
let begun = false;
ble.on('*', (sample) => Object.assign(latest, sample));
ble.on('lost_data', () => { lostCount += 1; });

// ── FIFO 収録（対応 FW でのみモードに出る） ──
const fifo = new FifoRecorder(ble);
let fifoLag = 0;
let fifoStarting = false;
let fifoStopping = false;
fifo.onProgress = (info) => { fifoLag = info.lag; };
fifo.onDataLoss = (info) => log(`FIFO 欠損 ${info.dropped}（累計 ${info.cumulative}・${info.reason}）`, true);
fifo.onStopped = (info) => log(`FIFO 停止（${info.reason}）: collected ${info.collected} / dropped ${info.dropped}`);
fifo.onError = (error) => log(`FIFO エラー: ${error}`, true);

async function startFifo(): Promise<void> {
  if (!begun || fifo.isRunning || fifoStarting || fifoStopping) return;
  fifoStarting = true;
  try {
    log('FIFO 収録を開始します（リアルタイム表示は停止します）');
    if (!(await fifo.start())) log('FIFO 収録を開始できませんでした', true);
  } catch (error) {
    log(`FIFO 操作失敗: ${error}`, true);
  } finally {
    fifoStarting = false;
  }
}

async function stopFifo(): Promise<void> {
  if (!fifo.isRunning || fifoStopping) return;
  fifoStopping = true;
  try {
    log('FIFO 収録を停止して回収中…');
    await fifo.stop();
    log('リアルタイム計測に復帰');
  } catch (error) {
    log(`FIFO 操作失敗: ${error}`, true);
  } finally {
    fifoStopping = false;
  }
}

q<HTMLButtonElement>('[data-fifo-toggle]').addEventListener('click', () => {
  void (fifo.isRunning ? stopFifo() : startFifo());
});
q<HTMLButtonElement>('[data-fifo-csv]').addEventListener('click', () => {
  fifo.download(`orphe-${profile.kind}-fifo.csv`);
});

// ── 取得モード ──────────────────────────────────────────────────────
const modeSelect = q<HTMLSelectElement>('[data-mode]');
const modeWrap = q<HTMLElement>('[data-mode-wrap]');
let begunType = ''; // CORE の最初の begin() の type。SDK は自動再接続でこれを再実行する
let sensorNotifyOn = false;
let stepNotifyOn = false;
let switching = false;

/** 切断されたら計測前の状態に戻す（手動で再接続したときは begin() からやり直す） */
function markDisconnected(): void {
  begun = false;
  sensorNotifyOn = false;
  stepNotifyOn = false;
}

/** 自動再接続は最初の begin() を再実行するので、その状態に戻してから選択中のモードを当て直す */
async function resumeAfterReconnect(): Promise<void> {
  begun = true;
  if (profile.kind === 'core') {
    sensorNotifyOn = begunType !== 'STEP_ANALYSIS';
    stepNotifyOn = begunType !== 'SENSOR_VALUES';
  }
  await applyMode();
}

/** 接続後に呼ぶ。判別した種別・FW で使えるモードだけをセレクタに並べる */
function buildModeOptions(): void {
  const selected = modeSelect.value; // 手動で再接続したときは前回のモードを引き継ぐ
  modeSelect.replaceChildren();
  for (const mode of ble.availableModes) {
    const label = MODE_LABELS[mode.id];
    if (!label) continue;
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = label;
    modeSelect.appendChild(option);
  }
  if ([...modeSelect.options].some((option) => option.value === selected)) modeSelect.value = selected;
  modeWrap.hidden = modeSelect.options.length === 0;
}

modeSelect.addEventListener('change', () => void applyMode());

async function applyMode(): Promise<void> {
  if (switching || ble.connectionState !== 'connected') return;
  switching = true;
  try {
    if (fifo.isRunning && modeSelect.value !== 'FIFO') await stopFifo();
    // FIFO の収録開始はパネルの「収録開始」ボタンで行う（モード選択は準備まで）
    if (profile.kind === 'insole') await applyInsoleMode(modeSelect.value);
    else await applyCoreMode(modeSelect.value);
  } catch (error) {
    log(`モード切替失敗: ${error}`, true);
  } finally {
    switching = false;
  }
}

/** CORE: モード id がそのまま begin() の type。接続中は notify の付け替えで切り替える */
async function applyCoreMode(mode: string): Promise<void> {
  // FIFO の応答は SENSOR_VALUES の notify で届くので、begin の type は同じ
  const type = mode === 'FIFO' ? 'SENSOR_VALUES' : mode;
  const autoReconnect = autoReconnectInput.checked;
  if (!begun) {
    await ble.begin(type, { autoReconnect });
    begun = true;
    begunType = type;
    sensorNotifyOn = type !== 'STEP_ANALYSIS';
    stepNotifyOn = type !== 'SENSOR_VALUES';
    log(`begin('${type}') 完了`);
    return;
  }
  // 開始してから不要分を止め、途切れを作らない
  const wantStep = type !== 'SENSOR_VALUES';
  const wantSensor = type !== 'STEP_ANALYSIS';
  if (wantSensor && !sensorNotifyOn) { await ble.transport.startNotify('SENSOR_VALUES'); sensorNotifyOn = true; }
  if (wantStep && !stepNotifyOn) { await ble.transport.startNotify('STEP_ANALYSIS'); stepNotifyOn = true; }
  if (!wantSensor && sensorNotifyOn) { await ble.transport.stopNotify('SENSOR_VALUES'); sensorNotifyOn = false; }
  if (!wantStep && stepNotifyOn) { await ble.transport.stopNotify('STEP_ANALYSIS'); stepNotifyOn = false; }
}

/** INSOLE: begin() の type は SENSOR_VALUES 固定で、モード id から streamingMode を決める */
async function applyInsoleMode(mode: string): Promise<void> {
  // FIFO は圧力・IMU・姿勢がすべて要るので mode 4 をベースにする
  const streamingMode = insoleStreamingModeOf(mode) ?? 4;
  if (!begun) {
    await ble.begin('SENSOR_VALUES', { streamingMode, autoReconnect: autoReconnectInput.checked });
    begun = true;
    log(`begin('SENSOR_VALUES', { streamingMode: ${streamingMode} }) 完了`);
    return;
  }
  if (fifo.isRunning) return;
  await profile.insole.setDataStreamingMode(ble.transport, streamingMode);
  log(`streamingMode ${streamingMode} に切替`);
}

// ── 接続 ────────────────────────────────────────────────────────────
const connectButton = q<HTMLButtonElement>('[data-connect]');
const fwEl = q<HTMLElement>('[data-fw]');

async function connect(): Promise<void> {
  connectButton.disabled = true;
  try {
    // begin() より先に FW を読む。ここで CORE / INSOLE が判別され、使えるモードが確定する
    const firmware = await ble.readFirmwareInfo();
    // readFirmwareInfo() は失敗しても null を返すだけなので、接続の成否は別に見る
    if (!ble.isConnected()) throw new Error('デバイスに接続できませんでした');
    log(`${profile.kind} と判別`);
    fwEl.textContent = firmware
      ? `FW リリース日 ${firmware.releasedAt.toLocaleDateString()}`
      : 'FW 情報を取得できませんでした（モードは絞り込みません）';
    buildModeOptions();
    await applyMode();
  } catch (error) {
    log(`接続失敗: ${error}`, true);
  } finally {
    connectButton.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  connectButton.disabled = true;
  try {
    if (fifo.isRunning) await stopFifo(); // モード復帰の write は接続中に済ませる
    ble.stop();
    log('stop()');
    markDisconnected();
    modeWrap.hidden = true;
    fwEl.textContent = '';
    clearReadings();
  } finally {
    connectButton.disabled = false;
  }
}

/** 接続前と同じ見た目へ戻す（収録データ・表示値をすべて捨てる） */
function clearReadings(): void {
  if (fifo.collectedCount > 0) log(`FIFO 収録データ ${fifo.collectedCount} 件を破棄しました`);
  fifo.reset();
  fifoLag = 0;
  lostCount = 0;
  pressScale = 2000;
  for (const key of Object.keys(latest)) delete (latest as Record<string, unknown>)[key];
  for (const bar of bars) bar.style.height = '0%';
  for (const val of vals) val.textContent = '-';
  q('[data-device]').textContent = '';
}

connectButton.addEventListener('click', () => {
  void (ble.connectionState === 'disconnected' ? connect() : disconnect());
});

// ── 描画 ────────────────────────────────────────────────────────────
const bars = [...document.querySelectorAll<HTMLElement>('[data-bar]')];
const vals = [...document.querySelectorAll<HTMLElement>('[data-val]')];
const cells = [...document.querySelectorAll<HTMLElement>('[data-v]')].map((el) => ({
  el,
  path: (el.dataset['v'] ?? '').split('.'),
}));
const kindEls = [...document.querySelectorAll<HTMLElement>('[data-kinds]')];
const stateEl = q<HTMLElement>('[data-state]');
const kindEl = q<HTMLElement>('[data-kind]');
const acquisitionEl = q<HTMLElement>('[data-acquisition]');
const fifoModule = q<HTMLElement>('[data-fifo-module]');
let appliedKind = '';

function render(): void {
  const state = ble.connectionState;
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
  connectButton.textContent = state === 'disconnected' ? '接続' : '切断';

  // 判別結果に合わせて出すセクションを切り替える（要素側は data-kinds="core insole" で指定）
  const kind = begun ? profile.kind : '';
  if (kind !== appliedKind) {
    appliedKind = kind;
    for (const el of kindEls) el.hidden = !(el.dataset['kinds'] ?? '').split(' ').includes(kind);
    kindEl.textContent = kind === 'core' ? 'ORPHE CORE' : kind === 'insole' ? 'ORPHE INSOLE' : 'CORE / INSOLE';
  }
  acquisitionEl.textContent =
    !begun ? ''
      : switching ? '切替中…'
        : fifo.isRunning ? 'FIFO 収録中'
          : fifoStopping ? 'FIFO 回収中…'
            : modeSelect.value === 'FIFO' ? 'FIFO 待機中'
              : 'リアルタイム計測中';

  // FIFO パネル（FIFO モード選択中は常時表示。他モードでも収録結果が残る間は表示）
  const fifoSelected = begun && modeSelect.value === 'FIFO';
  fifoModule.hidden = !fifoSelected && !fifo.isRunning && !fifoStopping && fifo.collectedCount === 0;
  // 切断後は収録の操作ができないので、結果と CSV だけを残す
  q('[data-fifo-title]').textContent = begun ? 'FIFO 収録（ロスレス・収録中はリアルタイム表示が停止）' : 'FIFO 収録結果';
  const fifoToggle = q<HTMLButtonElement>('[data-fifo-toggle]');
  fifoToggle.hidden = !begun;
  fifoToggle.textContent = fifo.isRunning ? '停止' : '収録開始';
  fifoToggle.disabled = fifoStarting || fifoStopping;
  q<HTMLButtonElement>('[data-fifo-csv]').disabled = fifo.collectedCount === 0;
  q('[data-fifo-collected]').textContent = String(fifo.collectedCount);
  q('[data-fifo-lag]').textContent = String(fifoLag);
  q('[data-fifo-dropped]').textContent = String(fifo.droppedCount);
  q('[data-fifo-phase]').textContent =
    fifoStopping ? '回収中…' : fifo.isRunning ? '収録中' : fifo.collectedCount > 0 ? '収録済み' : '待機中';

  q('[data-freq]').textContent = latest.ble_frequency ? latest.ble_frequency.toFixed(0) : '-';
  q('[data-serial]').textContent = latest.serial_number?.toString() ?? '-';
  q('[data-lost]').textContent = String(lostCount);
  q('[data-steps]').textContent = latest.steps_number?.value.toString() ?? '-';

  const press = latest.press?.values;
  const newton = latest.converted_press?.values;
  if (press) {
    pressScale = Math.max(pressScale, ...press);
    press.forEach((value, i) => {
      const bar = bars[i];
      const val = vals[i];
      if (bar) bar.style.height = `${Math.min(100, (value / pressScale) * 100).toFixed(1)}%`;
      if (val) val.textContent = newton ? `${value} / ${newton[i]!.toFixed(1)} N` : String(value);
    });
  }

  for (const { el, path } of cells) {
    let value: unknown = latest;
    for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
    el.textContent = typeof value === 'number' ? value.toFixed(3) : '';
  }
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();
