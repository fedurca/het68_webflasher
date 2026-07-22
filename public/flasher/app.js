import { parseUF2, SECTOR } from "./js/uf2.js";
import {
  PicoBoot,
  flashUF2,
  usbFilters,
  describeDevice as describeDeviceRaw,
  mcuOf,
  VID,
} from "./js/picoboot.js";
import { t, getLang } from "./i18n.js";

const FALLBACK_BOARDS = [
  { id: "het68", label: "het68 board", short: "het68 board", mcu: "RP2350" },
  { id: "pico1", label: "Raspberry Pi Pico", short: "Pico", mcu: "RP2040" },
  { id: "pico1w", label: "Raspberry Pi Pico W", short: "Pico W", mcu: "RP2040" },
  { id: "pico2", label: "Raspberry Pi Pico 2", short: "Pico 2", mcu: "RP2350" },
  { id: "pico2w", label: "Raspberry Pi Pico 2 W", short: "Pico 2 W", mcu: "RP2350" },
  {
    id: "pimoroni",
    label: "Pimoroni Pico Plus 2 W",
    short: "Pimoroni Plus 2 W",
    mcu: "RP2350",
  },
];

// Local metadata (board photo + MCU) keyed by board id, independent of the API.
// Image URLs are resolved against app.js so they work from / and /en/.
const BOARD_META = {
  het68: { mcu: "RP2350", img: "het68.svg" },
  pico1: { mcu: "RP2040", img: "pico1.png" },
  pico1w: { mcu: "RP2040", img: "pico1w.png" },
  pico2: { mcu: "RP2350", img: "pico2.png" },
  pico2w: { mcu: "RP2350", img: "pico2w.png" },
  pimoroni: { mcu: "RP2350", img: "pimoroni.png" },
};

function boardImg(id) {
  const file = BOARD_META[id]?.img;
  if (!file) return null;
  return new URL(`./assets/boards/${file}`, import.meta.url).href;
}

function boardMcu(board) {
  return board?.mcu || BOARD_META[board?.id]?.mcu || null;
}

const els = {
  browserCheck: document.getElementById("browserCheck"),
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
  buildMeta: document.getElementById("buildMeta"),
};

const state = {
  boards: FALLBACK_BOARDS,
  releases: [],
  boardId: "het68",
  tag: "",
  device: null,
  busy: false,
  webUsb: false,
};

function describeDevice(device) {
  const raw = describeDeviceRaw(device);
  if (!device) return t().unknownDevice;
  return raw;
}

function boardDescription(board) {
  return t().boards[board.id] || board.description || "";
}

function log(msg) {
  const ts = new Date().toLocaleTimeString(t().locale);
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

/** Probe the actual browser APIs (not just the UA string). */
function probeCapabilities() {
  const nav = navigator;
  const usb = nav.usb;
  const caps = {
    userAgent: nav.userAgent || "?",
    secureContext: window.isSecureContext === true,
    webusb: !!usb,
    requestDevice: !!(usb && typeof usb.requestDevice === "function"),
    getDevices: !!(usb && typeof usb.getDevices === "function"),
    webhid: !!nav.hid,
    chromium: isChromium(),
    brands: null,
    platform: null,
    mobile: null,
    usbPermission: null,
    pairedDevices: null,
  };
  const uaData = nav.userAgentData;
  if (uaData) {
    if (Array.isArray(uaData.brands)) {
      caps.brands = uaData.brands
        .map((b) => `${b.brand} ${b.version}`)
        .join(", ");
    }
    caps.platform = uaData.platform || null;
    caps.mobile = typeof uaData.mobile === "boolean" ? uaData.mobile : null;
  }
  // Flashing needs WebUSB transfers in a secure context.
  caps.supported = caps.webusb && caps.requestDevice && caps.secureContext;
  return caps;
}

/** Enrich with async APIs (permission state + already-authorized devices). */
async function probeCapabilitiesAsync(caps) {
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const st = await navigator.permissions.query({ name: "usb" });
      caps.usbPermission = st.state;
    } catch (_) {
      caps.usbPermission = "unsupported";
    }
  } else {
    caps.usbPermission = "unsupported";
  }
  if (caps.getDevices) {
    try {
      const devs = await navigator.usb.getDevices();
      caps.pairedDevices = devs.length;
    } catch (_) {
      caps.pairedDevices = null;
    }
  }
  return caps;
}

function capabilityReason(i18n, caps) {
  if (caps.supported) return i18n.capReasonOk;
  if (!caps.secureContext) return i18n.capReasonInsecure;
  if (!caps.webusb) return i18n.capReasonNoUsb;
  if (!caps.requestDevice) return i18n.capReasonNoApi;
  return i18n.capReasonNoUsb;
}

