/**
 * 型レベルの検証（tsc --noEmit で検査。実行はされない）。
 *
 * ble.on('press', ...) のイベントキー補完とペイロード型付けが
 * プロファイルから推論されることを保証する。
 */
import { OrpheCoreInsole } from '../src/device/orphe-core-insole.ts';
import { insoleProfile } from '../src/profiles/insole.ts';

export function _insoleTypingAssertions(): void {
  const ble = new OrpheCoreInsole({ profile: insoleProfile() });

  // イベントキーは InsoleSensorFields のキーに制限され、補完が効く
  ble.on('press', (press, meta) => {
    const values: number[] = press.values;
    const serial: number = press.serial_number;
    const uuid: string = meta.uuid;
    void values;
    void serial;
    void uuid;
  });

  ble.on('acc', (acc) => {
    const x: number = acc.x;
    const t: number = acc.timestamp;
    void x;
    void t;
  });

  ble.on('quat', (quat) => {
    const w: number = quat.w;
    void w;
  });

  ble.on('converted_gyro', (gyro) => {
    const z: number = gyro.z;
    void z;
  });

  ble.on('serial_number', (serial) => {
    const n: number = serial;
    void n;
  });

  // '*' はサンプル全体（各フィールドは optional）
  ble.on('*', (sample) => {
    const maybePress: { values: number[] } | undefined = sample.press;
    void maybePress;
  });

  // @ts-expect-error 存在しないフィールド名はコンパイルエラー（typo 検出）
  ble.on('pres', () => {});

  // @ts-expect-error press のペイロードは number ではない
  ble.on('press', (press: number) => void press);

  // @ts-expect-error acc のペイロードに values は無い
  ble.on('acc', (acc) => void acc.values);
}

/** プロファイル未指定の型（既定）では任意の文字列キーを許す */
export function _untypedProfileAssertions(ble: OrpheCoreInsole): void {
  ble.on('anything_goes', (value) => {
    // 既定では unknown（利用側で絞り込む）
    const v: unknown = value;
    void v;
  });
}

import { coreProfile } from '../src/profiles/core.ts';

export function _commandTypingAssertions(): void {
  const core = new OrpheCoreInsole({ profile: coreProfile() });
  const insole = new OrpheCoreInsole({ profile: insoleProfile() });

  // プロファイルの具体型が保たれる
  const battery: number | undefined = core.profile.device_information?.battery;
  const mode: number | null = insole.profile.streaming_mode;
  void battery;
  void mode;

  // コマンドはプロファイルごとに型付けされる
  void core.commands.setLED(true, 2);
  void insole.commands.setDataStreamingMode(3);
  // @ts-expect-error INSOLE に LED コマンドは無い
  void insole.commands.setLED(true);
  // @ts-expect-error CORE にストリーミングモード切替は無い
  void core.commands.setDataStreamingMode(3);

  // フィールド推論も維持される
  core.on('gait', (gait) => {
    const steps: number = gait.steps;
    void steps;
  });
  // @ts-expect-error CORE に press は無い
  core.on('press', () => {});

  // onEvent はライフサイクルイベント名と引数を型付けする
  core.onEvent('onReconnectAttempt', (info) => {
    const attempt: number = info.attempt;
    void attempt;
  });
}
