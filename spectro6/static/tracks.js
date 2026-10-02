/* GPX tracks for spectro6.
 *
 * Acoustic SRC lines are a direction from the cube, not a GPS fix. They become
 * a GPX track only after the array's latitude, longitude and a range are known:
 * each pos=tdoa fix is projected that many metres from the array.
 * RID lines already carry latitude and longitude (decimal degrees, or firmware
 * integers in 1e-7 degrees).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Het68Tracks = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const EARTH_M = 6378137;
  const KV = /([A-Za-z_][\w]*)=([^\s]+)/g;

  function kv(line) {
    const out = {};
    KV.lastIndex = 0;
    let m;
    while ((m = KV.exec(line))) out[m[1].toLowerCase()] = m[2];
    return out;
  }

  function num(raw) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim().replace(/[^0-9.eE+-]/g, "");
    if (!s || s === "+" || s === "-" || s === ".") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function degOrE7(raw, limit) {
    if (raw == null) return null;
    const text = String(raw).trim();
    const n = num(text);
    if (n == null) return null;
    if (text.includes(".") || /e/i.test(text)) return n;
    if (Math.abs(n) > limit) return n / 1e7;
    return n;
  }

  function iso(t) {
    if (t == null || t === "") return null;
    if (typeof t === "string" && t.includes("T")) {
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }

  function xml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseConsoleLine(text, hostTs) {
    const line = String(text || "").trim();
    if (!line) return null;
    const head = line.slice(0, 4).toUpperCase();
    const fields = kv(line);
    if (head.startsWith("SRC")) {
      const pos = (fields.pos || "").toLowerCase();
      if (pos && pos !== "tdoa") return null;
      const az = num(fields.az);
      const el = num(fields.el);
      if (az == null || el == null) return null;
      return {
        kind: "src",
        az: az,
        el: el,
        conf: num(fields.conf),
        id: fields.id || "",
        time: iso(hostTs),
      };
    }
    if (head.startsWith("RID")) {
      const lat = degOrE7(fields.lat, 90);
      const lon = degOrE7(fields.lon, 180);
      if (lat == null || lon == null) return null;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      return {
        kind: "rid",
        lat: lat,
        lon: lon,
        ele: num(fields.alt_m),
        id: fields.id || "",
        time: iso(hostTs),
      };
    }
    return null;
  }

  function parseGpx(text) {
    const points = [];
    const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
    let m;
    while ((m = re.exec(text))) {
      const attrs = m[1];
      const body = m[2];
      const lat = num((attrs.match(/\blat="([^"]+)"/i) || [])[1]);
      const lon = num((attrs.match(/\blon="([^"]+)"/i) || [])[1]);
      if (lat == null || lon == null) continue;
      const ele = num((body.match(/<ele>([^<]*)<\/ele>/i) || [])[1]);
      const time = (body.match(/<time>([^<]*)<\/time>/i) || [])[1] || null;
      points.push({ kind: "rid", lat: lat, lon: lon, ele: ele, id: "", time: iso(time) });
    }
    return points;
  }

  function parseDocument(text) {
    const src = String(text || "");
    if (/<trkpt\b/i.test(src)) return parseGpx(src);
    const points = [];
    for (const line of src.split(/\r?\n/)) {
      const hit = parseConsoleLine(line, null);
      if (hit && hit.kind === "rid") points.push(hit);
    }
    return points;
  }

  function project(lat, lon, alt, azDeg, elDeg, rangeM) {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const horiz = rangeM * Math.cos(el);
    const delta = horiz / EARTH_M;
    const φ1 = (lat * Math.PI) / 180;
    const λ1 = (lon * Math.PI) / 180;
    const sinφ2 = Math.sin(φ1) * Math.cos(delta) + Math.cos(φ1) * Math.sin(delta) * Math.cos(az);
    const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
    const λ2 = λ1 + Math.atan2(
      Math.sin(az) * Math.sin(delta) * Math.cos(φ1),
      Math.cos(delta) - Math.sin(φ1) * Math.sin(φ2)
    );
    let lon2 = (λ2 * 180) / Math.PI;
    lon2 = ((lon2 + 540) % 360) - 180;
    return {
      lat: (φ2 * 180) / Math.PI,
      lon: lon2,
      ele: alt + rangeM * Math.sin(el),
    };
  }

  function acousticPoints(fixes, origin) {
    const lat = num(origin.lat);
    const lon = num(origin.lon);
    const alt = num(origin.alt);
    const rangeM = num(origin.rangeM);
    if (lat == null || lon == null || alt == null || rangeM == null || rangeM <= 0) return [];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    const out = [];
    for (const fix of fixes) {
      const p = project(lat, lon, alt, fix.az, fix.el, rangeM);
      const conf = fix.conf == null ? "" : ` conf=${fix.conf}`;
      out.push({
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
        time: fix.time,
        cmt: `az=${fix.az} el=${fix.el}${conf} range_m=${rangeM}`,
      });
    }
    return out;
  }

  function buildGpx(name, desc, points) {
    const rows = points.map((p) => {
      const ele = p.ele == null ? "" : `<ele>${p.ele.toFixed(2)}</ele>`;
      const time = p.time ? `<time>${xml(p.time)}</time>` : "";
      const cmt = p.cmt ? `<cmt>${xml(p.cmt)}</cmt>` : "";
      return (
        `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        `${ele}${time}${cmt}</trkpt>`
      );
    });
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="spectro6" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `<metadata><name>${xml(name)}</name><desc>${xml(desc)}</desc></metadata>\n` +
      `<trk><name>${xml(name)}</name><desc>${xml(desc)}</desc><trkseg>\n` +
      rows.join("\n") +
      `\n</trkseg></trk></gpx>\n`
    );
  }

  return {
    parseConsoleLine: parseConsoleLine,
    parseDocument: parseDocument,
    project: project,
    acousticPoints: acousticPoints,
    buildGpx: buildGpx,
  };
});
