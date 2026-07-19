/**
 * WebUSB PICOBOOT client for RP2040 / RP2350 (BOOTSEL mode).
 * Protocol compatible with Raspberry Pi picotool.
 */

export const VID = 0x2e8a;
export const PID_RP2040 = 0x0003;
export const PID_RP2350 = 0x000f;

const PICOBOOT_MAGIC = 0x431fd10b;
const CMD_EXCLUSIVE = 0x01;
const CMD_REBOOT = 0x02;
const CMD_ERASE = 0x03;
const CMD_WRITE = 0x05;
const CMD_EXIT_XIP = 0x06;
const CMD_REBOOT2 = 0x0a;
const REBOOT2_NORMAL = 0x0;
const SRAM_END_RP2040 = 0x20042000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isDisconnectError(e) {
  const name = e?.name || "";
  const msg = String(e?.message || "").toLowerCase();
  return (
    name === "NetworkError" ||
    name === "NotFoundError" ||
    name === "AbortError" ||
    msg.includes("disconnect") ||
    msg.includes("device") ||
    msg.includes("transfer") ||
    msg.includes("not found")
  );
}

export function usbFilters() {
  return [
    { vendorId: VID, productId: PID_RP2040 },
    { vendorId: VID, productId: PID_RP2350 },
    { vendorId: VID },
  ];
}

export function describeDevice(device) {
  if (!device) return "neznámé zařízení";
  if (device.productId === PID_RP2040) return "RP2040 (BOOTSEL)";
  if (device.productId === PID_RP2350) return "RP2350 (BOOTSEL)";
  return `RP2 (PID 0x${device.productId.toString(16).padStart(4, "0")})`;
}

export function mcuOf(device) {
  if (!device) return null;
  if (device.productId === PID_RP2040) return "RP2040";
  if (device.productId === PID_RP2350) return "RP2350";
  return null;
}

function findIface(cfg) {
  const preferredIndex = cfg.interfaces.length <= 1 ? 0 : 1;
  const preferred = cfg.interfaces[preferredIndex];
  if (preferred) {
    const alt = preferred.alternates[0];
    if (alt && alt.interfaceClass === 0xff) {
      const o = alt.endpoints.find((e) => e.direction === "out");
      const n = alt.endpoints.find((e) => e.direction === "in");
      if (o && n) {
        return {
          iface: preferred.interfaceNumber,
          out: o.endpointNumber,
          in: n.endpointNumber,
        };
      }
    }
  }

  for (const i of cfg.interfaces) {
    for (const a of i.alternates) {
      if (a.interfaceClass !== 0xff) continue;
      const o = a.endpoints.find((e) => e.direction === "out");
      const n = a.endpoints.find((e) => e.direction === "in");
      if (o && n) {
        return {
          iface: i.interfaceNumber,
          out: o.endpointNumber,
          in: n.endpointNumber,
        };
      }
    }
  }
  return null;
}

export class PicoBoot {
  /**
   * @param {USBDevice} device
   * @param {{iface:number,out:number,in:number}} endpoints
   */
  constructor(device, endpoints) {
    this.device = device;
    this.iface = endpoints.iface;
    this.outEndpoint = endpoints.out;
    this.inEndpoint = endpoints.in;
    this.token = 1;
  }

  static async open(device) {
    await device.open();
    if (!device.configuration) {
      await device.selectConfiguration(1);
    }
    const endpoints = findIface(device.configuration);
    if (!endpoints) {
      throw new Error("Na zařízení nebyl nalezen PICOBOOT vendor interface");
    }
    const pico = new PicoBoot(device, endpoints);
    await pico.device.claimInterface(pico.iface);
    return pico;
  }

  async close() {
    try {
      await this.device.close();
    } catch (_) {
      /* already gone after reboot */
    }
  }

