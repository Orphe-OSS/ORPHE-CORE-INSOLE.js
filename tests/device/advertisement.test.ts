/**
 * OrpheCoreInsole.watchAdvertisements: INSOLE のアドバタイズを on('status') で受ける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrpheCoreInsole } from '../../src/device/orphe-core-insole.ts';
import { insoleProfile } from '../../src/profiles/insole.ts';
import { coreProfile } from '../../src/profiles/core.ts';
import { decodeInsoleAdvertisement } from '../../src/protocol/advertisement.ts';
import type { InsoleAdvertisementStatus } from '../../src/protocol/advertisement.ts';
import { MemoryStorage, MockBluetooth } from '../helpers/mock-bluetooth.ts';
import { mockInsoleDevice } from '../helpers/insole-device.ts';
import { mockCoreDevice } from '../helpers/core-device.ts';

function advertisement(battery: number, version: [number, number, number]) {
  const dv = new DataView(new ArrayBuffer(18));
  dv.setUint8(5, 1);
  dv.setUint8(6, 1);
  dv.setUint8(14, battery);
  dv.setUint8(15, version[0]);
  dv.setUint8(16, version[1]);
  dv.setUint8(17, version[2]);
  return {
    device: { id: 'ins-1', name: 'INS-1' },
    rssi: -60,
    manufacturerData: new Map([[0x0000, dv]]),
  };
}

test('decodeInsoleAdvertisement: manufacturerData 0x0000 を状態に変換し、短いデータは null', () => {
  const status = decodeInsoleAdvertisement(advertisement(80, [1, 2, 3]))!;
  assert.equal(status.battery, 80);
  assert.equal(status.version, '1.2.3');
  assert.equal(status.mounting_position, 1);
  assert.equal(decodeInsoleAdvertisement({ manufacturerData: new Map([[0, new DataView(new ArrayBuffer(4))]]) }), null);
  assert.equal(decodeInsoleAdvertisement(null), null);
});

test('watchAdvertisements: INSOLE は on("status") と onEvent("onAdvertisement") に届き lastAdvertisement に残る', async () => {
  const bluetooth = new MockBluetooth();
  const mock = mockInsoleDevice();
  let watching = 0;
  (mock.device as unknown as { watchAdvertisements(): Promise<void> }).watchAdvertisements = async () => { watching++; };
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({
    profile: insoleProfile({ timeSyncSamples: 1, pressureCalibration: { fetch: false } }),
    bluetooth,
    storage: new MemoryStorage(),
  });
  assert.equal(await ble.watchAdvertisements(), false, 'デバイス未選択なら false');
  await ble.begin('SENSOR_VALUES');

  const statuses: InsoleAdvertisementStatus[] = [];
  let raw = 0;
  ble.on('status', (status) => statuses.push(status));
  ble.onEvent('onAdvertisement', () => { raw++; });
  assert.equal(await ble.watchAdvertisements(), true);
  assert.equal(watching, 1);

  mock.device.dispatch('advertisementreceived', advertisement(2, [1, 0, 1]));
  assert.equal(raw, 1);
  assert.equal(statuses[0]!.version, '1.0.1');
  assert.equal(ble.lastAdvertisement?.status?.battery, 2);

  ble.stopWatchingAdvertisements();
  mock.device.dispatch('advertisementreceived', advertisement(1, [1, 0, 2]));
  assert.equal(statuses.length, 1);
});

test('watchAdvertisements: CORE は on() には配送しないが onAdvertisement は届く', async () => {
  const bluetooth = new MockBluetooth();
  const mock = mockCoreDevice();
  (mock.device as unknown as { watchAdvertisements(): Promise<void> }).watchAdvertisements = async () => {};
  bluetooth.chooserQueue.push(mock.device);
  const ble = new OrpheCoreInsole({ profile: coreProfile({ settleMs: 0, timeSyncSamples: 1 }), bluetooth, storage: new MemoryStorage() });
  await ble.begin('SENSOR_VALUES');
  let raw = 0;
  let samples = 0;
  ble.onEvent('onAdvertisement', () => { raw++; });
  ble.on('*', () => { samples++; });
  await ble.watchAdvertisements();
  mock.device.dispatch('advertisementreceived', advertisement(2, [1, 0, 1]));
  assert.equal(raw, 1);
  assert.equal(samples, 0);
  assert.equal(ble.lastAdvertisement, null);
});
