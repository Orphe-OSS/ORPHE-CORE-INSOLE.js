/**
 * ORPHE CORE の取得モード一覧と、FW リリース日によるしきい値。
 *
 * しきい値を変えるのはこのファイルだけで済む。判定そのものは
 * {@link OrpheCoreInsole.availableModes} が行い、FIFO は {@link FifoRecorder.start} がそれを見て開始を断る。
 */
import type { DeviceMode } from '../device/profile.ts';

/**
 * FIFO 収録に対応した CORE FW の最小リリース日（`YYYYMMDD`）。
 * これより古い FW は FIFO の動作を確認できていないため、モード候補から外す。
 *
 * 20260125 の CORE 3.0 実機で、FIFO のコマンド（`0x0B` / `0x0D`）への応答とデータの回収を確認している。
 * 20260905 より前の FW は現在シリアル応答に watermark / 蓄積数を入れない（0 のまま）が、
 * {@link FifoLoopState.calcRequestRange} がそれを見分けて現在のシリアルから要求を始める。
 */
export const CORE_FIFO_MIN_RELEASE_DATE = 20260125;

/** CORE の取得モード一覧（FW による絞り込み前） */
export const CORE_MODES: readonly DeviceMode[] = Object.freeze([
  Object.freeze({ id: 'STEP_ANALYSIS_AND_SENSOR_VALUES', label: 'Step analysis + sensor values', minReleaseDate: 0 }),
  Object.freeze({ id: 'STEP_ANALYSIS', label: 'Step analysis', minReleaseDate: 0 }),
  Object.freeze({ id: 'SENSOR_VALUES', label: 'Sensor values', minReleaseDate: 0 }),
  Object.freeze({ id: 'FIFO', label: 'Lossless FIFO recording', minReleaseDate: CORE_FIFO_MIN_RELEASE_DATE }),
]);
