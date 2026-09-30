/**
 * 加速度・角速度のレンジ設定（device information の index 0..3）と物理値の対応。
 */

/** 加速度レンジ設定 index（0..3）→ 物理フルスケール値 [G] */
export const ACC_RANGES = Object.freeze([2, 4, 8, 16] as const);
/** ジャイロレンジ設定 index（0..3）→ 物理フルスケール値 [dps] */
export const GYRO_RANGES = Object.freeze([250, 500, 1000, 2000] as const);

/** レンジ設定を取得できないときの加速度レンジ [G] */
export const DEFAULT_ACC_RANGE = 16;
/** レンジ設定を取得できないときのジャイロレンジ [dps] */
export const DEFAULT_GYRO_RANGE = 2000;

/** フルスケール 1 dps あたりの感度 [dps/LSB]（LSM6DSOX 代表値。±2000dps → 70 mdps/LSB） */
export const GYRO_DPS_PER_LSB_PER_RANGE = 0.000035;

/** 加速度・角速度のフルスケール（物理値）。 */
export interface ImuRange {
  /** 加速度レンジ [G]（2 / 4 / 8 / 16） */
  acc: number;
  /** 角速度レンジ [dps]（250 / 500 / 1000 / 2000） */
  gyro: number;
}

// setting は getUint8 由来の index のみ受け付ける（範囲外・非整数は fallback）
function rangeFromSetting(ranges: readonly number[], setting: unknown, fallback: number): number {
  return typeof setting === 'number' && Number.isInteger(setting) && setting >= 0 && setting < ranges.length
    ? ranges[setting]!
    : fallback;
}

/** device information のレンジ設定（index）→ 物理値。未取得・範囲外は ±16G / ±2000dps。 */
export function imuRangeFromSettings(range: { acc?: unknown; gyro?: unknown } | null | undefined): ImuRange {
  return {
    acc: rangeFromSetting(ACC_RANGES, range?.acc, DEFAULT_ACC_RANGE),
    gyro: rangeFromSetting(GYRO_RANGES, range?.gyro, DEFAULT_GYRO_RANGE),
  };
}

/** ジャイロの int16 生値 → dps。`gyroRange` はフルスケール [dps]。 */
export function gyroRawToDps(raw: number, gyroRange: number): number {
  return raw * gyroRange * GYRO_DPS_PER_LSB_PER_RANGE;
}
