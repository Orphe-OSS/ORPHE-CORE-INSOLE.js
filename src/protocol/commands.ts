/**
 * DEVICE_INFORMATION characteristic へ書き込むコマンドの先頭バイト（オペコード）。
 * CORE / INSOLE の FW で共通。マジックナンバーはここだけで管理する。
 */
export const DEVICE_INFORMATION_OPCODE = Object.freeze({
  /** デバイス設定（取付位置・LED 輝度・レンジなど）の書込 */
  WRITE_SETTINGS: 0x01,
  /** LED の点灯パターン（CORE） */
  SET_LED: 0x02,
  /** 姿勢（クォータニオン計算）のリセット（CORE） */
  RESET_ATTITUDE: 0x03,
  /** 解析ログ（歩数など）のリセット */
  RESET_ANALYSIS_LOGS: 0x04,
  /** データストリーミングモード（1 / 3 / 4）の切替（INSOLE） */
  SET_STREAMING_MODE: 0x0d,
} as const);
