/**
 * OrpheInsoleSimulator — 実機なしで INSOLE アプリを開発・デモするためのシミュレータ。
 * OrpheInsole と同じ `new OrpheInsoleSimulator(0)` + `gotPress = …` の呼び出し形で、
 * 20ms ごとに合成データ（walk / stand / sway）または渡したフレーム列を配送する。
 *
 * タイムスタンプは epoch ms ではなく begin() からの経過時間 [ms]。
 */
import type {
  InsoleParsedSample,
  InsolePress,
  InsoleSampleStamp,
  InsoleSensorPacket,
  InsoleStampedQuat,
  InsoleStampedVec3,
} from '../profiles/insole.ts';
import type { EulerAngles, Quat, Vec3 } from '../protocol/geometry.ts';
import {
  cloneEuler,
  cloneQuat,
  cloneVector3,
  finiteNumber,
  generatedFrame,
  normalizePress,
} from '../simulator/synthetic.ts';
import type { InsoleSimulatorFrame, InsoleSimulatorPreset } from '../simulator/synthetic.ts';

export type { InsoleSimulatorFrame } from '../simulator/synthetic.ts';
type SimulatorPreset = InsoleSimulatorPreset;

const ACC_RANGE = 16;
const GYRO_RANGE = 2000;
// 正規化値は実機パケットのパースと同じ規則で作る（gyro = raw/32768, converted_gyro = raw × 感度）。
// つまり 正規化値 = 物理値[dps] / (32768 × 0.07) であり、物理値 / GYRO_RANGE ではない。
// LSM6DSOX 代表感度: フルスケール1dpsあたり 0.035 mdps/LSB → ±2000dps で 0.07 dps/LSB。
const GYRO_DPS_PER_LSB = GYRO_RANGE * 0.000035;
const GYRO_NORMALIZE_FULL_SCALE = GYRO_DPS_PER_LSB * 32768;
const TICK_MS = 20;
const SENSOR_VALUES_UUID = 'SENSOR_VALUES';

/** begin() のオプション */
export interface InsoleSimulatorBeginOptions {
  /** データストリーミングモード（1 / 3 / 4）。既定 4 */
  streamingMode?: number;
  /** 合成データのプリセット（既定 'walk'）。frames 指定時は無視される */
  preset?: 'walk' | 'stand' | 'sway';
  /** CSV 等から作ったフレーム配列の再生 */
  frames?: readonly InsoleSimulatorFrame[];
  /** frames 再生をループするか（既定 true）。false なら末尾で stop() する */
  loop?: boolean;
}

/** setup() で設定する補間オプション */
export interface InsoleSimulatorInterpolation {
  enabled: boolean;
  max_consecutive_missing: number;
}

/** シミュレータのデバイス情報 */
export interface InsoleSimulatorDeviceInformation {
  battery: number;
  /** id=0 は 0 (LEFT)、それ以外は 1 (RIGHT) */
  mount_position: number;
  range: { acc: number; gyro: number };
}

/** addSensorDataListener() に届くイベント。実機と違い data は null */
export interface InsoleSimulatorSensorDataEvent {
  readonly deviceId: number;
  readonly receivedAt: number;
  readonly packet: InsoleSensorPacket;
  readonly data: null;
}

/** Euler 角 + サンプルのメタ情報 */
export type InsoleSimulatorStampedEuler = EulerAngles & InsoleSampleStamp;

function normalizeVector3(value: Vec3 | null, range: number): Vec3 | null {
  if (!value) return null;
  return {
    x: value.x / range,
    y: value.y / range,
    z: value.z / range,
  };
}

function withSampleMeta<T extends object>(
  value: T,
  timestamp: number,
  serialNumber: number,
  packetNumber: number,
): T & InsoleSampleStamp {
  return Object.assign({}, value, {
    timestamp,
    serial_number: serialNumber,
    packet_number: packetNumber,
  });
}

function normalizeStreamingMode(value: unknown): number {
  const mode = value === undefined || value === null ? 4 : Number(value);
  if (mode === 1 || mode === 3 || mode === 4) return mode;
  throw new TypeError('Invalid ORPHE INSOLE simulator streaming mode');
}

function samplesPerTick(streamingMode: number): number {
  return streamingMode === 4 ? 2 : 4;
}

