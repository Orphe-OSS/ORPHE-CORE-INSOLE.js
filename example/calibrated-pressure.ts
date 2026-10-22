/**
 * ORPHE INSOLE Calibrated Pressure — 荷重 [N] と個体別圧力校正係数のサンプル。
 *
 *   1. 接続ボタン        … begin() の中で対応 FW なら 6ch ぶんの校正係数を自動取得する
 *   2. 荷重を見る        … on('converted_press') は係数（無い ch は既定係数）で N に換算済み
 *   3. 校正値を取り直す  … commands.fetchPressureCalibrations()。失敗しても例外は出ず null
 *
 * 係数は profile.pressure_calibrations にセンサー番号順で入る（欠けた ch は null）。
 */
import { DEFAULT_PRESSURE_COEFFICIENTS, OrpheCoreInsole, insoleProfile } from '../src/index.ts';
import type { InsolePress, PressureCalibration } from '../src/index.ts';

/** 荷重は rAF ごとにまとめて描く。バーは 0..BAR_MAX_N を 0..100% にする */
const BAR_MAX_N = 200;

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

// ── デバイス ────────────────────────────────────────────────────────
const profile = insoleProfile();
const ble = new OrpheCoreInsole({
  profile,
  events: {
    onScan: (deviceName) => { q('[data-device]').textContent = deviceName ?? '(no name)'; },
    onDisconnect: () => log('切断されました'),
    onError: (error) => log(`エラー: ${error}`, true),
  },
  log: (message, detail) => {
    console.debug('[INSOLE]', message, detail ?? '');
    // 校正の取得結果（ch ごとの係数・未書込・応答なし）はここに出る
    if (debugLogInput.checked) log(`⚙ ${message}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  },
});

let latestPress: InsolePress | null = null;
ble.on('converted_press', (press) => { latestPress = press; });

// ── 接続・取り直し ──────────────────────────────────────────────────
const connectButton = q<HTMLButtonElement>('[data-connect]');
const refetchButton = q<HTMLButtonElement>('[data-refetch]');
const fwEl = q<HTMLElement>('[data-fw]');
let busy = false;

async function connect(): Promise<void> {
  busy = true;
  try {
    const firmware = await ble.readFirmwareInfo();
    if (!ble.isConnected()) throw new Error('デバイスに接続できませんでした');
    fwEl.textContent = firmware
      ? `FW リリース日 ${firmware.releasedAt.toLocaleDateString()}`
      : 'FW 情報を取得できませんでした（校正値は取得せず、既定係数で換算します）';
    // 圧力を含む mode 4 で計測する。校正値の取得は begin() の中で終わる
    await ble.begin('SENSOR_VALUES', { streamingMode: 4, autoReconnect: true });
    log('begin() 完了');
  } catch (error) {
    log(`接続失敗: ${error}`, true);
  } finally {
    busy = false;
  }
}

function disconnect(): void {
  ble.stop();
  latestPress = null;
  fwEl.textContent = '';
  q('[data-device]').textContent = '';
  log('stop()');
}

async function refetch(): Promise<void> {
  busy = true;
  try {
    const calibrations = await ble.commands.fetchPressureCalibrations();
    log(calibrations ? '校正値を取り直しました' : '校正値を取得できませんでした（既定係数で換算します）', !calibrations);
  } finally {
    busy = false;
  }
}

connectButton.addEventListener('click', () => {
  if (ble.connectionState === 'disconnected') void connect();
  else disconnect();
});
refetchButton.addEventListener('click', () => void refetch());

// ── 描画 ────────────────────────────────────────────────────────────
const bars = [...document.querySelectorAll<HTMLElement>('[data-bar]')];
const vals = [...document.querySelectorAll<HTMLElement>('[data-val]')];
const stateEl = q<HTMLElement>('[data-state]');
const statusEl = q<HTMLElement>('[data-status]');
const calibrationBody = q<HTMLTableSectionElement>('[data-calibration]');
let renderedCalibration: (PressureCalibration | null)[] | null | undefined;

/** 係数の表。係数配列が入れ替わったときだけ作り直す */
function renderCalibration(calibrations: (PressureCalibration | null)[] | null): void {
  if (calibrations === renderedCalibration) return;
  renderedCalibration = calibrations;
  calibrationBody.replaceChildren();
  DEFAULT_PRESSURE_COEFFICIENTS.forEach((defaults, ch) => {
    const calibration = calibrations?.[ch] ?? null;
    const coefficients = calibration ? calibration.coefficients : defaults;
    const func = calibration ? calibration.func : 1;
    const cells = [
      `ch${ch}`,
      calibration ? '個体別係数' : '既定係数',
      String(func),
      ...coefficients.map((c, i) => (func === 0 && i >= 3 ? '（未使用）' : c.toExponential(4))),
    ];
    const row = document.createElement('tr');
    cells.forEach((text, i) => {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) cell.className = 'row';
      cell.textContent = text;
      row.appendChild(cell);
    });
    calibrationBody.appendChild(row);
  });
}

function render(): void {
  const state = ble.connectionState;
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
  connectButton.textContent = state === 'disconnected' ? '接続' : '切断';
  connectButton.disabled = busy;
  refetchButton.disabled = busy || state !== 'connected' || profile.streaming_mode === null;

  const calibrations = profile.pressure_calibrations;
  const calibrated = calibrations?.filter((c) => c !== null).length ?? 0;
  statusEl.textContent =
    busy ? '処理中…'
      : state === 'connecting' || state === 'reconnecting' ? '接続中・校正値未取得'
        : state === 'disconnected' ? '未接続・校正値未取得'
          : calibrated === 6 ? 'デバイスから取得した 6ch の校正値で換算'
            : calibrated > 0 ? `${calibrated}ch は校正値、残りは既定係数で換算`
              : '校正値未取得・既定係数で換算';
  renderCalibration(calibrations);

  const newton = latestPress?.values;
  bars.forEach((bar, i) => {
    const value = newton?.[i];
    bar.style.height = value === undefined ? '0%' : `${Math.min(100, (value / BAR_MAX_N) * 100).toFixed(1)}%`;
    const val = vals[i];
    if (val) val.textContent = value === undefined ? '-' : `${value.toFixed(1)} N`;
  });
}

(function loop() {
  render();
  requestAnimationFrame(loop);
})();
