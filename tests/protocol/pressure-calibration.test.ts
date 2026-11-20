/**
 * 個体別圧力校正係数（protocol/pressure-calibration.ts）。
 * - 取得要求 / 0x39 応答の codec
 * - func 別の換算式と、既定式（orphe_insole_demo_app と同じ全 ch 共通の指数関数）へのフォールバック
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRESSURE_CALIBRATION,
  DEFAULT_PRESSURE_COEFFICIENTS,
  DEFAULT_PRESSURE_THRESHOLD_RAW,
  PRESSURE_CALIBRATION_PAYLOAD_LENGTH,
  PRESSURE_SENSOR_COUNT,
  applyPressureCalibration,
  defaultPressureToNewton,
  decodePressureCalibration,
  encodePressureCalibrationRequest,
  isPressureCalibrationPacket,
  isPressureCalibrationPlaceholder,
  legacyPressureToNewton,
  pressureToNewton,
} from '../../src/protocol/pressure-calibration.ts';
import type { PressureCalibration } from '../../src/protocol/pressure-calibration.ts';
import { calibrationPayload } from '../helpers/calibration-payload.ts';

test('encodePressureCalibrationRequest: [0x10, 0x00, ch]', () => {
  assert.deepEqual([...encodePressureCalibrationRequest(0)], [0x10, 0x00, 0]);
  assert.deepEqual([...encodePressureCalibrationRequest(5)], [0x10, 0x00, 5]);
  assert.throws(() => encodePressureCalibrationRequest(6), RangeError);
  assert.throws(() => encodePressureCalibrationRequest(-1), RangeError);
});

test('decodePressureCalibration: 43 バイトの 0x39 応答から ch / func / 係数 5 個（double BE）を取り出す', () => {
  const dv = calibrationPayload(3, 1, [1e-10, -2e-7, 3e-4, -0.1, 20]);
  const decoded = decodePressureCalibration(dv);
  assert.ok(decoded);
  assert.equal(decoded.sensorIndex, 3);
  assert.equal(decoded.calibration.func, 1);
  assert.deepEqual(decoded.calibration.coefficients, [1e-10, -2e-7, 3e-4, -0.1, 20]);
});

test('decodePressureCalibration: ヘッダ違い・長さ不足は null', () => {
  const wrongHeader = calibrationPayload(0, 0, [1, 1, 1, 1, 1]);
  wrongHeader.setUint8(0, 0x38);
  assert.equal(decodePressureCalibration(wrongHeader), null);
  assert.equal(decodePressureCalibration(new DataView(new ArrayBuffer(42))), null);
  assert.equal(decodePressureCalibration(new DataView(new ArrayBuffer(0))), null);
});

test('isPressureCalibrationPacket: 先頭バイトだけで判定する（104 バイトのセンサーパケットとは区別）', () => {
  assert.equal(isPressureCalibrationPacket(calibrationPayload(0, 0, [1, 1, 1, 1, 1])), true);
  const sensor = new DataView(new ArrayBuffer(104));
  sensor.setUint8(0, 56);
  assert.equal(isPressureCalibrationPacket(sensor), false);
  assert.equal(isPressureCalibrationPacket(new DataView(new ArrayBuffer(0))), false);
});

test('applyPressureCalibration: func 0 は指数式、func 1 は 4 次多項式', () => {
  const expo: PressureCalibration = { func: 0, coefficients: [2, 0.001, 3, 0, 0] };
  assert.ok(Math.abs(applyPressureCalibration(expo, 1000) - (2 * Math.exp(1) + 3)) < 1e-9);

  const poly: PressureCalibration = { func: 1, coefficients: [1, 2, 3, 4, 5] };
  // 1·2⁴ + 2·2³ + 3·2² + 4·2 + 5 = 16 + 16 + 12 + 8 + 5
  assert.equal(applyPressureCalibration(poly, 2), 57);
});

test('applyPressureCalibration: 負・NaN・無限大・未知 func は 0', () => {
  assert.equal(applyPressureCalibration({ func: 1, coefficients: [0, 0, 0, 0, -5] }, 100), 0);
  assert.equal(applyPressureCalibration({ func: 0, coefficients: [1, 1, 0, 0, 0] }, 10000), 0); // exp(10000) = Infinity
  assert.equal(applyPressureCalibration({ func: 0, coefficients: [Number.NaN, 0, 0, 0, 0] }, 1), 0);
  assert.equal(applyPressureCalibration({ func: 2, coefficients: [1, 1, 1, 1, 1] }, 1), 0);
  assert.equal(applyPressureCalibration({ func: 0, coefficients: [1, 1] }, 1), 0); // 係数不足
});

test('isPressureCalibrationPlaceholder: func 0 かつ係数が全部 1.0 のときだけ true', () => {
  assert.equal(isPressureCalibrationPlaceholder({ func: 0, coefficients: [1, 1, 1, 1, 1] }), true);
  assert.equal(isPressureCalibrationPlaceholder({ func: 1, coefficients: [1, 1, 1, 1, 1] }), false);
  assert.equal(isPressureCalibrationPlaceholder({ func: 0, coefficients: [1, 1, 1, 1, 2] }), false);
  assert.equal(isPressureCalibrationPlaceholder({ func: 0, coefficients: [1, 1, 1] }), false);
});

test('legacyPressureToNewton: ADC → mV を挟んだ指数式で、240 mV 以下は 0', () => {
  // 240 mV に相当する ADC 値は 240 / 1000 * 4096 / 3.3 ≈ 297.9
  assert.equal(legacyPressureToNewton(0), 0);
  assert.equal(legacyPressureToNewton(297), 0);
  const mV = 1000 * 3.3 / 4096 * 1000;
  const expected = 2.77942 * Math.exp(2.08348e-3 * mV) + 4.14411;
  assert.ok(Math.abs(legacyPressureToNewton(1000) - expected) < 1e-9);
});

test('defaultPressureToNewton: orphe_insole_demo_app と同じ全 ch 共通の指数関数（生値のまま、240 以下は 0）', () => {
  assert.equal(DEFAULT_PRESSURE_CALIBRATION.func, 0);
  assert.deepEqual([...DEFAULT_PRESSURE_CALIBRATION.coefficients], [2.77942, 0.00235, 4.14411, 0, 0]);
  assert.equal(DEFAULT_PRESSURE_THRESHOLD_RAW, 240);
  // demo app: y = 2.77942·exp(0.00235·x) + 4.14411（x は ADC 生値）
  const demo = (x: number): number => 2.77942 * Math.exp(0.00235 * x) + 4.14411;
  for (let ch = 0; ch < PRESSURE_SENSOR_COUNT; ch++) {
    assert.ok(Math.abs(defaultPressureToNewton(1000, ch) - demo(1000)) < 1e-9, `ch${ch}`);
  }
  assert.ok(Math.abs(defaultPressureToNewton(1000, 0) - 33.287912) < 1e-5);
  // 閾値の境界: 240 は 0、241 から指数関数
  assert.equal(defaultPressureToNewton(240, 0), 0);
  assert.ok(Math.abs(defaultPressureToNewton(241, 0) - demo(241)) < 1e-9);
  assert.equal(defaultPressureToNewton(0, 0), 0);
  assert.equal(defaultPressureToNewton(-5, 0), 0);
  assert.equal(defaultPressureToNewton(Number.NaN, 0), 0);
  // 範囲外のセンサー番号は 0
  assert.equal(defaultPressureToNewton(1000, 6), 0);
  assert.equal(defaultPressureToNewton(1000, -1), 0);
  // 旧既定の多項式係数は互換のため残す
  assert.equal(DEFAULT_PRESSURE_COEFFICIENTS.length, PRESSURE_SENSOR_COUNT);
});

test('pressureToNewton: 係数があればそれを、null / プレースホルダ / 非有限なら既定式を使う', () => {
  const poly: PressureCalibration = { func: 1, coefficients: [0, 0, 0, 1, 0] }; // y = x
  assert.equal(pressureToNewton(500, poly, 0), 500);
  assert.equal(pressureToNewton(500, null, 2), defaultPressureToNewton(500, 2));
  assert.equal(pressureToNewton(500, undefined, 3), defaultPressureToNewton(500, 3));
  assert.equal(pressureToNewton(500, { func: 0, coefficients: [1, 1, 1, 1, 1] }, 1), defaultPressureToNewton(500, 1));
  // exp(100·1000) = Infinity・未知 func・係数不足は既定式へ
  assert.equal(pressureToNewton(1000, { func: 0, coefficients: [1, 100, 0, 0, 0] }, 4), defaultPressureToNewton(1000, 4));
  assert.equal(pressureToNewton(1000, { func: 2, coefficients: [1, 1, 1, 1, 1] }, 4), defaultPressureToNewton(1000, 4));
  assert.equal(pressureToNewton(1000, { func: 1, coefficients: [1, 1] }, 4), defaultPressureToNewton(1000, 4));
  // 有限な負値は個体別係数の結果として 0 にクランプする
  assert.equal(pressureToNewton(1000, { func: 1, coefficients: [0, 0, 0, 0, -1] }, 0), 0);
});

test('定数: センサー数 6、応答長 43', () => {
  assert.equal(PRESSURE_SENSOR_COUNT, 6);
  assert.equal(PRESSURE_CALIBRATION_PAYLOAD_LENGTH, 43);
});
