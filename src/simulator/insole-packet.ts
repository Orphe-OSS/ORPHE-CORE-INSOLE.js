/**
 * INSOLE の SENSOR_VALUES パケット（104 バイト）を組み立てる。parseInsoleSensorValues の逆変換。
 * シミュレータが実機と同じパース経路を通すために使う。
 */
import type { Quat, Vec3 } from '../protocol/geometry.ts';

/** パケットに詰める 1 サンプル（物理値） */
export interface InsolePacketFrame {
  /** 加速度 [G] */
  acc?: Vec3 | null;
  /** 角速度 [dps] */
  gyro?: Vec3 | null;
  /** クォータニオン */
  quat?: Quat | null;
  /** 6ch 圧力の生値（0..65535） */
  press?: readonly number[] | null;
}

/** encodeInsoleSensorValues の入力 */
export interface InsolePacketInput {
  /** 50（mode 1: 姿勢）/ 55（mode 3: 圧力 + IMU）/ 56（mode 4: 全センサー） */
  header: 50 | 55 | 56;
  /** パケット通し番号（uint16） */
  serial: number;
  /** パケットの基準時刻 */
  time: Date;
  /** 古い順のサンプル。header 50 / 55 は 4 個、56 は 2 個 */
  frames: readonly InsolePacketFrame[];
  /** header 50 のサンプル間隔 [ms]。既定 5 */
  intervalMs?: number;
  /** 加速度のフルスケール [G]。既定 16 */
  accRange?: number;
  /** 角速度のフルスケール [dps]。既定 2000 */
  gyroRange?: number;
}

const INT16_MIN = -32768;
const INT16_MAX = 32767;

function int16(value: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return Math.min(INT16_MAX, Math.max(INT16_MIN, rounded));
}

function uint16(value: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return Math.min(65535, Math.max(0, rounded));
}

/** header ごとのサンプル数 */
export function insolePacketFrameCount(header: 50 | 55 | 56): number {
  return header === 56 ? 2 : 4;
}

/** 物理値のサンプル列から SENSOR_VALUES パケットを作る */
export function encodeInsoleSensorValues(input: InsolePacketInput): DataView {
  const data = new DataView(new ArrayBuffer(104));
  const accRange = input.accRange ?? 16;
  const gyroDpsPerLsb = (input.gyroRange ?? 2000) * 0.000035;
  const count = insolePacketFrameCount(input.header);

  data.setUint8(0, input.header);
  data.setUint16(1, input.serial & 0xffff);
  data.setUint8(3, input.time.getHours());
  data.setUint8(4, input.time.getMinutes());
  data.setUint8(5, input.time.getSeconds());
  data.setUint16(6, input.time.getMilliseconds());

  const vec = (offset: number, value: Vec3 | null | undefined, toRaw: (v: number) => number) => {
    data.setInt16(offset, int16(toRaw(value?.x ?? 0)));
    data.setInt16(offset + 2, int16(toRaw(value?.y ?? 0)));
    data.setInt16(offset + 4, int16(toRaw(value?.z ?? 0)));
  };
  const accRaw = (g: number) => (g / accRange) * 32768;
  const gyroRaw = (dps: number) => dps / gyroDpsPerLsb;
  const quat = (offset: number, value: Quat | null | undefined) => {
    data.setInt16(offset, int16((value?.w ?? 1) * 16384));
    data.setInt16(offset + 2, int16((value?.x ?? 0) * 16384));
    data.setInt16(offset + 4, int16((value?.y ?? 0) * 16384));
    data.setInt16(offset + 6, int16((value?.z ?? 0) * 16384));
  };
  const press = (offset: number, values: readonly number[] | null | undefined) => {
    for (let ch = 0; ch < 6; ch++) data.setUint16(offset + ch * 2, uint16(values?.[ch] ?? 0));
  };

  for (let k = 0; k < count; k++) {
    const frame = input.frames[k] ?? {};
    if (input.header === 50) {
      const i = 3 - k;
      const base = 8 + 21 * i;
      quat(base, frame.quat);
      vec(base + 8, frame.gyro, gyroRaw);
      vec(base + 14, frame.acc, accRaw);
      if (i !== 3) data.setUint8(28 + 21 * i, input.intervalMs ?? 5);
    } else if (input.header === 55) {
      const base = 8 + 24 * (3 - k);
      vec(base, frame.gyro, gyroRaw);
      vec(base + 6, frame.acc, accRaw);
      press(base + 12, frame.press);
    } else {
      const base = 8 + 32 * (1 - k);
      quat(base, frame.quat);
      vec(base + 8, frame.gyro, gyroRaw);
      vec(base + 14, frame.acc, accRaw);
      press(base + 20, frame.press);
    }
  }
  return data;
}
