import { parseUF2, SECTOR } from "./js/uf2.js";
import {
  PicoBoot,
  flashUF2,
  usbFilters,
  describeDevice,
  mcuOf,
  VID,
} from "./js/picoboot.js";

const FALLBACK_BOARDS = [
  {
    id: "pico2",
    label: "Raspberry Pi Pico 2",
    short: "Pico 2",
    description: "RP2350 · bez Wi‑Fi",
  },
  {
    id: "pico2w",
    label: "Raspberry Pi Pico 2 W",
    short: "Pico 2 W",
    description: "RP2350 · CYW43439 Wi‑Fi / BT",
  },
  {
    id: "pimoroni",
    label: "Pimoroni Pico Plus 2 W",
    short: "Pimoroni Plus 2 W",
    description: "RP2350 · 8 MB PSRAM · 16 MB flash · Wi‑Fi / BT",
  },
];

const els = {
  boardGrid: document.getElementById("boardGrid"),
  releaseSelect: document.getElementById("releaseSelect"),
  refreshReleases: document.getElementById("refreshReleases"),
  releaseMeta: document.getElementById("releaseMeta"),
  assetMeta: document.getElementById("assetMeta"),
  connectBtn: document.getElementById("connectBtn"),
  deviceMeta: document.getElementById("deviceMeta"),
  flashBtn: document.getElementById("flashBtn"),
  eraseToggle: document.getElementById("eraseToggle"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  statusMeta: document.getElementById("statusMeta"),
  log: document.getElementById("log"),
  logDetails: document.getElementById("logDetails"),
  browserWarning: document.getElementById("browserWarning"),
};

const state = {
  boards: FALLBACK_BOARDS,
  releases: [],
  boardId: "pico2",
  tag: "",
  device: null,
  busy: false,
  webUsb: false,
};

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  els.log.textContent += `[${ts}] ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text) {
  els.statusMeta.textContent = text;
}

function setProgress(pct, phase) {
  const value = Math.max(0, Math.min(100, pct | 0));
  els.progressBar.style.width = `${value}%`;
  els.progressLabel.textContent = `${value}%`;
  els.progressBar.classList.remove("phase-erase", "phase-write");
  if (phase === "erase") els.progressBar.classList.add("phase-erase");
  if (phase === "write") els.progressBar.classList.add("phase-write");
}

function isChromium() {
  const ua = navigator.userAgent;
  const chromium = /Chrome|Chromium|Edg|Brave/.test(ua);
  const firefox = /Firefox/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|Brave/.test(ua);
  return chromium && !firefox && !safari;
}

function selectedRelease() {
  return state.releases.find((r) => r.tag === state.tag) || null;
}

function boardAvailability(release, boardId) {
  return release?.boards?.[boardId]?.available === true;
}

function updateAssetMeta() {
  const rel = selectedRelease();
  if (!rel) {
    els.releaseMeta.textContent = "Žádný release";
    els.assetMeta.textContent = "—";
    return;
  }
  const board = state.boards.find((b) => b.id === state.boardId);
  const info = rel.boards?.[state.boardId];
  const when = rel.published_at
    ? new Date(rel.published_at).toLocaleString("cs-CZ")
    : "—";
  els.releaseMeta.textContent = `${rel.name} · ${when}${
    rel.prerelease ? " · pre-release" : ""
  }`;
  if (info?.available) {
    const kb = Math.round(info.size / 1024);
    els.assetMeta.textContent = `Asset: ${info.name} (${kb} KiB) · ${
      board?.label || state.boardId
    }`;
  } else {
    els.assetMeta.textContent = `Pro ${
      board?.label || state.boardId
    } v této verzi není UF2 k dispozici`;
  }
}

function updateFlashEnabled() {
  const rel = selectedRelease();
  const hasAsset = boardAvailability(rel, state.boardId);
  els.flashBtn.disabled =
    state.busy || !state.webUsb || !state.device || !hasAsset || !state.tag;
}

function renderBoards() {
  const rel = selectedRelease();
  els.boardGrid.innerHTML = "";
  for (const board of state.boards) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "board-card";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(board.id === state.boardId));
    const available = rel ? boardAvailability(rel, board.id) : true;
    btn.disabled = state.busy;
    btn.innerHTML = `
      <strong>${board.short || board.label}</strong>
      <small>${board.description || ""}</small>
      <div class="avail ${available ? "" : "missing"}">${
        rel ? (available ? "UF2 dostupný" : "UF2 chybí") : "—"
      }</div>
    `;
    btn.addEventListener("click", () => {
      state.boardId = board.id;
      renderBoards();
      updateAssetMeta();
      updateFlashEnabled();
    });
    els.boardGrid.appendChild(btn);
  }
}

function renderReleases() {
  const select = els.releaseSelect;
  select.innerHTML = "";
  if (state.releases.length === 0) {
    select.disabled = true;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Žádné releases s UF2";
    select.appendChild(opt);
    state.tag = "";
    return;
  }

  select.disabled = state.busy;
  for (const rel of state.releases) {
    const opt = document.createElement("option");
    opt.value = rel.tag;
    const mark = boardAvailability(rel, state.boardId) ? "" : " · bez UF2 pro desku";
    opt.textContent = `${rel.tag}${rel.prerelease ? " (pre)" : ""}${mark}`;
    select.appendChild(opt);
  }

  if (!state.tag || !state.releases.some((r) => r.tag === state.tag)) {
    const preferred =
      state.releases.find(
        (r) => !r.prerelease && boardAvailability(r, state.boardId)
      ) ||
      state.releases.find((r) => boardAvailability(r, state.boardId)) ||
      state.releases[0];
    state.tag = preferred.tag;
  }
  select.value = state.tag;
}

async function loadReleases() {
  els.releaseSelect.disabled = true;
  els.releaseSelect.innerHTML = "<option>Načítám releases…</option>";
  setStatus("Načítám seznam releases…");
  try {
    const res = await fetch(`/api/releases?_=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.boards = data.boards?.length ? data.boards : FALLBACK_BOARDS;
    state.releases = data.releases || [];
    if (data.latest?.tag) state.tag = data.latest.tag;
    renderReleases();
    renderBoards();
    updateAssetMeta();
    updateFlashEnabled();
    setStatus(`Načteno ${state.releases.length} release(ů)`);
    log(`Releases z ${data.source || data.repo}: ${state.releases.length}`);
  } catch (e) {
    log(`ERROR: releases — ${e.message}`);
    setStatus(`Chyba načtení releases: ${e.message}`);
    els.releaseSelect.innerHTML = "<option>Chyba načtení</option>";
  }
}

