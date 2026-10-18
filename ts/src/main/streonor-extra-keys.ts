import { EventEmitter } from 'node:events';
import type {
  DeviceImageSpec,
  DeviceModel,
  DeviceModelOverride,
  DockDriver,
} from '../devices/driver.js';
import { MINI_MODEL } from '../devices/elgato/mini.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS, MAX_MULTI_DECK_DOCKS } from '../shared/types.js';
import type { KeyEvent } from '../shared/types.js';
import { log } from '../shared/logger.js';
import type { PersistedSettings } from '../infra/settings.js';
import type { DriverManager } from './driver-manager.js';
import type { CoraDockFactory } from './dock-scanner-deps.js';
import { dockSlot } from './dock-status.js';
import { Dock } from './dock.js';

// Mini's left column represents the Streonor's two right-column keys.
const IMAGE_WIRES = new Map([
  [0, 15],
  [3, 10],
]);
const INPUT_KEYS = new Map([
  [5, 0],
  [10, 3],
]);
const CLOCKWISE_QUARTER_TURN = { 0: 90, 90: 180, 180: 270, 270: 0 } as const;
export const STREONOR_EXTRA_DOCK_INDEX = MAX_MULTI_DECK_DOCKS;

/** Shares the primary USB worker; closing this panel never closes the hardware. */
export class StreonorExtraKeysDriver extends EventEmitter implements DockDriver {
  readonly model: DeviceModel = {
    ...MINI_MODEL,
    name: 'Streonor Right Column',
    cora: { ...MINI_MODEL.cora, usePhysicalIdentity: false },
  };
  readonly paintsSplash = false;
  readonly touchStripOptions = DEFAULT_TOUCH_STRIP_OPTIONS;
  private hardware: DockDriver | null = null;
  private readonly frames = new Map<number, Uint8Array>();
  private readonly pressed = new Set<number>();
  private readonly overload = (): void => {
    this.emit('overload');
  };
  private readonly input = ({ keyIndex, state }: KeyEvent): void => {
    const key = INPUT_KEYS.get(keyIndex);
    if (key === undefined) return;
    if (state === 'down') this.pressed.add(key);
    else this.pressed.delete(key);
    this.emit('key', { keyIndex: key, state });
  };

  setHardware(hardware: DockDriver | null): void {
    if (hardware === this.hardware) return;
    this.hardware?.off('key', this.input);
    this.hardware?.off('overload', this.overload);
    for (const keyIndex of this.pressed) this.emit('key', { keyIndex, state: 'up' });
    this.pressed.clear();
    this.hardware = hardware;
    hardware?.on('key', this.input);
    hardware?.on('overload', this.overload);
    for (const [key, bytes] of this.frames) this.paint(key, bytes);
  }

  async open(_hidPath?: string): Promise<void> {}
  close(): Promise<void> {
    this.setHardware(null);
    this.frames.clear();
    return Promise.resolve();
  }

  renderCoraImage(keyIndex: number, bytes: Uint8Array, _format: 'jpeg' | 'bmp'): void {
    if (!IMAGE_WIRES.has(keyIndex)) return;
    this.frames.set(keyIndex, bytes);
    this.paint(keyIndex, bytes);
  }

  private paint(key: number, bytes: Uint8Array): void {
    const hardware = this.hardware;
    if (!hardware) return;
    // Mini CORA BMPs arrive 90 degrees counterclockwise; restore upright before the device transform.
    const spec = {
      ...hardware.model.image,
      rotate: CLOCKWISE_QUARTER_TURN[hardware.model.image.rotate],
    };
    hardware.sendSplashImage(IMAGE_WIRES.get(key)!, bytes, spec);
    this.emit('imageSent', key, false);
  }

  clearKey(keyIndex: number): void {
    this.frames.delete(keyIndex);
    const wire = IMAGE_WIRES.get(keyIndex);
    if (wire !== undefined) this.hardware?.clearKey(wire);
  }

  // Brightness, splash, sleep and touch belong to the primary Plus panel.
  setBrightness(): void {}
  sendSplashImage(_key: number, _bytes: Uint8Array, _spec: DeviceImageSpec): void {}
  renderTouchImage(): void {}
  setTouchStripMask(): void {}
  restoreTouchSegments(): void {}
  setTouchStripOptions(): void {}
  applyOverrides(_overrides: DeviceModelOverride | undefined, _model: DeviceModel): void {}
  setLogLevel(): void {}
}

export function wireStreonorExtraKeys(deps: {
  driverManager: DriverManager;
  settings: PersistedSettings;
  coraDockFactory: CoraDockFactory;
  getShuttingDown: () => boolean;
}): { sync(): Promise<void>; stop(): Promise<void> } {
  const { driverManager: host, settings } = deps;
  const driver = new StreonorExtraKeysDriver();
  let panel: Dock | null = null;
  let deviceKey: string | null = null;
  let stopped = false;
  let chain = Promise.resolve();

  const reconcile = async (): Promise<void> => {
    if (stopped || deps.getShuttingDown()) return;
    const current = host.getCurrentDriver();
    const hardware = current?.model.id === 'streonor-s10-pro' ? current : null;
    const key = hardware ? host.dock(0)?.status().deviceKey : undefined;
    if (!key || key === deviceKey) {
      driver.setHardware(hardware);
      return;
    }
    if (panel) {
      await panel.stop();
      host.removeExternalDock(STREONOR_EXTRA_DOCK_INDEX);
    }
    driver.setHardware(hardware);
    deviceKey = key;
    const identity = settings.getOrCreateIdentity(`${key}:extra-keys`, 'Streonor Right Column');
    const slot = dockSlot(STREONOR_EXTRA_DOCK_INDEX, identity);
    const next = new Dock({
      index: slot.index,
      // Elgato deduplicates docks by IP, even when their ports differ.
      cora: deps.coraDockFactory(slot, '127.0.0.2'),
      ports: { primary: slot.primaryPort, child: slot.childPort },
      identity: slot,
      model: driver.model,
      settings,
      hooks: host.hooksForDock(slot.index),
      statusExtra: () => ({ pairingAddress: '127.0.0.2' }),
      getShuttingDown: deps.getShuttingDown,
    });
    panel = next;
    host.addExternalDock(next);
    try {
      await next.start(driver);
      log(
        'info',
        'streonor-extra',
        `right-column keys: Mini slots 0/3, 127.0.0.2 ports ${slot.primaryPort}/${slot.childPort}`,
      );
    } catch (e) {
      await next.stop().catch(() => undefined);
      host.removeExternalDock(slot.index);
      panel = null;
      log('error', 'streonor-extra', `panel failed: ${(e as Error).message}`);
    }
  };
  const sync = (): Promise<void> => {
    chain = chain.then(reconcile).catch((e: unknown) => {
      log('error', 'streonor-extra', `sync failed: ${String(e)}`);
    });
    return chain;
  };
  const onChange = (): void => {
    void sync();
  };
  host.on('changed', onChange);
  void sync();
  return {
    sync,
    async stop() {
      stopped = true;
      host.off('changed', onChange);
      await chain;
      await panel?.stop();
      host.removeExternalDock(STREONOR_EXTRA_DOCK_INDEX);
      driver.setHardware(null);
    },
  };
}