  async resetInterface() {
    await withTimeout(
      this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "interface",
        request: 0x41,
        value: 0x00,
        index: this.iface,
      }),
      3000,
      "resetInterface"
    );
  }

  async exclusiveAccess(enabled) {
    const cmd = new ArrayBuffer(1);
    new DataView(cmd).setUint8(0, enabled ? 1 : 0);
    await this.runCmd(CMD_EXCLUSIVE, cmd);
  }

  async exitXip() {
    await this.runCmd(CMD_EXIT_XIP);
  }

  async flashErase(addr, size, timeoutMs = 10000) {
    const cmd = new ArrayBuffer(8);
    const view = new DataView(cmd);
    view.setUint32(0, addr >>> 0, true);
    view.setUint32(4, size >>> 0, true);
    await this.runCmd(CMD_ERASE, cmd, undefined, timeoutMs);
  }

  async write(addr, data, timeoutMs = 5000) {
    const cmd = new ArrayBuffer(8);
    const view = new DataView(cmd);
    view.setUint32(0, addr >>> 0, true);
    view.setUint32(4, data.byteLength >>> 0, true);
    await this.runCmd(CMD_WRITE, cmd, data, timeoutMs);
  }

  async rebootToApp(delayMs = 500) {
    try {
      if (this.device.productId === PID_RP2350) {
        const cmd = new ArrayBuffer(16);
        const view = new DataView(cmd);
        view.setUint32(0, REBOOT2_NORMAL, true);
        view.setUint32(4, delayMs >>> 0, true);
        view.setUint32(8, 0, true);
        view.setUint32(12, 0, true);
        await this.runCmd(CMD_REBOOT2, cmd);
      } else {
        const cmd = new ArrayBuffer(12);
        const view = new DataView(cmd);
        view.setUint32(0, 0, true);
        view.setUint32(4, SRAM_END_RP2040, true);
        view.setUint32(8, delayMs >>> 0, true);
        await this.runCmd(CMD_REBOOT, cmd);
      }
    } catch (e) {
      if (!isDisconnectError(e)) throw e;
    }
  }

  /**
   * @param {number} cmdId
   * @param {ArrayBuffer|undefined} cmdData
   * @param {ArrayBuffer|number|undefined} transfer
   * @param {number} timeoutMs
   */
  async runCmd(cmdId, cmdData, transfer, timeoutMs = 3000) {
    const cmd = new ArrayBuffer(32);
    const view = new DataView(cmd);
    view.setUint32(0, PICOBOOT_MAGIC, true);
    view.setUint32(4, this.token++ >>> 0, true);
    view.setUint8(8, cmdId);
    view.setUint8(9, cmdData ? cmdData.byteLength : 0);
    view.setUint16(10, 0x0000, true);

    if (transfer === undefined) {
      view.setUint32(12, 0, true);
    } else if (typeof transfer === "number") {
      view.setUint32(12, transfer >>> 0, true);
    } else {
      view.setUint32(12, transfer.byteLength >>> 0, true);
    }

    if (cmdData) {
      new Uint8Array(cmd, 16, cmdData.byteLength).set(new Uint8Array(cmdData));
    }

    await withTimeout(
      this.device.transferOut(this.outEndpoint, cmd),
      timeoutMs,
      "transferOut(cmd)"
    );

    if (transfer !== undefined) {
      if (cmdId & 0x80) {
        await withTimeout(
          this.device.transferIn(this.inEndpoint, transfer),
          timeoutMs,
          "transferIn(data)"
        );
      } else {
        await withTimeout(
          this.device.transferOut(this.outEndpoint, transfer),
          timeoutMs,
          "transferOut(data)"
        );
      }
    }

    if (cmdId & 0x80) {
      await withTimeout(
        this.device.transferOut(this.outEndpoint, new Uint8Array(0)),
        timeoutMs,
        "transferOut(ack)"
      );
    } else {
      await withTimeout(
        this.device.transferIn(this.inEndpoint, 64),
        timeoutMs,
        "transferIn(status)"
      );
    }
  }
}

/**
 * Erase + write UF2 payload with progress callbacks.
 * @param {PicoBoot} pico
 * @param {{blocks:{addr:number,data:ArrayBuffer}[], ranges:{start:number,end:number}[]}} uf2
 * @param {{sector?:number, onProgress?:(phase:string,pct:number)=>void, erase?:boolean}} [opts]
 */
export async function flashUF2(pico, uf2, opts = {}) {
  const sector = opts.sector ?? 4096;
  const onProgress = opts.onProgress || (() => {});
  const doErase = opts.erase !== false;

  await pico.resetInterface();
  try {
    await pico.exclusiveAccess(1);
  } catch (_) {
    /* some devices reject exclusive — continue */
  }
  await pico.exitXip();

  if (doErase) {
    const totalSectors = uf2.ranges.reduce(
      (sum, r) => sum + Math.ceil((r.end - r.start) / sector),
      0
    );
    let done = 0;
    for (const r of uf2.ranges) {
      for (let addr = r.start; addr < r.end; addr += sector) {
        await pico.flashErase(addr, sector, 15000);
        done += 1;
        onProgress("erase", Math.round((done / totalSectors) * 100));
        if ((done & 7) === 0) await new Promise((x) => setTimeout(x, 0));
      }
    }
  }

  let i = 0;
  for (const block of uf2.blocks) {
    i += 1;
    await pico.write(block.addr, block.data);
    onProgress("write", Math.round((i / uf2.blocks.length) * 100));
    if ((i & 31) === 0) await new Promise((x) => setTimeout(x, 0));
  }

  onProgress("reboot", 100);
  await pico.rebootToApp(500);
}