async function connectDevice() {
  if (!state.webUsb) {
    setStatus("WebUSB není podporováno");
    return;
  }
  try {
    setStatus("Vyber zařízení v dialogu…");
    const existing = await navigator.usb.getDevices();
    let device =
      existing.find(
        (d) =>
          d.vendorId === VID &&
          (d.productId === 0x0003 || d.productId === 0x000f)
      ) || null;

    if (!device) {
      device = await navigator.usb.requestDevice({ filters: usbFilters() });
    }

    const mcu = mcuOf(device);
    if (!mcu) {
      throw new Error("Nepodporované zařízení (očekáván RP2040/RP2350 BOOTSEL)");
    }
    if (mcu !== "RP2350") {
      log(`Varování: detekován ${mcu}. HET68 cílí na RP2350.`);
    }

    state.device = device;
    els.deviceMeta.textContent = `Deska: ${describeDevice(device)}`;
    setStatus("Deska připojena");
    log(`Připojeno: ${describeDevice(device)}`);
    updateFlashEnabled();
  } catch (e) {
    if (e?.name === "NotFoundError") {
      setStatus("Výběr zařízení zrušen");
      log("Výběr zařízení zrušen");
      return;
    }
    setStatus(`Připojení selhalo: ${e.message}`);
    log(`ERROR: ${e.message}`);
  }
}

