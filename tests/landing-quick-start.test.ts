/** 紹介ページの掲載コードそのものを実行し、両機種で加速度が表示されることを検証する。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window, type HTMLButtonElement } from 'happy-dom';
import { buildLandingPages, LANGUAGES } from '../scripts/build-landing.mjs';
import { OrpheCoreInsole } from '../src/device/orphe-core-insole.ts';
import { autoProfile } from '../src/profiles/auto.ts';
import { MemoryStorage, MockBluetooth } from './helpers/mock-bluetooth.ts';
import { mockCoreDevice } from './helpers/core-device.ts';
import { mockInsoleDevice } from './helpers/insole-device.ts';

for (const language of ['ja', 'en'] as const) {
  for (const kind of ['core', 'insole'] as const) {
    test(`掲載クイックスタート: ${language} / ${kind} で加速度を表示する`, async () => {
      const bluetooth = new MockBluetooth();
      const mock = kind === 'core' ? mockCoreDevice() : mockInsoleDevice();
      bluetooth.chooserQueue.push(mock.device);
      const ble = new OrpheCoreInsole({
        profile: autoProfile({ core: { settleMs: 0, timeSyncSamples: 1 }, insole: { timeSyncSamples: 1 } }),
        bluetooth, storage: new MemoryStorage(), wait: async () => {},
      });
      const window = new Window();
      try {
        const document = window.document;
        document.documentElement.innerHTML = buildLandingPages().outputs[LANGUAGES[language].file]!;
        const snippet = document.getElementById('quick-start-code')!.textContent;
        document.body.innerHTML = snippet;
        const script = document.body.querySelector('script:not([src])')!.textContent;
        const logs: unknown[][] = [];
        vm.runInNewContext(script, {
          document,
          OrpheCoreInsoleJS: { OrpheCoreInsole: function () { return ble; } },
          console: { log: (...args: unknown[]) => logs.push(args) },
        });
        const connect = document.getElementById('connect') as HTMLButtonElement;
        await (connect.onclick as unknown as () => Promise<void>)();
        assert.equal(ble.lastBeginType, 'SENSOR_VALUES');
        assert.ok(mock.sensor.notifying);
        assert.equal(ble.profile.kind, kind);
        assert.deepEqual(logs.at(-1), ['connected:', kind]);

        // 全サンプルに同じ加速度を入れ、最後の表示値まで確認する。
        const packet = new DataView(new ArrayBuffer(kind === 'core' ? 92 : 104));
        packet.setUint8(0, kind === 'core' ? 50 : 56);
        for (let i = 0; i < (kind === 'core' ? 4 : 2); i++) {
          const offset = kind === 'core' ? 22 + 21 * i : 22 + 32 * i;
          packet.setInt16(offset, 16384);
          packet.setInt16(offset + 2, -8192);
          packet.setInt16(offset + 4, 2048);
        }
        mock.sensor.emit(packet);
        assert.deepEqual(JSON.parse(document.getElementById('sensor-data')!.textContent), { x: 8, y: -4, z: 1 });
        const pressure = document.getElementById('pressure-data')!.textContent;
        if (kind === 'insole') assert.deepEqual(JSON.parse(pressure), [0, 0, 0, 0, 0, 0]);
        else assert.equal(pressure, '');
      } finally {
        ble.stop();
        await window.happyDOM.close();
      }
    });
  }
}