function normalizeBeginArgs(
  type: string | InsoleSimulatorBeginOptions | undefined,
  options: InsoleSimulatorBeginOptions | undefined,
): InsoleSimulatorBeginOptions {
  if (type && typeof type === 'object') {
    return Object.assign({}, type);
  }
  return Object.assign({}, options || {});
}

function defaultDeviceInformation(id: number): InsoleSimulatorDeviceInformation {
  return {
    battery: 2,
    mount_position: id === 0 ? 0 : 1,
    range: { acc: 3, gyro: 3 },
  };
}

export class OrpheInsoleSimulator {
  /** デバイス番号。0 は左足、それ以外は右足として合成データを作る */
  id: number;
  debug = false;
  /** begin() または getDeviceInformation() で設定される。それまでは null */
  device_information: InsoleSimulatorDeviceInformation | null = null;
  /** 加速度（-1..1 の正規化値） */
  acc: InsoleStampedVec3 | null = null;
  /** 角速度（-1..1 の正規化値） */
  gyro: InsoleStampedVec3 | null = null;
  quat: InsoleStampedQuat | null = null;
  euler: InsoleSimulatorStampedEuler | null = null;
  /** 6ch 圧力の生値 */
  press: InsolePress | null = null;
  /** 加速度 [G] */
  converted_acc: InsoleStampedVec3 | null = null;
  /** 角速度 [dps] */
  converted_gyro: InsoleStampedVec3 | null = null;
  interpolation: InsoleSimulatorInterpolation = { enabled: false, max_consecutive_missing: 1 };
  /** setup() で渡した characteristic 名 */
  declare names?: string[];
  /** 現在のデータストリーミングモード。begin() 前は undefined */
  declare streaming_mode?: number;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _serial = 0;
  private _sampleIndex = 0;
  private _startedAt = 0;
  private _streamingMode = 4;
  private _preset: SimulatorPreset = 'walk';
  private _frames: InsoleSimulatorFrame[] | null = null;
  private _frameIndex = 0;
  private _loop = true;
  private _sensorDataListeners = new Set<(event: InsoleSimulatorSensorDataEvent) => void>();

  constructor(id = 0) {
    this.id = id;
  }

  /** OrpheInsole と同じ初期化。補間設定を保持するだけで、シミュレータの出力には影響しない */
  setup(
    names: string | string[] = ['DEVICE_INFORMATION', 'DATE_TIME', 'SENSOR_VALUES'],
    options: { interpolation?: Partial<InsoleSimulatorInterpolation> } = {},
  ): this {
    const defaultInterpolation = { enabled: false, max_consecutive_missing: 1 };
    const interpolation = options && typeof options.interpolation === 'object' ? options.interpolation : {};
    this.names = Array.isArray(names) ? names.slice() : [names];
    this.interpolation = Object.assign({}, defaultInterpolation, interpolation);
    return this;
  }

