/**
 * OrpheCoreInsole のタブ間共有（begin の useSharedBridge）。
 * - 別タブに Primary がいれば BLE に触らず Secondary として on() に配送される
 * - Primary は CORE / INSOLE のどちらのフィールドも配信する
 * - Primary の切断で Secondary は onDisconnect を受け、自分で接続しにいく
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { coreProfile } from '../../src/profiles/core.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import { MockTabWorld } from '../helpers/bridge-env.ts';
import { MemoryStorage, MockBluetooth, waitFor } from '../helpers/mock-bluetooth.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';

const TIMING = { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000, watchIntervalMs: 10, electionMaxDelayMs: 0 };

function makeCore(world: MockTabWorld) {
  const bluetooth = new MockBluetooth();
  const errors: unknown[] = [];
  const ble = new OrpheCoreInsole({
    profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }),
    bluetooth,
    storage: new MemoryStorage(),
    sharedBridge: { environment: world.createEnvironment(), timing: TIMING },
    events: { onError: (error) => errors.push(error) },
  });
  return { ble, bluetooth, errors };
}

function stepsPacket(steps: number): DataView {
  const data = new DataView(new ArrayBuffer(20));
  data.setUint8(0, 51);
  data.setUint16(2, steps);
  return data;
}

test('useSharedBridge: 2 タブ目は BLE に触らず Secondary として on() で受信する', async () => {
  const world = new MockTabWorld();
  const primary = makeCore(world);
  const { device, step } = mockCoreDevice();
  primary.bluetooth.chooserQueue.push(device);
  await primary.ble.begin('STEP_ANALYSIS', { useSharedBridge: true });
  assert.equal(primary.ble.sharedBridgeRole, 'primary');

  const secondary = makeCore(world);
  const connected: string[] = [];
  secondary.ble.onEvent('onConnect', (uuid) => connected.push(uuid));
  const result = await secondary.ble.begin('STEP_ANALYSIS', { useSharedBridge: true });
  assert.equal(result, 'done begin(); BRIDGE SECONDARY');
  assert.equal(secondary.ble.sharedBridgeRole, 'secondary');
  assert.deepEqual(connected, ['BRIDGE_SECONDARY']);
  assert.equal(secondary.bluetooth.requestDeviceCalls.length, 0);
  assert.equal(secondary.ble.lastBeginType, 'STEP_ANALYSIS');

  const received: number[] = [];
  secondary.ble.on('steps_number', (steps) => received.push(steps.value));
  step.emit(stepsPacket(4));
  assert.deepEqual(received, [4]);

  // Primary が止まると Secondary は切断を受け、自分で接続しにいく（chooser が無いので失敗を報告）
  let disconnected = 0;
  secondary.ble.onEvent('onDisconnect', () => { disconnected++; });
  primary.ble.stop();
  assert.equal(primary.ble.sharedBridgeRole, null);
  await waitFor(() => disconnected === 1, 'secondary onDisconnect');
  await waitFor(() => secondary.errors.some(error => /Primary tab closed/.test(String(error))), 'secondary failure');
  assert.equal(secondary.ble.sharedBridgeRole, null);
});

test('useSharedBridge: 既定は無効で、指定しなければ別タブが接続中でも自分で接続する', async () => {
  const world = new MockTabWorld();
  const first = makeCore(world);
  first.bluetooth.chooserQueue.push(mockCoreDevice().device);
  await first.ble.begin('SENSOR_VALUES', { useSharedBridge: true });

  const second = makeCore(world);
  second.bluetooth.chooserQueue.push(mockCoreDevice().device);
  await second.ble.begin('SENSOR_VALUES');
  assert.equal(second.ble.sharedBridgeRole, null);
  assert.equal(second.bluetooth.requestDeviceCalls.length, 1);
  first.ble.stop();
});

test('useSharedBridge: INSOLE の圧力も Secondary へ配信される', async () => {
  const world = new MockTabWorld();
  const make = () => {
    const bluetooth = new MockBluetooth();
    const ble = new OrpheCoreInsole({
      profile: insoleProfile({ timeSyncSamples: 1, pressureCalibration: { fetch: false } }),
      bluetooth,
      storage: new MemoryStorage(),
      sharedBridge: { environment: world.createEnvironment(), timing: TIMING },
    });
    return { ble, bluetooth };
  };
  const primary = make();
  const { device, sensor } = mockInsoleDevice();
  primary.bluetooth.chooserQueue.push(device);
  await primary.ble.begin('SENSOR_VALUES', { streamingMode: 3, useSharedBridge: true });

  const secondary = make();
  await secondary.ble.begin('SENSOR_VALUES', { streamingMode: 3, useSharedBridge: true });
  const pressures: number[][] = [];
  secondary.ble.on('press', (press) => pressures.push(press.values));

  const packet = new DataView(new ArrayBuffer(104));
  packet.setUint8(0, 55);
  packet.setUint16(1, 1);
  sensor.emit(packet);
  assert.ok(pressures.length > 0, 'press が Secondary に届く');
  assert.equal(pressures[0]!.length, 6);
  primary.ble.stop();
  secondary.ble.stop();
});
