/**
 * createInsoleSimulator: 擬似 INSOLE を注入した OrpheCoreInsole。
 * - 実機と同じパース経路で press / quat / euler / ble_frequency が届く
 * - commands.setDataStreamingMode で配信内容が変わる
 * - frames + loop: false は末尾で切断する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInsoleSimulator } from '../../src/simulator/insole-simulator.ts';
import { encodeInsoleSensorValues } from '../../src/simulator/insole-packet.ts';
import { parseInsoleSensorValues } from '../../src/profiles/insole.ts';
import { waitFor } from '../helpers/mock-bluetooth.ts';

test('encodeInsoleSensorValues は parseInsoleSensorValues で元の物理値に戻る', () => {
  const time = new Date(2026, 9, 7, 12, 34, 56, 789);
  for (const header of [50, 55, 56] as const) {
    const count = header === 56 ? 2 : 4;
    const frames = Array.from({ length: count }, (_, k) => ({
      acc: { x: 0.5 + k, y: -1, z: 2 },
      gyro: { x: 70 * (k + 1), y: -140, z: 0 },
      quat: { w: 0.5, x: 0.5, y: -0.5, z: 0.5 },
      press: [100 * (k + 1), 2, 3, 4, 5, 65535],
    }));
    const packet = parseInsoleSensorValues(encodeInsoleSensorValues({ header, serial: 513, time, frames }), {
      now: () => time,
    })!;
    assert.equal(packet.header, header);
    assert.equal(packet.serial_number, 513);
    assert.equal(packet.samples.length, count);
    packet.samples.forEach((sample, k) => {
      assert.ok(Math.abs(sample.converted_acc!.x - (0.5 + k)) < 1e-3, `acc header ${header}`);
      assert.ok(Math.abs(sample.converted_gyro!.x - 70 * (k + 1)) < 0.1, `gyro header ${header}`);
      if (header !== 55) assert.ok(Math.abs(sample.quat!.y + 0.5) < 1e-3);
      if (header !== 50) assert.deepEqual(sample.press!.values, [100 * (k + 1), 2, 3, 4, 5, 65535]);
    });
  }
});

test('createInsoleSimulator: begin / on / commands が実機と同じ経路で動く', async () => {
  const ble = createInsoleSimulator(1, { preset: 'stand' });
  const presses: number[][] = [];
  let quats = 0;
  let frequency = 0;
  ble.on('press', (press) => presses.push(press.values));
  ble.on('quat', () => { quats++; });
  ble.on('ble_frequency', (hz) => { frequency = hz; });

  await ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  assert.equal(ble.isConnected(), true);
  assert.equal(ble.profile.device_information?.mount_position, 1);
  assert.equal(ble.firmware, null);
  await waitFor(() => presses.length >= 4 && quats >= 4 && frequency > 0, 'mode 4 samples');
  assert.ok(presses[0]!.some(value => value > 0), '合成圧力が入っている');

  await ble.commands.setDataStreamingMode(3);
  quats = 0;
  const before = presses.length;
  await waitFor(() => presses.length >= before + 8, 'mode 3 samples');
  assert.equal(quats, 0, 'mode 3 は quat を配信しない');

  ble.stop();
  assert.equal(ble.isConnected(), false);
});

test('createInsoleSimulator: frames + loop: false は最後まで流して切断する', async () => {
  const frames = Array.from({ length: 4 }, (_, i) => ({ press: [i + 1, 0, 0, 0, 0, 0] }));
  let disconnected = false;
  const ble = createInsoleSimulator(0, { frames, loop: false }, { events: { onDisconnect: () => { disconnected = true; } } });
  const firstChannel: number[] = [];
  ble.on('press', (press) => firstChannel.push(press.values[0]!));
  await ble.begin('SENSOR_VALUES', { streamingMode: 3 });
  await waitFor(() => disconnected, 'disconnect at end');
  assert.deepEqual(firstChannel, [1, 2, 3, 4]);
});

test('createInsoleSimulator: タイマーが遅れても経過時間ぶんのパケットを送る（50 パケット/秒）', async () => {
  const ble = createInsoleSimulator(0, { preset: 'walk' });
  let packets = 0;
  ble.onRaw((uuid) => { if (uuid === 'SENSOR_VALUES') packets++; });
  await ble.begin('SENSOR_VALUES', { streamingMode: 4 });
  const started = Date.now();
  // イベントループを 120ms 塞いで、タイマーの遅れを再現する
  while (Date.now() - started < 120) { /* busy */ }
  await new Promise(resolve => setTimeout(resolve, 100));
  const elapsed = Date.now() - started;
  ble.stop();
  assert.ok(packets >= Math.floor(elapsed / 20) - 2, `packets ${packets} for ${elapsed}ms`);
});
