/**
 * OrpheCoreInsole のタブ間共有（BleSharedBridge）を束ねる内部モジュール。
 *
 *   await ble.begin('SENSOR_VALUES', { useSharedBridge: true });
 *
 * - 別タブが同じスロットの BLE 接続を持っていれば、BLE に触らずそのタブから配信を受ける（Secondary）
 * - 持っていなければ自分が接続し、パース済みサンプルを他タブへ配る（Primary）
 * - Primary タブを失った Secondary は、ランダム遅延のあと別タブが Primary になっていれば Secondary に戻り、
 *   いなければ記憶デバイスで自分が接続し直す
 */
import { BleSharedBridge } from '../bridge.ts';
import type { BridgeCallbacks, BridgeEnvironment, BridgeTimingOptions } from '../bridge.ts';
import type { BeginOptions } from './profile.ts';

/** タブ間共有の設定（OrpheCoreInsoleOptions.sharedBridge） */
export interface SharedBridgeOptions {
  /** ブラウザ環境（storage / BroadcastChannel / window イベント）。既定はブラウザのグローバル */
  environment?: BridgeEnvironment;
  /** ハートビートと Primary 検出のタイミング */
  timing?: BridgeTimingOptions;
}

/** タブ間共有での役割 */
export type SharedBridgeRole = 'primary' | 'secondary';

/** SharedBridgeLink が必要とする OrpheCoreInsole の機能 */
export interface SharedBridgeHost {
  readonly id: number;
  readonly emitter: { emit(uuid: string, samples: Array<Record<string, unknown>>): void };
  readonly transport: { addDisconnectHook(hook: (event: unknown) => void): () => void };
  on(field: '*', listener: (sample: Record<string, unknown>) => void): () => void;
  emitLifecycle(name: 'onConnect' | 'onDisconnect', ...args: unknown[]): void;
  begin(type: string | undefined, options: BeginOptions): Promise<unknown>;
  reportError(error: unknown): void;
}

/** structured clone できない値（DataView など）を配信から外す */
function cloneable(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  return true;
}

export class SharedBridgeLink {
  private role: SharedBridgeRole | null = null;
  private bridge: BleSharedBridge | null = null;
  private detachBroadcast: (() => void) | null = null;
  private detachDisconnect: (() => void) | null = null;
  private readonly host: SharedBridgeHost;
  private readonly options: SharedBridgeOptions;

  constructor(host: SharedBridgeHost, options: SharedBridgeOptions = {}) {
    this.host = host;
    this.options = options;
  }

  /** 現在の役割。共有していなければ null */
  get currentRole(): SharedBridgeRole | null {
    return this.role;
  }

  /** ブリッジを作る。ブラウザ環境が無ければ（Node など）null */
  private createBridge(): BleSharedBridge | null {
    if (this.options.environment) {
      return new BleSharedBridge(this.host.id, this.options.environment, this.options.timing);
    }
    const g = globalThis as { window?: unknown; localStorage?: unknown };
    if (typeof g.window === 'undefined' || typeof g.localStorage === 'undefined') return null;
    return new BleSharedBridge(this.host.id, undefined, this.options.timing);
  }

  /** 別タブに Primary がいれば Secondary として購読し true を返す */
  joinIfRemotePrimary(type: string | undefined, options: BeginOptions): boolean {
    const bridge = this.createBridge();
    if (!bridge) return false;
    if (!bridge.isRemotePrimaryAvailable()) {
      bridge.release();
      return false;
    }
    this.joinAsSecondary(bridge, type, options);
    return true;
  }

  private joinAsSecondary(bridge: BleSharedBridge, type: string | undefined, options: BeginOptions): void {
    this.bridge = bridge;
    this.role = 'secondary';
    // フィールド名ごとのハンドラを、受信した名前に応じてその場で作る
    const callbacks = new Proxy({} as BridgeCallbacks, {
      get: (_target, name) => {
        if (name === 'onPrimaryLost') return () => { void this.handlePrimaryLost(type, options); };
        if (typeof name !== 'string') return undefined;
        return (data: unknown) => this.host.emitter.emit('BRIDGE', [{ [name]: data }]);
      },
    });
    bridge.subscribeAsSecondary(callbacks);
    this.host.emitLifecycle('onConnect', 'BRIDGE_SECONDARY');
  }

  /** 自分が BLE 接続を持ったので Primary として配信を始める */
  claimPrimary(): void {
    const bridge = this.createBridge();
    if (!bridge) return;
    this.bridge = bridge;
    this.role = 'primary';
    bridge.claimPrimary();
    this.detachBroadcast = this.host.on('*', (sample) => {
      const batch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(sample)) {
        if (value !== undefined && cloneable(value)) batch[field] = value;
      }
      if (Object.keys(batch).length > 0) bridge.broadcastBatch(batch);
    });
    this.detachDisconnect = this.host.transport.addDisconnectHook(() => {
      if (this.bridge === bridge && bridge.isPrimary) {
        bridge.broadcastDisconnect();
        this.detach();
      }
    });
  }

  /**
   * Primary タブを失ったときの復帰。ランダム遅延の後、他タブが Primary になっていれば
   * Secondary に戻り、いなければ記憶デバイスで自分が接続する。
   */
  private async handlePrimaryLost(type: string | undefined, options: BeginOptions): Promise<void> {
    if (this.role !== 'secondary') return;
    const delayMax = this.bridge?.electionMaxDelayMs ?? 0;
    this.detach();
    this.host.emitLifecycle('onDisconnect', { reason: 'bridge-primary-lost' });

    await new Promise(resolve => setTimeout(resolve, Math.random() * delayMax));

    const probe = this.createBridge();
    if (probe?.isRemotePrimaryAvailable()) {
      this.joinAsSecondary(probe, type, options);
      return;
    }
    probe?.release();
    try {
      await this.host.begin(type, { ...options, useSharedBridge: true });
    } catch (error) {
      this.host.reportError(new Error(`Primary tab closed. Please reconnect manually. (${error instanceof Error ? error.message : String(error)})`));
    }
  }

  private detach(): void {
    this.detachBroadcast?.();
    this.detachBroadcast = null;
    this.detachDisconnect?.();
    this.detachDisconnect = null;
    this.bridge = null;
    this.role = null;
  }

  /** 共有をやめる。Primary なら他タブへ切断を知らせる */
  release(): void {
    const bridge = this.bridge;
    if (bridge) {
      if (bridge.isPrimary) bridge.broadcastDisconnect();
      else bridge.release();
    }
    this.detach();
  }
}
