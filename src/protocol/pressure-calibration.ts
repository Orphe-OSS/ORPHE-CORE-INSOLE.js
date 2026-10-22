/**
 * ORPHE INSOLE の個体別圧力校正係数。
 *
 * 対応 FW は製造時に測った 6ch ぶんの校正係数を保持しており、
 * DEVICE_INFORMATION へ要求を書くと SENSOR_VALUES の notify で 1ch ずつ返す。
 * ここはその codec と、係数を使った ADC 生値 → 圧力 [N] の換算だけを持つ。
 * 取得の手続き（write → notify 待ち → 再試行）は profiles/insole.ts が行う。
 */

/** 圧力センサーのチャンネル数 */
export const PRESSURE_SENSOR_COUNT = 6;

/** 校正係数の notify ヘッダ */
export const PRESSURE_CALIBRATION_NOTIFY_HEADER = 0x39;

/** 校正係数の notify ペイロード長 [byte]（ヘッダ + ch + func + double × 5） */
export const PRESSURE_CALIBRATION_PAYLOAD_LENGTH = 1 + 1 + 1 + 8 * 5;

const REQUEST_COMMAND = 0x10;
const REQUEST_ACTION = 0x00;
const COEFFICIENT_COUNT = 5;

/** 1ch ぶんの校正係数 */
export interface PressureCalibration {
  /**
   * 換算式の種類。
   * - `0`: `y = c1·exp(c2·x) + c3`
   * - `1`: `y = c1·x⁴ + c2·x³ + c3·x² + c4·x + c5`
   */
  func: number;
  /** 係数 `[c1, c2, c3, c4, c5]` */
  coefficients: number[];
}

/** 1ch ぶんの校正係数取得要求（DEVICE_INFORMATION へ write する） */
export function encodePressureCalibrationRequest(sensorIndex: number): Uint8Array {
  if (!Number.isInteger(sensorIndex) || sensorIndex < 0 || sensorIndex >= PRESSURE_SENSOR_COUNT) {
    throw new RangeError(`sensorIndex must be 0..${PRESSURE_SENSOR_COUNT - 1}: ${sensorIndex}`);
  }
  return Uint8Array.from([REQUEST_COMMAND, REQUEST_ACTION, sensorIndex]);
}

/** SENSOR_VALUES の notify が校正係数の応答かどうか（先頭バイトで判定） */
export function isPressureCalibrationPacket(data: DataView): boolean {
  return data.byteLength > 0 && data.getUint8(0) === PRESSURE_CALIBRATION_NOTIFY_HEADER;
}

/**
 * 校正係数の notify をデコードする。
 * ヘッダ違いや長さ不足は null。
 */
export function decodePressureCalibration(
  data: DataView
): { sensorIndex: number; calibration: PressureCalibration } | null {
  if (!isPressureCalibrationPacket(data)) return null;
  if (data.byteLength < PRESSURE_CALIBRATION_PAYLOAD_LENGTH) return null;
  const coefficients: number[] = [];
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    coefficients.push(data.getFloat64(3 + 8 * i));
  }
  return {
    sensorIndex: data.getUint8(1),
    calibration: { func: data.getUint8(2), coefficients },
  };
}

/**
 * FW に校正値が書かれていないときに返るプレースホルダかどうか。
 * `func = 0` かつ係数が全部 `1.0` のときは個体別係数として扱わず、既定係数で換算する。
 */
export function isPressureCalibrationPlaceholder(calibration: PressureCalibration): boolean {
  return (
    calibration.func === 0 &&
    calibration.coefficients.length === COEFFICIENT_COUNT &&
    calibration.coefficients.every(c => c === 1)
  );
}

/**
 * 校正係数の式をそのまま評価する（クランプなし）。
 * 係数不足・未知の func は NaN
 */
function evaluatePressureCalibration(calibration: PressureCalibration, adcRaw: number): number {
  const c = calibration.coefficients;
  switch (calibration.func) {
    case 0:
      if (c.length < 3) return NaN;
      return c[0]! * Math.exp(c[1]! * adcRaw) + c[2]!;
    case 1: {
      if (c.length < 5) return NaN;
      const x2 = adcRaw * adcRaw;
      const x3 = x2 * adcRaw;
      const x4 = x3 * adcRaw;
      return c[0]! * x4 + c[1]! * x3 + c[2]! * x2 + c[3]! * adcRaw + c[4]!;
    }
    default:
      return NaN;
  }
}

