/**
 * OrpheCoreInsole — コンポジット・ファサード。
 *
 *   OrpheCoreInsole = OrpheBleTransport（通信） + DeviceProfile（core/insole 差分）
 *              + SampleEmitter（コールバック配送）
 *
 * デバイスSDK（Orphe / OrpheInsole）はこのファサードを内包するか、
 * 直接これを公開 API として使う。
 *
 *   const ble = new OrpheCoreInsole();   // profile 省略時は autoProfile()（デバイス名で CORE / INSOLE を判別）
 *   const ble = new OrpheCoreInsole({ profile: coreProfile(), id: 0 });
 *   ble.on('acc', (acc) => { ... });
 *   ble.onEvent('onConnect', () => { ... });
 *   await ble.begin('SENSOR_VALUES', { autoReconnect: true });
 *   await ble.commands.setLED(true, 2);   // CORE のコマンド
 */
import type { BleBluetooth, StorageLike } from '../ble/web-bluetooth.ts';
import type { DeviceGuard, ReconnectConfig, TransportEvents } from '../ble/types.ts';
import type { BeginOptions, DeviceMode, DeviceProfile, SensorFieldMap } from './profile.ts';
import { OrpheBleTransport } from '../ble/transport.ts';
import { decodeFirmwareInfo } from '../protocol/fw-info.ts';
import type { FirmwareInfo } from '../protocol/fw-info.ts';
import { SampleEmitter } from './sample-emitter.ts';
import { readDateTime, syncDeviceTime, writeDateTime } from './time-sync.ts';
import type { DeviceDateTime, SyncTimeOptions, SyncTimeResult } from './time-sync.ts';
import { autoProfile } from '../profiles/auto.ts';
import { SharedBridgeLink } from './shared-bridge.ts';
import type { SharedBridgeHost, SharedBridgeOptions, SharedBridgeRole } from './shared-bridge.ts';
import type { SampleListener } from './sample-emitter.ts';

/** FW 情報を read する characteristic の論理名 */
const FIRMWARE_NAME_UUID = 'GET_FW_NAME';

/** OrpheCoreInsole のコンストラクタオプション */
export interface OrpheCoreInsoleOptions<
  TFields extends object = SensorFieldMap,
  TCommands = unknown,
  TProfile extends DeviceProfile<TFields, TCommands> = DeviceProfile<TFields, TCommands>,
> {
  /** デバイス種別の実装（coreProfile() / insoleProfile() / autoProfile()）。省略時は autoProfile() */
  profile?: TProfile & DeviceProfile<TFields, TCommands>;
  /** スロット番号（0 or 1）。記憶キーの分離に使う。既定 0 */
  id?: number;
  /** transport イベントの購読（onNotification は parse 前の生 DataView が透過で届く） */
  events?: TransportEvents;
  /** 再接続の既定設定（begin の options.reconnect が優先） */
  reconnect?: ReconnectConfig;
  /** gatt.connect() のハング対策タイムアウト（opt-in） */
  connectTimeoutMs?: number;
  /** デバイス重複割当ガード */
  deviceGuard?: DeviceGuard;
  /** 注入点（テスト・非ブラウザ環境用）: Web Bluetooth 実装。既定 navigator.bluetooth */
  bluetooth?: BleBluetooth;
  /** 注入点: デバイス記憶の保存先。既定 localStorage */
  storage?: StorageLike;
  /** 内部動作のデバッグログ出力先（requestDevice / GATT 解決 / notify 開始など） */
  log?: (message: string, detail?: unknown) => void;
  /** 注入点: 待機の実装。既定 setTimeout */
  wait?: (ms: number) => Promise<void>;
  /** テスト用注入点: BLE 実測周波数計測の単調クロック [ms]。既定 performance.now */
  clock?: () => number;
  /** タブ間共有（begin の useSharedBridge）の環境とタイミング。通常は省略する */
  sharedBridge?: SharedBridgeOptions;
}

