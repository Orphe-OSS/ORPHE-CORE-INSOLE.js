/**
 * INSOLE シミュレータの合成データ（walk / stand / sway）とフレーム定義。
 * 新 API のシミュレータ（insoleSimulatorBluetooth）と互換の OrpheInsoleSimulator が共有する。
 */
import type { EulerAngles, Quat, Vec3 } from '../protocol/geometry.ts';

const SENSOR_COUNT = 6;
const MAX_UINT16 = 65535;

// 合成圧力の重み付けに使う足ローカル座標
const SYNTHETIC_SENSOR_LAYOUT: readonly { x: number; y: number }[] = [
  { x: -0.18, y: 0.42 },
  { x: -0.10, y: 0.18 },
  { x: 0.14, y: 0.38 },
  { x: 0.02, y: 0.10 },
  { x: 0.18, y: -0.06 },
  { x: -0.02, y: -0.42 },
];

/** 再生する 1 フレーム。省略したセンサは配送しない */
export interface InsoleSimulatorFrame {
  /** このフレームを流すデバイス id。一致するフレームが無ければ全フレームを使う */
  device?: number;
  /** サンプル時刻 [ms]。省略時は begin() からの経過時間 */
  t?: number;
  /** serial_number。省略時は tick ごとの連番 */
  serial?: number;
  /** packet_number。省略時はパケット内の順番 */
  packet_number?: number;
  /** 6ch 圧力の生値（0..65535 に丸め・クランプされる） */
  press?: readonly number[] | null;
  /** 加速度 [G] */
  acc?: Vec3 | null;
  /** 角速度 [dps] */
  gyro?: Vec3 | null;
  quat?: Quat | null;
  /** Euler 角 [rad]（quat があるときだけ配送する） */
  euler?: EulerAngles | null;
}

/** 合成データのプリセット */
export type InsoleSimulatorPreset = 'walk' | 'stand' | 'sway';


export interface GeneratedFrame {
  press: number[];
  acc: Vec3;
  gyro: Vec3;
  quat: Quat;
  euler: EulerAngles;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function deterministicNoise(seed: number, amp: number): number {
  return Math.sin(seed * 12.9898 + 78.233) * amp;
}

function bump(phase: number, center: number, width: number): number {
  let distance = Math.abs(phase - center);
  if (distance > 0.5) distance = 1 - distance;
  return Math.exp(-(distance * distance) / (2 * width * width));
}

export function eulerToQuat(pitch: number, roll: number, yaw: number): Quat {
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  return {
    w: cy * cr * cp + sy * sr * sp,
    x: cy * cr * sp - sy * sr * cp,
    y: cy * sr * cp + sy * cr * sp,
    z: sy * cr * cp - cy * sr * sp,
  };
}

export function cloneVector3(value: Vec3 | null | undefined): Vec3 | null {
  if (!value) return null;
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    z: finiteNumber(value.z),
  };
}

export function cloneQuat(value: Quat | null | undefined): Quat | null {
  if (!value) return null;
  return {
    w: finiteNumber(value.w, 1),
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    z: finiteNumber(value.z),
  };
}

export function cloneEuler(value: EulerAngles | null | undefined): EulerAngles | null {
  if (!value) return null;
  return {
    pitch: finiteNumber(value.pitch),
    roll: finiteNumber(value.roll),
    yaw: finiteNumber(value.yaw),
  };
}

export function normalizePress(values: unknown): number[] | null {
  if (!Array.isArray(values)) return null;
  const press = values.slice(0, SENSOR_COUNT).map((value) => clamp(Math.round(finiteNumber(value)), 0, MAX_UINT16));
  while (press.length < SENSOR_COUNT) press.push(0);
  return press;
}

function generateFootPressureFromTarget(localTarget: { x: number; y: number }, targetLoad: number, phase: number): number[] {
  const sigmaX = 0.17;
  const sigmaY = 0.27;
  const weights = SYNTHETIC_SENSOR_LAYOUT.map((sensor, index) => {
    const dx = (sensor.x - localTarget.x) / sigmaX;
    const dy = (sensor.y - localTarget.y) / sigmaY;
    const pulse = 0.04 * Math.sin(phase + index * 1.73);
    return 0.12 + Math.exp(-0.5 * (dx * dx + dy * dy)) + pulse;
  });
  const sum = weights.reduce((total, value) => total + Math.max(0.01, value), 0);
  return weights.map((weight, index) => {
    const breathing = 1 + 0.025 * Math.sin(phase * 0.7 + index);
    return Math.max(0, Math.round(targetLoad * Math.max(0.01, weight) / sum * breathing));
  });
}

