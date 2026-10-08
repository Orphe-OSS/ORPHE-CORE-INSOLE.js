/**
 * toolkit のスロット間で同じ Bluetooth デバイスを二重に割り当てないためのガード。
 */
import type { BleDevice } from '../ble/web-bluetooth.ts';

/** transport.device を持つもの（OrpheCoreInsole） */
interface SlotDevice {
  readonly id: number;
  readonly transport: { readonly device: BleDevice | null };
}

/**
 * 別スロットが同じデバイスを使っていれば拒否する DeviceGuard を作る。
 * @param slots スロットの一覧（遅延参照。生成中の配列も扱えるよう関数で渡す）
 * @param id このスロットの番号
 * @param label エラーメッセージに使うデバイス名
 * @param enabled false を返す間は拒否しない
 */
export function duplicateDeviceGuard(
  slots: () => ReadonlyArray<SlotDevice | undefined>,
  id: number,
  label: string,
  enabled: () => boolean = () => true,
): (device: BleDevice) => string | null {
  return (device) => {
    if (!enabled()) return null;
    for (const slot of slots()) {
      if (!slot || slot.id === id) continue;
      const assigned = slot.transport.device;
      if (!assigned) continue;
      if (assigned === device || (assigned.id && device.id && assigned.id === device.id)) {
        return `Bluetooth device "${device.name || device.id || 'unknown'}" is already assigned to ${label} ${String(slot.id + 1).padStart(2, '0')}. Select a different device.`;
      }
    }
    return null;
  };
}