/** {@link OrpheCoreInsole.onEvent} で購読できるライフサイクルイベント名 */
export type LifecycleEventName = Exclude<keyof TransportEvents, 'onNotification'>;

export class OrpheCoreInsole<
  TFields extends object = SensorFieldMap,
  TCommands = unknown,
  TProfile extends DeviceProfile<TFields, TCommands> = DeviceProfile<TFields, TCommands>,
> {
  /** スロット番号（記憶デバイスの分離キー） */
  readonly id: number;
  /**
   * デバイス種別の実装（接続シーケンス・パースを担う）。
   * coreProfile() / insoleProfile() を渡した場合はその型のまま参照できる（`ble.profile.device_information` など）
   */
  readonly profile: TProfile;
  /** BLE トランスポート（scan / read / write / notify / 再接続） */
  readonly transport: OrpheBleTransport;
  /** フィールド名 → リスナーへサンプルを配送する emitter */
  readonly emitter: SampleEmitter<TFields>;

  private readonly userEvents: TransportEvents;
  private readonly eventListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  private commandsCache: { kind: string; commands: TCommands } | null = null;
  private readonly rawListeners = new Set<(uuid: string, value: DataView) => void>();
  private readonly notifySinks = new Map<string, (value: DataView) => void>();
  private readonly clock: () => number;
  private frequencyStart = 0;
  /** 前回 begin() の type。省略時は undefined のまま持ち、再接続のたびにプロファイルの既定を使う */
  private beginType: string | undefined;
  private lastBeginOptions: BeginOptions = {};
  private hasBegun = false;
  private firmwareInfo: FirmwareInfo | null = null;
  private readonly sharedBridgeOptions: SharedBridgeOptions;
  private bridgeLink: SharedBridgeLink | null = null;
  private advertisementListener: ((event: unknown) => void) | null = null;
  private advertisementDevice: { removeEventListener(type: string, listener: (event: unknown) => void): void } | null = null;
  private latestAdvertisement: Partial<TFields> | null = null;
  private readonly debugLog: (message: string, detail?: unknown) => void;

  constructor(options: OrpheCoreInsoleOptions<TFields, TCommands, TProfile> = {}) {
    this.profile = options.profile ?? (autoProfile() as unknown as TProfile);
    this.id = options.id ?? 0;
    this.userEvents = options.events ?? {};
    this.clock = options.clock ?? (() => performance.now());
    this.debugLog = options.log ?? (() => {});
    this.sharedBridgeOptions = options.sharedBridge ?? {};
    this.emitter = new SampleEmitter<TFields>((error) => this.userEvents.onError?.(error));

    // ユーザイベントは呼び出し時点で参照する（後から差し替え可能な遅延バインド）。
    // onEvent() の購読者を先に、コンストラクタの events を後に呼ぶ
    const delegate = <K extends LifecycleEventName>(name: K) =>
      (...args: unknown[]) => {
        this.fireListeners(name, args);
        const callback = this.userEvents[name] as ((...a: unknown[]) => void) | undefined;
        callback?.(...args);
      };

    this.transport = new OrpheBleTransport({
      requestDeviceOptions: () => this.profile.requestDeviceOptions(),
      storageKey: this.profile.storageKey(this.id),
      characteristics: this.profile.characteristics(),
      reconnect: options.reconnect,
      reconnectConnect: () => this.runBegin(this.beginType, this.lastBeginOptions),
      connectTimeoutMs: options.connectTimeoutMs,
      deviceGuard: options.deviceGuard,
      bluetooth: options.bluetooth,
      storage: options.storage,
      log: options.log,
      wait: options.wait,
      events: {
        onScan: delegate('onScan'),
        onConnect: delegate('onConnect'),
        onDisconnect: delegate('onDisconnect'),
        onError: (error) => this.reportError(error),
        onWrite: delegate('onWrite'),
        onStartNotify: delegate('onStartNotify'),
        onStopNotify: delegate('onStopNotify'),
        onReconnectAttempt: delegate('onReconnectAttempt'),
        onReconnectSuccess: delegate('onReconnectSuccess'),
        onReconnectFailed: delegate('onReconnectFailed'),
        onNotification: (uuid, value) => {
          // sink（FIFO / Gait 等のプロトコルモジュール）が横取り中は、
          // その uuid の通知を sink のみに渡し、周波数計測・onRaw・parse・
          // events.onNotification をすべてスキップする
          const sink = this.notifySinks.get(uuid);
          if (sink) {
            try {
              sink(value);
            } catch (error) {
              this.reportError(error);
            }
            return;
          }
          // BLE 実測周波数。15ms 以下の間隔は間引き（-1）。
          // 同じ notify のデータより先に配送する。
          const frequency = this.measureFrequencyHz();
          if (frequency > 0) {
            this.emitter.emit(uuid, [{ ble_frequency: frequency } as unknown as Partial<TFields>]);
          }
          // 生データ購読はパース前に呼ぶ
          for (const listener of [...this.rawListeners]) {
            try {
              listener(uuid, value);
            } catch (error) {
              this.reportError(error);
            }
          }
          const samples = this.profile.parse(uuid, value);
          if (samples && samples.length > 0) this.emitter.emit(uuid, samples);
          this.userEvents.onNotification?.(uuid, value);
        },
      },
    });
  }

  // ─── センサーデータ購読 ────────────────────────────────────────

  /**
   * 正規化フィールド名（'acc' / 'gyro' / 'quat' / 'press' ...）で購読する。
   * キーとペイロード型はプロファイルの TFields から推論される（補完が効く）。
   * '*' はサンプル全体。解除関数を返す。
   */
  on<K extends Extract<keyof TFields, string> | '*'>(
    field: K,
    listener: SampleListener<TFields, K>
  ): () => void {
    return this.emitter.on(field, listener);
  }

  /**
   * パース前の生 DataView を購読する（uuid は論理名）。解除関数を返す。
   * attachLegacyCallbacks の gotData 配送などが使う。
   */
  onRaw(listener: (uuid: string, value: DataView) => void): () => void {
    this.rawListeners.add(listener);
    return () => {
      this.rawListeners.delete(listener);
    };
  }

  /**
   * uuid（論理名）の notify を横取りする sink を設定する。FIFO 収録や歩容解析の
   * ように、request/response プロトコルの応答を通常のセンサー配送から切り離して
   * 消費するモジュール用。設定中はその uuid の通知が sink のみに渡る。
   * 解除関数を返す。同じ uuid への多重設定はエラー（横取りの奪い合い事故防止）。
   */
  setNotifySink(uuid: string, sink: (value: DataView) => void): () => void {
    if (this.notifySinks.has(uuid)) {
      throw new Error(`OrpheCoreInsole.setNotifySink: sink already installed for ${uuid}`);
    }
    this.notifySinks.set(uuid, sink);
    return () => {
      if (this.notifySinks.get(uuid) === sink) this.notifySinks.delete(uuid);
    };
  }

  // ─── ライフサイクルイベント購読 ────────────────────────────────

  /**
   * ライフサイクルイベント（'onConnect' / 'onDisconnect' / 'onStartNotify' / 'onError' /
   * 'onReconnectSuccess' など）を購読する。解除関数を返す。
   * コンストラクタの `events` と違い、構築後に何個でも足せる（toolkit が作ったインスタンスにも使える）。
   * 購読者はコンストラクタの `events` より先に呼ばれる。
   */
  onEvent<K extends LifecycleEventName>(name: K, listener: NonNullable<TransportEvents[K]>): () => void {
    let listeners = this.eventListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(name, listeners);
    }
    const callback = listener as (...args: unknown[]) => unknown;
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  /**
   * onEvent() の購読者へライフサイクルイベントを配送する。
   * 購読者の throw は他の購読者を止めず onError へ報告する（onError の購読者の throw は握りつぶす）。
   * transport を通らないイベント（タブ間共有の Secondary 接続など）の発火にも使う。
   *
   * @internal
   */
  fireListeners(name: LifecycleEventName, args: unknown[]): void {
    const listeners = this.eventListeners.get(name);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try {
        const result = listener(...args);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((error) => {
            if (name !== 'onError') this.reportError(error);
          });
        }
      } catch (error) {
        if (name !== 'onError') this.reportError(error);
      }
    }
  }

  /**
   * ライフサイクルイベントを onEvent() の購読者とコンストラクタの `events` の両方へ発火する。
   *
   * @internal
   */
  emitLifecycle(name: LifecycleEventName, ...args: unknown[]): void {
    this.fireListeners(name, args);
    const callback = this.userEvents[name] as ((...a: unknown[]) => unknown) | undefined;
    try {
      callback?.(...args);
    } catch (error) {
      if (name !== 'onError') this.reportError(error);
    }
  }

  /** コールバック例外などを onError へ安全に報告する（throw は伝播しない） */
  reportError(error: unknown): void {
    this.fireListeners('onError', [error]);
    try {
      this.userEvents.onError?.(error);
    } catch { /* noop */ }
  }

  // ─── デバイスコマンド・時刻 ──────────────────────────────────

  /**
   * デバイス固有コマンド。CORE は LED・レンジ・姿勢リセットなど（{@link CoreCommands}）、
   * INSOLE はストリーミングモード切替など（{@link InsoleCommands}）。
   * autoProfile では接続して種別が決まるまで使えない（throw する）。
   */
  get commands(): TCommands {
    if (!this.profile.commands) {
      throw new Error(`OrpheCoreInsole.commands: profile "${this.profile.kind}" does not provide commands`);
    }
    const kind = this.profile.kind;
    if (!this.commandsCache || this.commandsCache.kind !== kind) {
      this.commandsCache = { kind, commands: this.profile.commands(this.transport) };
    }
    return this.commandsCache.commands;
  }

  /** デバイスの時刻を読む（往復時間つき） */
  readDateTime(): Promise<DeviceDateTime> {
    return readDateTime(this.transport);
  }

  /** Date をデバイスの時刻として書き込む */
  writeDateTime(date: Date): Promise<void> {
    return writeDateTime(this.transport, date);
  }

  /**
   * デバイスの時計を PC 時刻 + 平均往復時間/2 に合わせる。
   * begin() の中でも自動で行われるので、通常は呼ばなくてよい。
   */
  syncTime(options?: SyncTimeOptions): Promise<SyncTimeResult> {
    return syncDeviceTime(this.transport, options);
  }

  /** 前回 notify からの経過時間 → 周波数 [Hz]。15ms 以下は -1（間引き） */
  private measureFrequencyHz(): number {
    const now = this.clock();
    const diff = now - this.frequencyStart;
    this.frequencyStart = now;
    if (diff <= 15) return -1;
    return 1000 / diff;
  }

  // ─── ファームウェアと取得モード ────────────────────────────────

  /**
   * 接続中デバイスのファームウェア情報。begin() の中で 1 回だけ read してキャッシュする。
   * 未接続、または FW 情報を持たない個体では null。
   */
  get firmware(): FirmwareInfo | null {
    return this.firmwareInfo;
  }

  /**
   * 接続中の FW で実際に使える取得モードだけを返す。
   * FW 情報が取れない個体（旧 FW など）は判定できないため絞り込まない。
   */
  get availableModes(): DeviceMode[] {
    const modes = this.profile.modes ? this.profile.modes() : [];
    const releaseDate = this.firmwareInfo?.releaseDate ?? null;
    if (releaseDate === null) return modes;
    return modes.filter(mode => releaseDate >= mode.minReleaseDate);
  }

  /**
   * GET_FW_NAME を read してファームウェア情報を取り直す。
   * autoProfile のようにデバイス名で振る舞いを決めるプロファイルは、ここで CORE / INSOLE を判別する。
   * characteristic 未実装・read 失敗・日付未書込はすべて null（例外は投げない）。
   * デバイスの選択（chooser のキャンセル、別スロットへの割当済み）だけは失敗として reject する。
   */
  async readFirmwareInfo(): Promise<FirmwareInfo | null> {
    const hasFirmwareName = this.transport.hasCharacteristic(FIRMWARE_NAME_UUID);
    if (!hasFirmwareName && !this.profile.resolveDevice) {
      this.firmwareInfo = null;
      return null;
    }
    // デバイス選択と GATT 接続をここで済ませる場合があるため、その間は connecting を出す
    this.transport.setConnecting(true);
    try {
      await this.transport.scan(hasFirmwareName ? FIRMWARE_NAME_UUID : 'DEVICE_INFORMATION');
      // デバイス名で振る舞いを決めるプロファイル（autoProfile）は、選んだ時点で判別する。
      // FW の read より先に済ませ、read に失敗しても availableModes が出せるようにする
      this.profile.resolveDevice?.(this.transport.device?.name ?? null, this.debugLog);
      if (!hasFirmwareName) {
        this.firmwareInfo = null;
        return null;
      }
      try {
        this.firmwareInfo = decodeFirmwareInfo(await this.transport.read(FIRMWARE_NAME_UUID, { silent: true }));
      } catch {
        // 未実装の FW ではここに来る。判定不能として扱い、モードは絞り込まない
        this.firmwareInfo = null;
      }
    } finally {
      this.transport.setConnecting(false);
    }
    return this.firmwareInfo;
  }

  // ─── 接続ライフサイクル ────────────────────────────────────────

  /**
   * 接続してデータ取得を開始する。
   * シーケンスの中身はプロファイルが定義し、成功時にデバイスを記憶、
   * autoReconnect 指定時は以後の切断で同じシーケンスが自動再実行される。
   */
  async begin(type?: string, options: BeginOptions = {}): Promise<unknown> {
    // chooser の強制は最初のデバイス選択にだけ効かせる。プロファイルの各 GATT 操作や
    // 自動再接続へは渡さない（渡すと操作のたびに chooser が開く）
    const { forceDeviceSelection, useSharedBridge, ...profileOptions } = options;
    this.beginType = type;
    this.lastBeginOptions = profileOptions;
    this.hasBegun = true;

    this.releaseSharedBridge();
    if (useSharedBridge === true) {
      const link = new SharedBridgeLink(this as unknown as SharedBridgeHost, this.sharedBridgeOptions);
      if (link.joinIfRemotePrimary(type, profileOptions)) {
        this.bridgeLink = link;
        return 'done begin(); BRIDGE SECONDARY';
      }
    }

    if (options.autoReconnect) {
      this.transport.enableAutoReconnect(options.reconnect ?? {});
    } else if (this.transport.connectionState !== 'reconnecting') {
      this.transport.disableAutoReconnect();
    }

    if (forceDeviceSelection) {
      this.transport.setConnecting(true);
      try {
        await this.transport.scan('DEVICE_INFORMATION', { forceDeviceSelection: true });
      } finally {
        this.transport.setConnecting(false);
      }
    }
    const result = await this.runBegin(type, profileOptions);
    if (useSharedBridge === true) {
      const link = new SharedBridgeLink(this as unknown as SharedBridgeHost, this.sharedBridgeOptions);
      link.claimPrimary();
      this.bridgeLink = link;
    }
    return result;
  }

  /**
   * タブ間共有（begin の useSharedBridge: true）での役割。
   * 'primary' は自分が BLE 接続を持って配信中、'secondary' は別タブの接続から受信中。共有していなければ null
   */
  get sharedBridgeRole(): SharedBridgeRole | null {
    return this.bridgeLink?.currentRole ?? null;
  }

  /** タブ間共有だけをやめる（BLE 接続はそのまま）。Primary なら他タブへ切断を知らせる */
  releaseSharedBridge(): void {
    this.bridgeLink?.release();
    this.bridgeLink = null;
  }

  /** begin シーケンス本体（手動 begin と自動再接続の共通経路） */
  private async runBegin(type: string | undefined, options: BeginOptions): Promise<unknown> {
    this.transport.setConnecting(true);
    try {
      // プロファイルの接続シーケンスが FW で分岐できるよう、先に FW を読む。
      // デバイス名で振る舞いを決めるプロファイルの判別もここで済む
      await this.readFirmwareInfo();
      const notificationType = type ?? this.profile.defaultNotificationType;
      const result = await this.profile.begin({
        transport: this.transport,
        notificationType,
        options,
        firmware: this.firmwareInfo,
        log: this.debugLog,
      });
      this.transport.rememberCurrentDevice();
      this.transport.armAutoReconnect();
      return result;
    } finally {
      this.transport.setConnecting(false);
    }
  }

  /**
   * 直近の begin() で開始した notification type（type を省略した場合はプロファイルの既定）。
   * begin() 前は undefined。
   */
  get lastBeginType(): string | undefined {
    if (!this.hasBegun) return undefined;
    return this.beginType ?? this.profile.defaultNotificationType;
  }

  /** 切断してクリアする。自動再接続も解除される */
  stop(): void {
    this.reset();
  }

  /** stop() と同じ。切断・記憶クリア・自動再接続解除。タブ間共有も解除する */
  reset(): void {
    const wasSecondary = this.bridgeLink?.currentRole === 'secondary';
    this.releaseSharedBridge();
    this.stopWatchingAdvertisements();
    if (wasSecondary) {
      this.transport.disableAutoReconnect();
      return;
    }
    this.transport.reset();
  }

  // ─── アドバタイズ監視 ────────────────────────────────────────

  /**
   * 選択中のデバイスのアドバタイズを監視する（接続していなくても受信できる）。
   * 受信は events.onAdvertisement / onEvent('onAdvertisement') と、プロファイルが解釈した
   * フィールド（INSOLE は `status`: バッテリー・取付位置・FW 版）の on() 配送で届く。
   * ブラウザやデバイスが対応していなければ false を返す。
   */
  async watchAdvertisements(): Promise<boolean> {
    const device = this.transport.device;
    if (!device || typeof device.watchAdvertisements !== 'function') {
      this.debugLog('watchAdvertisements はこの環境では使えません');
      return false;
    }
    if (!this.advertisementListener) {
      this.advertisementListener = (event) => this.receiveAdvertisement(event);
      device.addEventListener('advertisementreceived', this.advertisementListener);
      this.advertisementDevice = device;
    }
    try {
      await device.watchAdvertisements();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  /** アドバタイズの監視をやめる */
  stopWatchingAdvertisements(): void {
    if (this.advertisementDevice && this.advertisementListener) {
      this.advertisementDevice.removeEventListener('advertisementreceived', this.advertisementListener);
    }
    this.advertisementListener = null;
    this.advertisementDevice = null;
  }

  /** 最後に受信したアドバタイズをプロファイルが解釈した結果（INSOLE は `{ status }`）。未受信なら null */
  get lastAdvertisement(): Partial<TFields> | null {
    return this.latestAdvertisement;
  }

  private receiveAdvertisement(event: unknown): void {
    this.emitLifecycle('onAdvertisement', event);
    const sample = this.profile.parseAdvertisement?.(event) ?? null;
    if (!sample) return;
    this.latestAdvertisement = sample;
    this.emitter.emit('ADVERTISEMENT', [sample]);
  }

  /** GATT 接続中なら true */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /** 現在の接続状態（'disconnected' / 'connecting' / 'connected'） */
  get connectionState() {
    return this.transport.connectionState;
  }
}