function generateWalkFrame(id: number, timeMs: number): GeneratedFrame {
  const cycleMs = 1200;
  const mirror = id !== 0;
  const phase = ((timeMs % cycleMs) / cycleMs + (mirror ? 0.5 : 0)) % 1;
  const sideSign = mirror ? -1 : 1;
  const stance = 0.6;
  const noise = (seed: number, amp: number): number => deterministicNoise(timeMs * 0.001 + seed + id * 17, amp);
  const press = [
    7600 * bump(phase, 0.52, 0.09),
    12000 * bump(phase, 0.42, 0.12),
    5800 * bump(phase, 0.48, 0.09),
    10500 * bump(phase, 0.38, 0.12),
    6400 * bump(phase, 0.25, 0.14),
    13500 * bump(phase, 0.12, 0.11),
  ].map((value, index) => clamp(Math.round(value + noise(index, 90)), 0, MAX_UINT16));
  const impact = 1.6 * bump(phase, 0.03, 0.02);
  const acc = {
    x: sideSign * 0.25 * Math.sin(2 * Math.PI * phase) + noise(10, 0.03),
    y: 0.12 * Math.sin(2 * Math.PI * phase * 2 + 1) + noise(11, 0.03),
    z: 1.0 + impact + 0.18 * Math.sin(2 * Math.PI * phase * 2) + noise(12, 0.04),
  };
  const swing = phase > stance ? Math.sin(Math.PI * (phase - stance) / (1 - stance)) : 0;
  const gyro = {
    x: sideSign * 30 * Math.sin(2 * Math.PI * phase * 2) + noise(20, 8),
    y: 380 * swing - 90 * bump(phase, 0.55, 0.05) + noise(21, 8),
    z: sideSign * 20 * Math.sin(2 * Math.PI * phase + 2) + noise(22, 8),
  };
  const pitch = -0.45 * bump(phase, 0.62, 0.07) + 0.30 * bump(phase, 0.82, 0.1);
  const roll = sideSign * (0.08 * Math.sin(2 * Math.PI * phase) + 0.02 * Math.sin(timeMs / 900));
  const yaw = sideSign * 0.06 * Math.sin(timeMs / 1500);
  const euler = { pitch, roll, yaw };
  return { press, acc, gyro, quat: eulerToQuat(pitch, roll, yaw), euler };
}

function generateSwayFrame(id: number, timeMs: number, standStill: boolean): GeneratedFrame {
  const timeSeconds = timeMs / 1000;
  const sideSign = id === 0 ? -1 : 1;
  const swayScale = standStill ? 0.3 : 1;
  const swayX = swayScale * (0.035 * Math.sin(timeSeconds * 1.15) + 0.014 * Math.sin(timeSeconds * 3.2 + 0.8));
  const swayY = swayScale * (0.055 * Math.sin(timeSeconds * 0.82 + 0.5) + 0.015 * Math.sin(timeSeconds * 2.6));
  const localTarget = {
    x: clamp(swayX * sideSign * 0.42, -0.16, 0.16),
    y: clamp(swayY, -0.42, 0.42),
  };
  const totalLoad = (standStill ? 5200 : 6200) + (standStill ? 80 : 260) * Math.sin(timeSeconds * 0.45);
  const press = generateFootPressureFromTarget(localTarget, totalLoad / 2, timeSeconds + id * 1.1);
  const acc = {
    x: swayX * 0.4,
    y: swayY * 0.25,
    z: 1 + 0.015 * Math.sin(timeSeconds * 1.4 + id),
  };
  const gyro = {
    x: 3.5 * Math.sin(timeSeconds * 1.1 + id),
    y: 5.5 * Math.sin(timeSeconds * 0.9),
    z: 2.5 * Math.sin(timeSeconds * 1.6 + id * 0.5),
  };
  const euler = {
    pitch: swayY * 0.14,
    roll: sideSign * swayX * 0.16,
    yaw: sideSign * 0.01 * Math.sin(timeSeconds * 0.6),
  };
  return { press, acc, gyro, quat: eulerToQuat(euler.pitch, euler.roll, euler.yaw), euler };
}

export function generatedFrame(id: number, preset: InsoleSimulatorPreset, timeMs: number): GeneratedFrame {
  if (preset === 'stand') return generateSwayFrame(id, timeMs, true);
  if (preset === 'sway') return generateSwayFrame(id, timeMs, false);
  return generateWalkFrame(id, timeMs);
}