  /**
   * 配送を開始する。onScan → onConnect → onStartNotify の順に呼んだあと、
   * 最初の tick を同期的に配送する。
   * 失敗は onError に報告したうえで reject する。
   */
  async begin(type?: string | InsoleSimulatorBeginOptions, options?: InsoleSimulatorBeginOptions): Promise<string> {
    try {
      const beginOptions = normalizeBeginArgs(type, options);
      this.stop({ silent: true });
      this._streamingMode = normalizeStreamingMode(beginOptions.streamingMode);
      this.streaming_mode = this._streamingMode;
      this._preset = beginOptions.preset === 'stand' || beginOptions.preset === 'sway' ? beginOptions.preset : 'walk';
      this._frames = this._normalizeFrames(beginOptions.frames);
      this._loop = beginOptions.loop !== false;
      this._frameIndex = 0;
      this._sampleIndex = 0;
      this._serial = 0;
      this._startedAt = this._now();
      this.device_information = defaultDeviceInformation(this.id);
      this._connected = true;
      this.onScan(`ORPHE INSOLE Simulator ${this.id}`);
      this.onConnect('SIMULATOR');
      this.onStartNotify(SENSOR_VALUES_UUID);
      this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
      return 'done begin(); SENSOR VALUES';
    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  /** 配送を止める。接続中だった場合は onDisconnect を呼ぶ（silent: true なら呼ばない） */
  stop(options: { silent?: boolean } = {}): string {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const wasConnected = this._connected;
    this._connected = false;
    if (wasConnected && !options.silent) this.onDisconnect();
    return 'done stop();';
  }

  /** 配送を止め、最新値と連番をクリアして onReset を呼ぶ */
  reset(): void {
    this.stop();
    this._serial = 0;
    this._sampleIndex = 0;
    this._frameIndex = 0;
    this.acc = null;
    this.gyro = null;
    this.quat = null;
    this.euler = null;
    this.press = null;
    this.converted_acc = null;
    this.converted_gyro = null;
    this.onReset();
  }

  /**
   * パケット単位（1 tick 分のサンプル列）のリスナーを登録する。
   * @returns 登録解除関数
   */
  addSensorDataListener(listener: (event: InsoleSimulatorSensorDataEvent) => void): () => boolean {
    if (typeof listener !== 'function') {
      throw new TypeError('OrpheInsoleSimulator.addSensorDataListener expects a function');
    }
    this._sensorDataListeners.add(listener);
    return () => this.removeSensorDataListener(listener);
  }

  /** addSensorDataListener() で登録したリスナーを外す */
  removeSensorDataListener(listener: (event: InsoleSimulatorSensorDataEvent) => void): boolean {
    return this._sensorDataListeners.delete(listener);
  }

  isConnected(): boolean {
    return this._connected;
  }

  /**
   * ストリーミングモードを切り替える。
   * 実行中でも次 tick から新モードのデータ有無・サンプル数が反映される。
   * 不正なモードは OrpheInsole と同じメッセージで onError に報告したうえで reject する。
   */
  async setDataStreamingMode(mode: number): Promise<void> {
    const normalized = Number(mode);
    if (normalized !== 1 && normalized !== 3 && normalized !== 4) {
      const error = new TypeError('Invalid ORPHE INSOLE data streaming mode');
      this.onError(error);
      throw error;
    }
    this._streamingMode = normalized;
    this.streaming_mode = normalized;
  }

  /** デバイス情報を返す。begin 前でも既定値を返す */
  async getDeviceInformation(): Promise<InsoleSimulatorDeviceInformation> {
    if (!this.device_information) {
      this.device_information = defaultDeviceInformation(this.id);
    }
    return this.device_information;
  }

  /** シミュレータでは固定文字列 "simulator" を返す */
  async getFirmwareVersion(): Promise<string> {
    return 'simulator';
  }

  /** シミュレータに解析ログはないので何もしない */
  resetAnalysisLogs(): void { }

  private _normalizeFrames(frames: readonly InsoleSimulatorFrame[] | undefined): InsoleSimulatorFrame[] | null {
    if (!Array.isArray(frames) || frames.length === 0) return null;
    const list: readonly InsoleSimulatorFrame[] = frames;
    const matching = list.filter((frame) => frame && (frame.device === undefined || Number(frame.device) === Number(this.id)));
    return (matching.length > 0 ? matching : list).slice();
  }

  private _now(): number {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf && typeof perf.now === 'function') {
      return perf.now();
    }
    return Date.now();
  }

  private _tick(): void {
    if (!this._connected) return;
    this.gotBLEFrequency(50);
    const count = samplesPerTick(this._streamingMode);
    const interval = TICK_MS / count;
    const tickTime = this._now() - this._startedAt;
    const serialNumber = this._serial;
    this._serial = (this._serial + 1) % 65536;
    const packetSamples: InsoleParsedSample[] = [];
    for (let packetNumber = 0; packetNumber < count; packetNumber++) {
      const timestamp = Math.round(tickTime + packetNumber * interval);
      const frame = this._nextFrame(timestamp);
      if (!frame) {
        this.stop();
        return;
      }
      const frameSerial = frame.serial === undefined ? serialNumber : finiteNumber(frame.serial, serialNumber);
      const framePacketNumber = frame.packet_number === undefined ? packetNumber : finiteNumber(frame.packet_number, packetNumber);
      packetSamples.push(this._dispatchFrame(frame, timestamp, frameSerial, framePacketNumber));
      this._sampleIndex += 1;
    }
    if (this._sensorDataListeners.size > 0) {
      const packet: InsoleSensorPacket = {
        header: this._streamingMode === 4 ? 56 : this._streamingMode === 1 ? 50 : 55,
        serial_number: serialNumber,
        timestamp: Math.round(tickTime),
        samples: packetSamples,
      };
      const event: InsoleSimulatorSensorDataEvent = Object.freeze({
        deviceId: this.id,
        receivedAt: Date.now(),
        packet,
        data: null,
      });
      for (const listener of Array.from(this._sensorDataListeners)) {
        try { listener(event); } catch (error) { this.onError(error); }
      }
    }
  }

  private _nextFrame(timestamp: number): InsoleSimulatorFrame | null | undefined {
    if (!this._frames) {
      return generatedFrame(this.id, this._preset, timestamp);
    }
    if (this._frameIndex >= this._frames.length) {
      if (!this._loop) return null;
      this._frameIndex = 0;
    }
    const frame = this._frames[this._frameIndex];
    this._frameIndex += 1;
    return frame;
  }

  // got* の呼び出し順: acc → gyro → converted_acc → converted_gyro → quat → euler → press
  private _dispatchFrame(
    frame: InsoleSimulatorFrame,
    timestamp: number,
    serialNumber: number,
    packetNumber: number,
  ): InsoleParsedSample {
    const frameTimestamp = frame.t === undefined ? timestamp : finiteNumber(frame.t, timestamp);
    const convertedAcc = cloneVector3(frame.acc);
    const convertedGyro = cloneVector3(frame.gyro);
    const normalizedAcc = normalizeVector3(convertedAcc, ACC_RANGE);
    const normalizedGyro = normalizeVector3(convertedGyro, GYRO_NORMALIZE_FULL_SCALE);
    const quat = cloneQuat(frame.quat);
    const euler = cloneEuler(frame.euler);
    const pressValues = normalizePress(frame.press);

    if (normalizedAcc) {
      this.acc = withSampleMeta(normalizedAcc, frameTimestamp, serialNumber, packetNumber);
      this.gotAcc(this.acc);
    }
    if (normalizedGyro) {
      this.gyro = withSampleMeta(normalizedGyro, frameTimestamp, serialNumber, packetNumber);
      this.gotGyro(this.gyro);
    }
    if (convertedAcc) {
      this.converted_acc = withSampleMeta(convertedAcc, frameTimestamp, serialNumber, packetNumber);
      this.gotConvertedAcc(this.converted_acc);
    }
    if (convertedGyro) {
      this.converted_gyro = withSampleMeta(convertedGyro, frameTimestamp, serialNumber, packetNumber);
      this.gotConvertedGyro(this.converted_gyro);
    }
    if (this._streamingMode !== 3 && quat) {
      this.quat = withSampleMeta(quat, frameTimestamp, serialNumber, packetNumber);
      this.gotQuat(this.quat);
      if (euler) {
        this.euler = withSampleMeta(euler, frameTimestamp, serialNumber, packetNumber);
        this.gotEuler(this.euler);
      }
    }
    if (this._streamingMode !== 1 && pressValues) {
      this.press = {
        values: pressValues,
        timestamp: frameTimestamp,
        serial_number: serialNumber,
        packet_number: packetNumber,
      };
      this.gotPress(this.press);
    }
    return {
      timestamp: frameTimestamp,
      serial_number: serialNumber,
      packet_number: packetNumber,
      ...(this.quat && this._streamingMode !== 3 ? { quat: { ...this.quat } } : {}),
      ...(this.gyro ? { gyro: { ...this.gyro } } : {}),
      ...(this.acc ? { acc: { ...this.acc } } : {}),
      ...(this.converted_gyro ? { converted_gyro: { ...this.converted_gyro } } : {}),
      ...(this.converted_acc ? { converted_acc: { ...this.converted_acc } } : {}),
      ...(this.press && this._streamingMode !== 1
        ? { press: { ...this.press, values: [...this.press.values] } }
        : {}),
    };
  }

  // ─── コールバック（インスタンスに代入して使う） ─────────────────

  gotPress(_press: InsolePress): void { }
  gotAcc(_acc: InsoleStampedVec3): void { }
  gotGyro(_gyro: InsoleStampedVec3): void { }
  gotQuat(_quat: InsoleStampedQuat): void { }
  gotEuler(_euler: InsoleSimulatorStampedEuler): void { }
  gotConvertedAcc(_acc: InsoleStampedVec3): void { }
  gotConvertedGyro(_gyro: InsoleStampedVec3): void { }
  gotBLEFrequency(_frequency: number): void { }
  /** シミュレータでは欠損が起きないので呼ばれない */
  lostData(_serialNumber: number, _serialNumberPrev: number): void { }
  onConnect(_uuid: string): void { }
  onDisconnect(): void { }
  onError(_error: unknown): void { }
  onScan(_deviceName: string): void { }
  onStartNotify(_uuid: string): void { }
  onReset(): void { }
}
