/**
 * ORPHE INSOLE のアドバタイズ（manufacturerData 0x0000）の解釈。
 * 接続しなくてもバッテリー・取付位置・FW 版がわかる。
 */

/** INSOLE のアドバタイズから読み取った状態（`ble.on('status', …)` のペイロード） */
export interface InsoleAdvertisementStatus {
  /** デバイス名 */
  name: string | undefined;
  /** 受信強度 [dBm] */
  rssi: number | undefined;
  /** 送信出力 [dBm] */
  txPower: number | undefined;
  /** ブラウザが割り当てたデバイス id */
  id: string;
  /** バッテリー残量 */
  battery: number;
  /** モデル種別 */
  model_type: number;
  /** 取付位置（bit0: 0=左 / 1=右） */
  mounting_position: number;
  /** 行動認識の結果 */
  human_activity_recognition: number;
  /** FW バージョン（`major.minor.patch`） */
  version: string;
}

/** BluetoothAdvertisingEvent の必要な部分だけ */
export interface BleAdvertisingEvent {
  device?: { id?: string; name?: string };
  rssi?: number;
  txPower?: number;
  manufacturerData?: { get(key: number): DataView | undefined };
}

/** advertisementreceived のイベントを INSOLE の状態に変換する。INSOLE のデータでなければ null */
export function decodeInsoleAdvertisement(event: unknown): InsoleAdvertisementStatus | null {
  const ad = event as BleAdvertisingEvent | null;
  const dv = ad?.manufacturerData?.get(0x0000) ?? null;
  if (!dv || dv.byteLength < 18) return null;
  return {
    name: ad?.device?.name,
    rssi: ad?.rssi,
    txPower: ad?.txPower,
    id: ad?.device?.id ?? '',
    battery: dv.getUint8(14),
    model_type: dv.getUint8(5),
    mounting_position: dv.getUint8(6),
    human_activity_recognition: dv.getUint8(7),
    version: `${dv.getUint8(15)}.${dv.getUint8(16)}.${dv.getUint8(17)}`,
  };
}