async function downloadFirmware() {
  const url = `/api/firmware/${encodeURIComponent(state.tag)}/${encodeURIComponent(
    state.boardId
  )}`;
  log(`Stahuji ${url}`);
  setStatus("Stahuji UF2…");
  setProgress(0, "load");

  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) detail = body.error;
    } catch (_) {
      /* binary error body */
    }
    throw new Error(detail);
  }

  const assetName = res.headers.get("x-het68-asset") || "firmware.uf2";
  const buf = await res.arrayBuffer();
  log(`Staženo ${assetName} (${buf.byteLength} B)`);
  setStatus("Parsuji UF2…");
  const uf2 = await parseUF2(buf, (pct) => setProgress(pct, "load"));
  log(
    `UF2: ${uf2.blocks.length} bloků, ${uf2.ranges.length} rozsah(ů)${
      uf2.familyId != null ? `, family 0x${uf2.familyId.toString(16)}` : ""
    }`
  );
  return { uf2, assetName };
}

async function runFlash() {
  if (state.busy) return;
  if (!state.device) {
    setStatus("Nejdřív připoj desku");
    return;
  }
  if (!boardAvailability(selectedRelease(), state.boardId)) {
    setStatus("Pro vybranou desku chybí UF2");
    return;
  }

  state.busy = true;
  updateFlashEnabled();
  els.connectBtn.disabled = true;
  els.releaseSelect.disabled = true;
  els.refreshReleases.disabled = true;
  renderBoards();
  els.logDetails.open = true;

  let pico = null;
  try {
    const { uf2, assetName } = await downloadFirmware();
    setStatus("Otevírám PICOBOOT…");
    log(`Flashuji ${assetName} na ${describeDevice(state.device)}`);

    // Re-request if device handle went stale
    let device = state.device;
    try {
      pico = await PicoBoot.open(device);
    } catch (openErr) {
      log(`Reopen potřeba (${openErr.message}), žádám zařízení znovu…`);
      device = await navigator.usb.requestDevice({ filters: usbFilters() });
      state.device = device;
      els.deviceMeta.textContent = `Deska: ${describeDevice(device)}`;
      pico = await PicoBoot.open(device);
    }

    await flashUF2(pico, uf2, {
      sector: SECTOR,
      erase: els.eraseToggle.checked,
      onProgress(phase, pct) {
        setProgress(pct, phase);
        if (phase === "erase") setStatus(`Mazání flash… ${pct}%`);
        if (phase === "write") setStatus(`Zápis firmware… ${pct}%`);
        if (phase === "reboot") setStatus("Reboot do aplikace…");
      },
    });

    setProgress(100, "write");
    setStatus("Hotovo — deska by měla naběhnout s novým firmware");
    log("Flash dokončen, reboot odeslán");
    state.device = null;
    els.deviceMeta.textContent = "Deska: odpojeno po rebootu (OK)";
  } catch (e) {
    setStatus(`Chyba: ${e.message}`);
    log(`ERROR: ${e.message}`);
  } finally {
    if (pico) {
      try {
        await pico.close();
      } catch (_) {
        /* ignore */
      }
    }
    state.busy = false;
    els.connectBtn.disabled = !state.webUsb;
    els.refreshReleases.disabled = false;
    renderReleases();
    renderBoards();
    updateAssetMeta();
    updateFlashEnabled();
  }
}

function bindUsbEvents() {
  if (!navigator.usb) return;
  navigator.usb.addEventListener("disconnect", (event) => {
    if (state.device && event.device === state.device) {
      state.device = null;
      els.deviceMeta.textContent = "Deska: odpojeno";
      updateFlashEnabled();
      log("Deska odpojena");
    }
  });
}

function init() {
  state.webUsb = !!navigator.usb && isChromium();
  if (!state.webUsb) {
    els.browserWarning.hidden = false;
    els.connectBtn.disabled = true;
    els.flashBtn.disabled = true;
  }

  els.refreshReleases.addEventListener("click", () => loadReleases());
  els.releaseSelect.addEventListener("change", () => {
    state.tag = els.releaseSelect.value;
    renderBoards();
    updateAssetMeta();
    updateFlashEnabled();
  });
  els.connectBtn.addEventListener("click", () => connectDevice());
  els.flashBtn.addEventListener("click", () => runFlash());

  bindUsbEvents();
  renderBoards();
  loadReleases();
  log(
    state.webUsb
      ? "WebUSB připraveno. Dej desku do BOOTSEL a připoj."
      : "WebUSB není k dispozici — použij Chromium prohlížeč."
  );
}

init();
