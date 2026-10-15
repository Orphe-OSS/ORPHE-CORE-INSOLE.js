/**
 * OrpheCoreInsole.commands / onEvent / lastBeginType / 時刻ヘルパ。
 * - CORE: LED・レンジ・取付位置・姿勢リセット・解析ログリセットを DEVICE_INFORMATION へ書く
 * - INSOLE: ストリーミングモード切替・解析ログリセット
 * - autoProfile: 判別後のプロファイルのコマンドに切り替わる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { coreProfile } from '../../src/profiles/core.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import { autoProfile } from '../../src/profiles/auto.ts';
import { DEVICE_INFORMATION_OPCODE } from '../../src/protocol/commands.ts';
import { TransportError } from '../../src/ble/errors.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';

function coreHarness() {
  const bluetooth = new MockBluetooth();
  const mock = mockCoreDevice();
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({
    profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }),
    bluetooth,
    storage: new MemoryStorage(),
  });
  return { ble, ...mock };
}

function insoleHarness() {
  const bluetooth = new MockBluetooth();
  const mock = mockInsoleDevice();
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({
    profile: insoleProfile({ timeSyncSamples: 1, pressureCalibration: { fetch: false } }),
    bluetooth,
    storage: new MemoryStorage(),
  });
  return { ble, ...mock };
}

const last = (written: Uint8Array[]) => [...written[written.length - 1]!];

test('CORE commands: setLED / resetAttitude / resetAnalysisLogs は対応するオペコードを書く', async () => {
  const { ble, deviceInfo } = coreHarness();
  await ble.begin('SENSOR_VALUES');

  await ble.commands.setLED(true, 2);
  assert.deepEqual(last(deviceInfo.written), [DEVICE_INFORMATION_OPCODE.SET_LED, 1, 2]);
  await ble.commands.setLED(false);
  assert.deepEqual(last(deviceInfo.written), [DEVICE_INFORMATION_OPCODE.SET_LED, 0, 0]);
  await ble.commands.resetAttitude();
  assert.deepEqual(last(deviceInfo.written), [0x03]);
  await ble.commands.resetAnalysisLogs();
  assert.deepEqual(last(deviceInfo.written), [0x04]);
});

test('CORE commands: setRange は物理値を index にして設定を書き、省略した軸は維持する', async () => {
  const { ble, deviceInfo } = coreHarness();
  await ble.begin('SENSOR_VALUES');

  await ble.commands.setRange({ acc: 8 });
  const bytes = last(deviceInfo.written);
  assert.equal(bytes[0], DEVICE_INFORMATION_OPCODE.WRITE_SETTINGS);
  assert.equal(bytes[7], 2); // acc 8G → index 2
  assert.equal(bytes[8], 3); // gyro は維持
  assert.deepEqual(ble.profile.device_information?.range, { acc: 2, gyro: 3 });

  await assert.rejects(() => ble.commands.setRange({ gyro: 123 }), TransportError);
});

test('CORE commands: setLEDBrightness / setMountPosition / readDeviceInformation', async () => {
  const { ble, deviceInfo } = coreHarness();
  await ble.begin('SENSOR_VALUES');

  await ble.commands.setLEDBrightness(30);
  assert.equal(last(deviceInfo.written)[2], 30);
  assert.equal(ble.profile.device_information?.led_brightness, 30);

  await ble.commands.setMountPosition(2);
  assert.equal(last(deviceInfo.written)[1], 2);
  await assert.rejects(() => ble.commands.setMountPosition(5 as 0), TransportError);

  const info = await ble.commands.readDeviceInformation();
  assert.equal(info.battery, 2);
  assert.equal(ble.profile.device_information, info);
});

test('INSOLE commands: setDataStreamingMode / resetAnalysisLogs / readDeviceInformation', async () => {
  const { ble, deviceInfo } = insoleHarness();
  await ble.begin('SENSOR_VALUES', { streamingMode: 4 });

  await ble.commands.setDataStreamingMode(3);
  assert.deepEqual(last(deviceInfo.written), [DEVICE_INFORMATION_OPCODE.SET_STREAMING_MODE, 3]);
  assert.equal(ble.profile.streaming_mode, 3);
  await assert.rejects(() => ble.commands.setDataStreamingMode(2), TransportError);

  await ble.commands.resetAnalysisLogs();
  assert.deepEqual(last(deviceInfo.written), [0x04]);
  const info = await ble.commands.readDeviceInformation();
  assert.equal(info.mount_position, 1);
});

test('autoProfile: commands は判別前は throw し、判別後は種別のコマンドになる', async () => {
  const bluetooth = new MockBluetooth();
  const mock = mockInsoleDevice();
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({
    profile: autoProfile({ insole: { timeSyncSamples: 1, pressureCalibration: { fetch: false } } }),
    bluetooth,
    storage: new MemoryStorage(),
  });
  assert.throws(() => ble.commands);
  await ble.begin();
  assert.equal(ble.profile.kind, 'insole');
  assert.equal(typeof (ble.commands as { setDataStreamingMode?: unknown }).setDataStreamingMode, 'function');
});

test('onEvent: 構築後に複数購読でき、events より先に呼ばれ、解除できる', async () => {
  const calls: string[] = [];
  const bluetooth = new MockBluetooth();
  const mock = mockCoreDevice();
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({
    profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }),
    bluetooth,
    storage: new MemoryStorage(),
    events: { onStartNotify: (uuid) => calls.push(`events:${uuid}`) },
  });
  const off = ble.onEvent('onStartNotify', (uuid) => calls.push(`a:${uuid}`));
  ble.onEvent('onStartNotify', (uuid) => calls.push(`b:${uuid}`));
  await ble.begin('SENSOR_VALUES');
  assert.deepEqual(calls, ['a:SENSOR_VALUES', 'b:SENSOR_VALUES', 'events:SENSOR_VALUES']);

  off();
  calls.length = 0;
  ble.reset();
  mock.device.gatt.connected = false;
  bluetooth.chooserQueue.push(mock.device);
  await ble.begin('SENSOR_VALUES');
  assert.deepEqual(calls, ['b:SENSOR_VALUES', 'events:SENSOR_VALUES']);
});

test('onEvent: 購読者の throw は他の購読者を止めず onError へ報告される', async () => {
  const errors: unknown[] = [];
  const { ble } = coreHarness();
  ble.onEvent('onError', (error) => errors.push(error));
  ble.onEvent('onStartNotify', () => { throw new Error('boom'); });
  let reached = false;
  ble.onEvent('onStartNotify', () => { reached = true; });
  await ble.begin('SENSOR_VALUES');
  assert.equal(reached, true);
  assert.equal((errors[0] as Error).message, 'boom');
});

test('lastBeginType: begin 前は undefined、type 省略時はプロファイルの既定', async () => {
  const { ble } = coreHarness();
  assert.equal(ble.lastBeginType, undefined);
  await ble.begin();
  assert.equal(ble.lastBeginType, 'STEP_ANALYSIS');
  await ble.begin('SENSOR_VALUES');
  assert.equal(ble.lastBeginType, 'SENSOR_VALUES');
});

test('readDateTime / writeDateTime / syncTime は DATE_TIME を使う', async () => {
  const { ble, dateTime } = coreHarness();
  await ble.begin('SENSOR_VALUES');
  const before = dateTime.written.length;
  const read = await ble.readDateTime();
  assert.ok(read.date instanceof Date);
  await ble.writeDateTime(new Date(2026, 0, 1));
  assert.equal(dateTime.written.length, before + 1);
  const result = await ble.syncTime({ samples: 1 });
  assert.equal(typeof result.half_round_trip_time, 'number');
});