function renderBrowserCheck(caps) {
  const i18n = t();
  const el = els.browserCheck;
  if (!el) return;
  el.hidden = false;
  el.classList.toggle("ok", caps.supported);
  el.classList.toggle("bad", !caps.supported);
  const head = caps.supported ? i18n.capSupported : i18n.capUnsupported;
  const sub = capabilityReason(i18n, caps);
  el.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <span class="bc-text">
      <strong>${head}</strong>
      <span class="bc-sub">${sub}</span>
    </span>`;
}

function logBrowserCheck(caps) {
  const i18n = t();
  log(i18n.capUaLog(caps.userAgent));
  log(i18n.capSupportLog(caps.supported ? i18n.capYes : i18n.capNo));
  const detail = [
    `webusb=${caps.webusb}`,
    `secureContext=${caps.secureContext}`,
    `requestDevice=${caps.requestDevice}`,
    `getDevices=${caps.getDevices}`,
    `webhid=${caps.webhid}`,
    caps.brands ? `brands=[${caps.brands}]` : `chromium=${caps.chromium}`,
    caps.platform ? `platform=${caps.platform}` : null,
    caps.mobile != null ? `mobile=${caps.mobile}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  log(i18n.capCapsLog(detail));
}

function selectedRelease() {
  return state.releases.find((r) => r.tag === state.tag) || null;
}

function boardAvailability(release, boardId) {
  return release?.boards?.[boardId]?.available === true;
}

function updateAssetMeta() {
  const i18n = t();
  const rel = selectedRelease();
  if (!rel) {
    els.releaseMeta.textContent = i18n.noRelease;
    els.assetMeta.textContent = "—";
    return;
  }
  const board = state.boards.find((b) => b.id === state.boardId);
  const info = rel.boards?.[state.boardId];
  const when = rel.published_at
    ? new Date(rel.published_at).toLocaleString(i18n.locale)
    : "—";
  els.releaseMeta.textContent = `${rel.name} · ${when}${
    rel.prerelease ? " · pre-release" : ""
  }`;
  if (info?.available) {
    const kb = Math.round(info.size / 1024);
    els.assetMeta.textContent = i18n.assetLine(
      info.name,
      kb,
      board?.label || state.boardId
    );
  } else {
    els.assetMeta.textContent = i18n.noUf2ForBoard(
      board?.label || state.boardId
    );
  }
}

function updateFlashEnabled() {
  const rel = selectedRelease();
  const hasAsset = boardAvailability(rel, state.boardId);
  els.flashBtn.disabled =
    state.busy || !state.webUsb || !state.device || !hasAsset || !state.tag;
}

function renderBoards() {
  const i18n = t();
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
    const img = boardImg(board.id);
    const thumb = img
      ? `<span class="board-thumb"><img src="${img}" alt="${board.label}" loading="lazy" width="380" height="470" /></span>`
      : "";
    btn.innerHTML = `
      ${thumb}
      <strong>${board.short || board.label}</strong>
      <small>${boardDescription(board)}</small>
      <div class="avail ${available ? "" : "missing"}">${
        rel ? (available ? i18n.uf2Available : i18n.uf2Missing) : "—"
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
  const i18n = t();
  const select = els.releaseSelect;
  select.innerHTML = "";
  if (state.releases.length === 0) {
    select.disabled = true;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = i18n.noReleases;
    select.appendChild(opt);
    state.tag = "";
    return;
  }

  select.disabled = state.busy;
  for (const rel of state.releases) {
    const opt = document.createElement("option");
    opt.value = rel.tag;
    const mark = boardAvailability(rel, state.boardId)
      ? ""
      : i18n.noUf2ForBoardOpt;
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
  const i18n = t();
  els.releaseSelect.disabled = true;
  els.releaseSelect.innerHTML = `<option>${i18n.loadingReleases}</option>`;
  setStatus(i18n.loadingReleasesStatus);
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
    setStatus(i18n.loadedReleases(state.releases.length));
    log(i18n.releasesFrom(data.source || data.repo, state.releases.length));
  } catch (e) {
    log(`ERROR: releases — ${e.message}`);
    setStatus(i18n.loadError(e.message));
    els.releaseSelect.innerHTML = `<option>${i18n.loadErrorOpt}</option>`;
  }
}

async function connectDevice() {
  const i18n = t();
  if (!state.webUsb) {
    setStatus(i18n.webusbUnsupported);
    return;
  }
  try {
    setStatus(i18n.pickDevice);
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
      throw new Error(i18n.unsupportedDevice);
    }
    const board = state.boards.find((b) => b.id === state.boardId);
    const expectedMcu = boardMcu(board);
    if (expectedMcu && mcu !== expectedMcu) {
      log(i18n.warnMcu(mcu, expectedMcu, board?.label || state.boardId));
    }

    state.device = device;
    els.deviceMeta.textContent = i18n.boardLabel(describeDevice(device));
    setStatus(i18n.boardConnected);
    log(i18n.connected(describeDevice(device)));
    updateFlashEnabled();
  } catch (e) {
    if (e?.name === "NotFoundError") {
      setStatus(i18n.selectionCanceled);
      log(i18n.selectionCanceled);
      return;
    }
    setStatus(i18n.connectFailed(e.message));
    log(`ERROR: ${e.message}`);
  }
}

async function downloadFirmware() {
  const i18n = t();
  const url = `/api/firmware/${encodeURIComponent(state.tag)}/${encodeURIComponent(
    state.boardId
  )}`;
  log(i18n.downloadingUrl(url));
  setStatus(i18n.downloading);
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
  log(i18n.downloaded(assetName, buf.byteLength));
  setStatus(i18n.parsing);
  const uf2 = await parseUF2(buf, (pct) => setProgress(pct, "load"));
  const family =
    uf2.familyId != null ? `, family 0x${uf2.familyId.toString(16)}` : "";
  log(i18n.uf2Parsed(uf2.blocks.length, uf2.ranges.length, family));
  return { uf2, assetName };
}

async function runFlash() {
  const i18n = t();
  if (state.busy) return;
  if (!state.device) {
    setStatus(i18n.connectBoardFirst);
    return;
  }
  if (!boardAvailability(selectedRelease(), state.boardId)) {
    setStatus(i18n.missingUf2);
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
    setStatus(i18n.openingPicoboot);
    log(i18n.flashingTo(assetName, describeDevice(state.device)));

    let device = state.device;
    try {
      pico = await PicoBoot.open(device);
    } catch (openErr) {
      log(i18n.reopenNeeded(openErr.message));
      device = await navigator.usb.requestDevice({ filters: usbFilters() });
      state.device = device;
      els.deviceMeta.textContent = i18n.boardLabel(describeDevice(device));
      pico = await PicoBoot.open(device);
    }

    await flashUF2(pico, uf2, {
      sector: SECTOR,
      erase: els.eraseToggle.checked,
      onProgress(phase, pct) {
        setProgress(pct, phase);
        if (phase === "erase") setStatus(i18n.erasing(pct));
        if (phase === "write") setStatus(i18n.writing(pct));
        if (phase === "reboot") setStatus(i18n.rebooting);
      },
    });

    setProgress(100, "write");
    setStatus(i18n.done);
    log(i18n.flashDone);
    state.device = null;
    els.deviceMeta.textContent = i18n.boardAfterReboot;
  } catch (e) {
    setStatus(i18n.error(e.message));
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

const THEME_KEY = "het68-theme";

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById("themeToggle");
  if (btn) {
    // Show the icon of the theme you switch TO.
    btn.textContent = t === "light" ? "\u263e" : "\u2600";
    btn.setAttribute("aria-pressed", String(t === "light"));
  }
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch (_) {
    /* private mode */
  }
}

function buildAgeString(fromIso) {
  const then = new Date(fromIso).getTime();
  if (!isFinite(then)) return null;
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} d`;
}

