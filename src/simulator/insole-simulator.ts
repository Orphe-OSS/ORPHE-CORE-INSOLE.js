/**
 * 実機なしで ORPHE INSOLE を扱うシミュレータ（新 API 版）。
 *
 *   const ble = createInsoleSimulator(0, { preset: 'walk' });
 *   ble.on('press', (press) => console.log(press.values));
 *   await ble.begin('SENSOR_VALUES', { streamingMode: 4 });
 *
 * Web Bluetooth の代わりに擬似デバイスを注入するので、OrpheCoreInsole の begin / on / commands /
 * lost_data / ble_frequency が実機と同じ経路（パケットのパース）で動く。
 * 擬似デバイスは 20ms ごとに SENSOR_VALUES を notify し、DEVICE_INFORMATION への
 * ストリーミングモード切替（0x0d）にも従う。FIFO・歩容解析（STEP_ANALYSIS）・FW 情報は持たない。
 */
import type {
  BleBluetooth,
  BleBufferSource,
  BleCharacteristic,
  BleDevice,
  BleGattServer,
  BleGattService,
  BleValueChangedEvent,
  StorageLike,
} from '../ble/web-bluetooth.ts';
import { ORPHE_UUID } from '../protocol/uuids.ts';
import { encodeDateTime } from '../protocol/datetime.ts';
import { DEVICE_INFORMATION_OPCODE } from '../protocol/commands.ts';
import { OrpheCoreInsole } from '../device/orphe-core-insole.ts';
import type { OrpheCoreInsoleOptions } from '../device/orphe-core-insole.ts';
import { insoleProfile } from '../profiles/insole.ts';
import type { InsoleCommands, InsoleProfile, InsoleProfileOptions, InsoleSensorFields } from '../profiles/insole.ts';
import { encodeInsoleSensorValues, insolePacketFrameCount } from './insole-packet.ts';
import type { InsolePacketFrame } from './insole-packet.ts';
import { generatedFrame } from './synthetic.ts';
import type { InsoleSimulatorFrame, InsoleSimulatorPreset } from './synthetic.ts';

const TICK_MS = 20;

/** シミュレータの設定 */
export interface InsoleSimulatorOptions {
  /** 合成データのプリセット（既定 'walk'）。frames 指定時は使わない */
  preset?: InsoleSimulatorPreset;
  /** 再生するフレーム列（CSV などから作る）。device が一致するものだけを使う */
  frames?: readonly InsoleSimulatorFrame[];
  /** frames を末尾でループするか（既定 true）。false なら末尾で切断する */
  loop?: boolean;
  /** 取付位置（0 = 左 / 1 = 右）。既定は id が 0 なら左、それ以外は右 */
  mountPosition?: number;
  /** バッテリー残量（0..2）。既定 2 */
  battery?: number;
}

/** 擬似 characteristic */
class SimCharacteristic implements BleCharacteristic {
  private readonly listeners = new Set<(event: BleValueChangedEvent) => void>();
  value: DataView = new DataView(new ArrayBuffer(20));
  onWrite: ((bytes: Uint8Array) => void) | null = null;
  onNotify: ((on: boolean) => void) | null = null;

  async readValue(): Promise<DataView> {
    return this.value;
  }

  async writeValue(data: BleBufferSource): Promise<void> {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.onWrite?.(new Uint8Array(bytes));
  }

  async startNotifications(): Promise<unknown> {
    this.onNotify?.(true);
    return this;
  }

  async stopNotifications(): Promise<unknown> {
    this.onNotify?.(false);
    return this;
  }

