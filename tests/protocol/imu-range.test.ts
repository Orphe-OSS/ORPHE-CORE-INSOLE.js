/**
 * 加速度・角速度のレンジ対応表と換算。
 * CORE / INSOLE のリアルタイム計測と FIFO が同じ表・同じ換算を使うことを確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACC_RANGES,
  GYRO_RANGES,
  gyroRawToDps,
  imuRangeFromSettings,
} from '../../src/protocol/imu-range.ts';
import { CORE_ACC_RANGES, CORE_GYRO_RANGES, CoreProfile } from '../../src/profiles/core.ts';
import type { CoreDeviceInformation } from '../../src/profiles/core.ts';
import { INSOLE_ACC_RANGES, INSOLE_GYRO_RANGES, InsoleProfile } from '../../src/profiles/insole.ts';
import type { InsoleDeviceInformation } from '../../src/profiles/insole.ts';
import { fifoRangeFromDeviceInformation, gyroToDps } from '../../src/fifo/protocol.ts';

test('imuRangeFromSettings: index を物理値にする。未取得・範囲外・非整数は ±16G / ±2000dps', () => {
  assert.deepEqual(imuRangeFromSettings({ acc: 0, gyro: 3 }), { acc: 2, gyro: 2000 });
  assert.deepEqual(imuRangeFromSettings({ acc: 2, gyro: 1 }), { acc: 8, gyro: 500 });
  assert.deepEqual(imuRangeFromSettings(null), { acc: 16, gyro: 2000 });
  assert.deepEqual(imuRangeFromSettings({ acc: 4, gyro: -1 }), { acc: 16, gyro: 2000 });
  assert.deepEqual(imuRangeFromSettings({ acc: 1.5, gyro: '1' }), { acc: 16, gyro: 2000 });
});

test('gyroRawToDps: ±2000dps で 70 mdps/LSB、感度はレンジに比例する', () => {
  assert.equal(gyroRawToDps(1000, 2000), 70);
  assert.equal(gyroRawToDps(1000, 250), 8.75);
  assert.equal(gyroRawToDps(-1000, 500), -17.5);
});

test('CORE / INSOLE の公開レンジ表は共通の表と同じ', () => {
  assert.equal(CORE_ACC_RANGES, ACC_RANGES);
  assert.equal(CORE_GYRO_RANGES, GYRO_RANGES);
  assert.equal(INSOLE_ACC_RANGES, ACC_RANGES);
  assert.equal(INSOLE_GYRO_RANGES, GYRO_RANGES);
});

test('リアルタイム計測と FIFO で同じ device information から同じレンジになる', () => {
  const settings = [
    { acc: 0, gyro: 0 },
    { acc: 3, gyro: 2 },
    { acc: 7, gyro: 9 }, // 範囲外
  ];
  for (const range of settings) {
    const fifo = fifoRangeFromDeviceInformation({ range });
    const expected = { accRange: fifo.acc, gyroRange: fifo.gyro };

    const core = new CoreProfile();
    core.device_information = { range } as CoreDeviceInformation;
    assert.deepEqual(core.sensorParseOptions(), expected, `CORE ${JSON.stringify(range)}`);

    const insole = new InsoleProfile();
    insole.device_information = { range } as InsoleDeviceInformation;
    assert.deepEqual(insole.sensorParseOptions(), expected, `INSOLE ${JSON.stringify(range)}`);
  }
});

test('FIFO のジャイロ換算はリアルタイム計測と同じ感度を使う', () => {
  for (const range of GYRO_RANGES) {
    // 0x03E8 = 1000
    assert.equal(gyroToDps(0x03, 0xe8, range), gyroRawToDps(1000, range));
  }
});