function fmtBuildDateTime(d) {
  const p = (n) => (n < 10 ? "0" : "") + n;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

function renderBuildMeta() {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
  const el = els.buildMeta;
  if (!el) return;
  const i18n = t();
  fetch("/build-info.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (!info || !info.version) return;
      const parts = [`v${info.version}`];
      const date = new Date(info.deployedAt);
      if (!isNaN(date.getTime())) {
        parts.push(`${i18n.buildDeployed} ${fmtBuildDateTime(date)}`);
        const age = buildAgeString(info.deployedAt);
        if (age) parts.push(i18n.buildAgo(age));
      }
      if (info.commit) parts.push(info.commit);
      el.textContent = parts.join(" · ");
      el.hidden = false;
      el.title = info.deployedAt || "";
    })
    .catch(() => {});
}

function bindThemeToggle() {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  applyTheme(currentTheme());
  btn.addEventListener("click", () => {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  });
}

function bindUsbEvents() {
  if (!navigator.usb) return;
  navigator.usb.addEventListener("disconnect", (event) => {
    if (state.device && event.device === state.device) {
      const i18n = t();
      state.device = null;
      els.deviceMeta.textContent = i18n.boardDisconnected;
      updateFlashEnabled();
      log(i18n.boardDisconnectedLog);
    }
  });
}

function init() {
  void getLang();
  const i18n = t();

  const caps = probeCapabilities();
  state.webUsb = caps.supported;
  renderBrowserCheck(caps);
  logBrowserCheck(caps);
  if (!state.webUsb) {
    els.browserWarning.hidden = false;
    els.connectBtn.disabled = true;
    els.flashBtn.disabled = true;
  }
  // Enrich the report with async APIs (permission state, paired devices).
  probeCapabilitiesAsync(caps).then((full) => {
    log(
      i18n.capApiLog(
        String(full.usbPermission),
        full.pairedDevices == null ? "n/a" : String(full.pairedDevices)
      )
    );
  });

  els.refreshReleases.addEventListener("click", () => loadReleases());
  els.releaseSelect.addEventListener("change", () => {
    state.tag = els.releaseSelect.value;
    renderBoards();
    updateAssetMeta();
    updateFlashEnabled();
  });
  els.connectBtn.addEventListener("click", () => connectDevice());
  els.flashBtn.addEventListener("click", () => runFlash());

  bindThemeToggle();
  renderBuildMeta();
  bindUsbEvents();
  renderBoards();
  loadReleases();
  log(state.webUsb ? i18n.readyWebusb : i18n.noWebusb);
}

init();