  addEventListener(_type: string, listener: (event: BleValueChangedEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: BleValueChangedEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(value: DataView): void {
    for (const listener of [...this.listeners]) listener({ target: { value } });
  }
}

/** 擬似 INSOLE デバイス（GATT サーバと 20ms ごとの notify を持つ） */
class SimInsoleDevice implements BleDevice, BleGattServer {
  readonly id: string;
  readonly name: string;
  connected = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private readonly services: Record<string, Record<string, SimCharacteristic>>;
  private readonly sensor = new SimCharacteristic();
  private readonly options: InsoleSimulatorOptions;
  private readonly slot: number;
  private streamingMode = 4;
  private timer: ReturnType<typeof setInterval> | null = null;
  private serial = 0;
  private startedAt = 0;
  private frameIndex = 0;
  private readonly frames: InsoleSimulatorFrame[] | null;

  constructor(slot: number, options: InsoleSimulatorOptions) {
    this.slot = slot;
    this.options = options;
    this.id = `insole-simulator-${slot}`;
    this.name = `INS-SIM-${slot}`;
    const list = options.frames && options.frames.length > 0 ? [...options.frames] : null;
    const matching = list?.filter(frame => frame.device === undefined || Number(frame.device) === slot) ?? null;
    this.frames = matching && matching.length > 0 ? matching : list;

    const info = new SimCharacteristic();
    const infoData = new DataView(new ArrayBuffer(20));
    infoData.setUint8(0, options.battery ?? 2);
    infoData.setUint8(1, options.mountPosition ?? (slot === 0 ? 0 : 1));
    infoData.setUint8(8, 3); // ±16G
    infoData.setUint8(9, 3); // ±2000dps
    info.value = infoData;
    info.onWrite = (bytes) => {
      if (bytes[0] === DEVICE_INFORMATION_OPCODE.SET_STREAMING_MODE && [1, 3, 4].includes(bytes[1] ?? 0)) {
        this.streamingMode = bytes[1]!;
      }
    };
    const dateTime = new SimCharacteristic();
    dateTime.value = new DataView(encodeDateTime(new Date()).buffer);
    dateTime.onWrite = () => {
      dateTime.value = new DataView(encodeDateTime(new Date()).buffer);
    };
    this.sensor.onNotify = (on) => (on ? this.startStreaming() : this.stopStreaming());

    this.services = {
      [ORPHE_UUID.INFORMATION_SERVICE]: {
        [ORPHE_UUID.DEVICE_INFORMATION]: info,
        [ORPHE_UUID.DATE_TIME]: dateTime,
      },
      [ORPHE_UUID.OTHER_SERVICE]: {
        [ORPHE_UUID.SENSOR_VALUES]: this.sensor,
      },
    };
  }

  get gatt(): BleGattServer {
    return this;
  }

  // ─── BleGattServer ───────────────────────────────────────────

  async connect(): Promise<BleGattServer> {
    this.connected = true;
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.stopStreaming();
    this.dispatch('gattserverdisconnected', {});
  }

  async getPrimaryService(uuid: string): Promise<BleGattService> {
    if (!this.connected) throw new Error('GATT Server is disconnected.');
    const service = this.services[uuid];
    if (!service) throw new Error(`Simulator: service ${uuid} not found`);
    return {
      async getCharacteristic(characteristicUUID: string): Promise<BleCharacteristic> {
        const characteristic = service[characteristicUUID];
        if (!characteristic) throw new Error(`Simulator: characteristic ${characteristicUUID} not found`);
        return characteristic;
      },
    };
  }

  // ─── BleDevice ───────────────────────────────────────────────

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  // ─── 配信 ────────────────────────────────────────────────────

  private startStreaming(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.frameIndex = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopStreaming(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private nextFrame(timeMs: number): InsoleSimulatorFrame | null {
    if (!this.frames) return generatedFrame(this.slot, this.options.preset ?? 'walk', timeMs);
    if (this.frameIndex >= this.frames.length) {
      if (this.options.loop === false) return null;
      this.frameIndex = 0;
    }
    return this.frames[this.frameIndex++] ?? null;
  }

  private tick(): void {
    if (!this.connected) return;
    const header = this.streamingMode === 1 ? 50 : this.streamingMode === 3 ? 55 : 56;
    const count = insolePacketFrameCount(header);
    const elapsed = Date.now() - this.startedAt;
    const frames: InsolePacketFrame[] = [];
    for (let k = 0; k < count; k++) {
      const frame = this.nextFrame(elapsed + (k * TICK_MS) / count);
      if (!frame) {
        this.disconnect();
        return;
      }
      frames.push(frame);
    }
    this.sensor.emit(encodeInsoleSensorValues({
      header,
      serial: this.serial,
      time: new Date(),
      frames,
      intervalMs: TICK_MS / count,
    }));
    this.serial = (this.serial + 1) % 65536;
  }
}

/**
 * 擬似 INSOLE を返す Web Bluetooth 実装。OrpheCoreInsole の `bluetooth` オプションに渡す。
 * chooser は開かず、常に同じ擬似デバイスを返す。
 */
export function insoleSimulatorBluetooth(slot = 0, options: InsoleSimulatorOptions = {}): BleBluetooth {
  const device = new SimInsoleDevice(slot, options);
  return {
    async requestDevice() {
      return device;
    },
    async getDevices() {
      return [device];
    },
  };
}

/** createInsoleSimulator が返す OrpheCoreInsole の型 */
export type InsoleSimulatorDevice = OrpheCoreInsole<InsoleSensorFields, InsoleCommands, InsoleProfile>;

/** メモリ上だけの記憶デバイス保存先（シミュレータは localStorage を汚さない） */
class SimulatorStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * 擬似 INSOLE につながった OrpheCoreInsole を作る。実機の代わりにそのまま使える。
 *
 * @param slot スロット番号（0 は左足、それ以外は右足として合成データを作る）
 * @param options 合成データ・再生フレーム・デバイス情報の設定
 * @param deviceOptions OrpheCoreInsole へ渡すオプション（events / log / profile のオプションなど）
 */
export function createInsoleSimulator(
  slot = 0,
  options: InsoleSimulatorOptions = {},
  deviceOptions: Omit<OrpheCoreInsoleOptions, 'profile' | 'bluetooth' | 'id'> & { profile?: InsoleProfileOptions } = {},
): InsoleSimulatorDevice {
  const { profile: profileOptions, ...rest } = deviceOptions;
  return new OrpheCoreInsole({
    storage: new SimulatorStorage(),
    ...rest,
    id: slot,
    profile: insoleProfile({ timeSyncSamples: 1, ...profileOptions, pressureCalibration: { fetch: false } }),
    bluetooth: insoleSimulatorBluetooth(slot, options),
  });
}