/**
 * 校正係数で ADC 生値を圧力 [N] に換算する。
 * 負・NaN・無限大・未知の func は 0。
 */
export function applyPressureCalibration(calibration: PressureCalibration, adcRaw: number): number {
  const y = evaluatePressureCalibration(calibration, adcRaw);
  if (!Number.isFinite(y) || y < 0) return 0;
  return y;
}

/**
 * 個体別係数が無いときに使う既定係数（センサー番号 0..5 の順、各行は `[c1..c5]` の 4 次多項式）。
 * insole_client（e342620）の `bin_to_float_pressure_n` と ORPHE-INSOLE.js と同じ値
 */
export const DEFAULT_PRESSURE_COEFFICIENTS: readonly (readonly number[])[] = [
  [6.31278e-11, -2.33093e-7, 3.27825e-4, -1.63373e-1, 2.25012e1],
  [6.65168e-11, -2.10741e-7, 2.31937e-4, -7.10366e-2, 6.97927],
  [1.07646e-10, -3.85112e-7, 5.02384e-4, -2.37328e-1, 3.18015e1],
  [5.91156e-11, -1.81045e-7, 1.86644e-4, -4.46178e-2, 3.10811],
  [5.32573e-11, -1.68515e-7, 1.79518e-4, -4.66859e-2, 3.71484],
  [4.44324e-11, -1.09728e-7, 8.90389e-5, 3.82816e-3, -4.4658],
];

/**
 * 既定係数（ch ごとの 4 次多項式）で ADC 生値を圧力 [N] に換算する。
 * 負・非有限は 0、範囲外のセンサー番号も 0
 */
export function defaultPressureToNewton(adcRaw: number, sensorIndex: number): number {
  const coefficients = DEFAULT_PRESSURE_COEFFICIENTS[sensorIndex];
  if (!coefficients) return 0;
  return applyPressureCalibration({ func: 1, coefficients: [...coefficients] }, adcRaw);
}

// 旧 FW 向けだった固定式。ADC 生値を mV に直してから指数式に通す
const LEGACY_C1 = 2.77942;
const LEGACY_C2 = 2.08348e-3;
const LEGACY_C3 = 4.14411;
/** ノイズフロア [mV]。これ以下は「踏んでいない」として 0 にする */
const LEGACY_THRESHOLD_MV = 240;
const ADC_REFERENCE_VOLT = 3.3;
const ADC_FULL_SCALE = 4096;

/**
 * 旧来の固定式。
 * `mV = adc × 3.3 / 4096 × 1000` に直し、240 mV 以下は 0、
 * それ以上は `c1·exp(c2·mV) + c3`。
 * @deprecated SDK 内では使っていない。既定の換算は {@link defaultPressureToNewton}
 */
export function legacyPressureToNewton(adcRaw: number): number {
  const mV = (adcRaw * ADC_REFERENCE_VOLT / ADC_FULL_SCALE) * 1000;
  if (mV <= LEGACY_THRESHOLD_MV) return 0;
  const y = LEGACY_C1 * Math.exp(LEGACY_C2 * mV) + LEGACY_C3;
  return y < 0 ? 0 : y;
}

/**
 * ADC 生値を圧力 [N] に換算する。
 * 個体別係数があればそれを使う。null・プレースホルダ・換算結果が非有限のときは
 * センサー番号 `sensorIndex` の既定係数（{@link defaultPressureToNewton}）を使う。負値は 0
 */
export function pressureToNewton(
  adcRaw: number,
  calibration: PressureCalibration | null | undefined,
  sensorIndex: number
): number {
  if (calibration && !isPressureCalibrationPlaceholder(calibration)) {
    const y = evaluatePressureCalibration(calibration, adcRaw);
    if (Number.isFinite(y)) return y < 0 ? 0 : y;
  }
  return defaultPressureToNewton(adcRaw, sensorIndex);
}
