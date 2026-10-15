/**
 * InsoleToolkitSession に OrpheCoreInsole（ここではシミュレータ）をそのまま渡せること。
 * - 既定で FIFO / 歩容解析に FifoRecorder / InsoleGait を使う
 * - リアルタイム計測は onRaw のパケットから記録する
 * - ストリーミングモード切替は commands を通る
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InsoleToolkitSession, insoleFirmwareVersion } from '../../src/session/insole-toolkit-session.ts';
import { createInsoleSimulator } from '../../src/simulator/insole-simulator.ts';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';

test('OrpheCoreInsole を渡すと FifoRecorder / InsoleGait が既定で使える', () => {
  const ble = new OrpheCoreInsole({ profile: insoleProfile(), bluetooth: new MockBluetooth(), storage: new MemoryStorage() });
  const session = new InsoleToolkitSession(ble);
  assert.equal(session.supportsFifo, true);
  assert.equal(session.supportsStepAnalysis, true);
});

test('シミュレータでリアルタイム計測を記録し、ストリーミングモードを切り替えられる', async () => {
  const ble = createInsoleSimulator(0, { preset: 'stand' });
  const session = new InsoleToolkitSession(ble, { simulator: true, profile: 'realtime-full', onError() {} });
  assert.equal(session.supportsFifo, false);
  await session.connect({ autoReconnect: false });
  assert.equal(session.connected, true);
  assert.equal(ble.profile.streaming_mode, 4);

  await session.startMeasurement({ profile: 'realtime-full' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const result = await session.stopMeasurement();
  assert.ok(result, '計測結果がある');
  assert.ok(result!.raw.packets > 0, 'パケットを記録した');
  assert.ok(result!.raw.samples.length > 0, 'サンプルを記録した');

  await session.setStreamingMode(3);
  assert.equal(ble.profile.streaming_mode, 3);
  await session.disconnect();
  assert.equal(ble.isConnected(), false);
});

test('insoleFirmwareVersion: アドバタイズの版を優先し、無ければ FW 名、どちらも無ければ null', () => {
  assert.equal(insoleFirmwareVersion({ firmware: null, lastAdvertisement: null }), null);
  assert.equal(insoleFirmwareVersion({ firmware: { name: 'INS_20260510' }, lastAdvertisement: null }), 'INS_20260510');
  assert.equal(insoleFirmwareVersion({ firmware: { name: 'x' }, lastAdvertisement: { status: { version: '1.0.1' } } }), '1.0.1');
});
