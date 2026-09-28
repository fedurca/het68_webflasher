/* WebGL view of the 128 mm vertex-down cube, ground grid, and drone path. */
(() => {
  const MIC_DIR = [
    [0.8165, 0, 0.57735],
    [-0.40825, 0.70711, 0.57735],
    [-0.40825, -0.70711, 0.57735],
    [-0.8165, 0, -0.57735],
    [0.40825, -0.70711, -0.57735],
    [0.40825, 0.70711, -0.57735],
  ];
  const TRIPLES = [
    [0, 1, 2], [0, 1, 5], [0, 2, 4], [0, 4, 5],
    [1, 2, 3], [1, 3, 5], [2, 3, 4], [3, 4, 5],
  ];
  const EDGE_M = 0.128;
  const FACE_R = EDGE_M / 2;
  const CUBE_Z = 1.3;
  const TUBE_R = 0.015;
  const CAM0 = { yaw: 0.7, pitch: 0.45, dist: 4.2 };

  function unitSum(idx) {
    const s = [0, 0, 0];
    for (const i of idx) {
      s[0] += MIC_DIR[i][0];
      s[1] += MIC_DIR[i][1];
      s[2] += MIC_DIR[i][2];
    }
    const n = Math.hypot(s[0], s[1], s[2]) || 1;
    return [s[0] / n, s[1] / n, s[2] / n];
  }
  const VERTS = TRIPLES.map(unitSum);
  const EDGES = [];
  for (let i = 0; i < TRIPLES.length; i++) {
    for (let j = i + 1; j < TRIPLES.length; j++) {
      let share = 0;
      for (const a of TRIPLES[i]) if (TRIPLES[j].includes(a)) share++;
      if (share === 2) EDGES.push([i, j]);
    }
  }

  function circle(z, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = -((i / steps) * Math.PI * 2);
      pts.push([Math.cos(a), Math.sin(a), z]);
    }
    return pts;
  }

  const PLAN = [
    ...circle(1, 72),
    [1, 0, 3],
    ...circle(3, 72),
    [1, 0, 0],
  ];

  function lookAt(eye, target, up) {
    const z = norm(sub(eye, target));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ];
  }
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ];
  }
  function mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function norm(a) {
    const n = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
  }
  function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

  function place(dir) {
    const h = Math.hypot(dir[0], dir[1]);
    const s = h > 0.08 ? 1 / h : 1;
    return [dir[0] * s, dir[1] * s, CUBE_Z + dir[2] * s];
  }

  const VS = `
    attribute vec3 aPos;
    attribute vec3 aCol;
    uniform mat4 uMvp;
    varying vec3 vCol;
    void main() {
      gl_Position = uMvp * vec4(aPos, 1.0);
      vCol = aCol;
      gl_PointSize = 9.0;
    }`;
  const FS = `
    precision mediump float;
    varying vec3 vCol;
    void main() { gl_FragColor = vec4(vCol, 1.0); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader");
    }
    return sh;
  }

  function attach(canvas) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || "link");
    }
    const buf = gl.createBuffer();
    const locPos = gl.getAttribLocation(prog, "aPos");
    const locCol = gl.getAttribLocation(prog, "aCol");
    const locMvp = gl.getUniformLocation(prog, "uMvp");
    const cam = { yaw: CAM0.yaw, pitch: CAM0.pitch, dist: CAM0.dist };
    let grid = true;
    let drag = null;

    canvas.addEventListener("pointerdown", (ev) => {
      drag = { x: ev.clientX, y: ev.clientY, yaw: cam.yaw, pitch: cam.pitch };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      cam.yaw = drag.yaw + (ev.clientX - drag.x) * 0.008;
      cam.pitch = Math.max(-0.2, Math.min(1.25, drag.pitch + (ev.clientY - drag.y) * 0.008));
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
    canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      cam.dist = Math.max(1.2, Math.min(8, cam.dist * (ev.deltaY > 0 ? 1.08 : 0.92)));
    }, { passive: false });

    function mvp() {
      const cp = Math.cos(cam.pitch);
      const sp = Math.sin(cam.pitch);
      const eye = [
        cam.dist * cp * Math.sin(cam.yaw),
        -cam.dist * cp * Math.cos(cam.yaw),
        CUBE_Z + cam.dist * sp,
      ];
      const view = lookAt(eye, [0, 0, CUBE_Z], [0, 0, 1]);
      const aspect = Math.max(0.2, canvas.width / Math.max(1, canvas.height));
      return mul(perspective(0.7, aspect, 0.05, 40), view);
    }

    function push(dst, p, c) {
      dst.push(p[0], p[1], p[2], c[0], c[1], c[2]);
    }

    function frame(state) {
      const w = canvas.clientWidth || 640;
      const h = canvas.clientHeight || 480;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.02, 0.035, 0.025, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(locMvp, false, new Float32Array(mvp()));

      const lines = [];
      const tris = [];
      const center = [0, 0, CUBE_Z];
      if (state.grid) {
        const gc = [0.15, 0.22, 0.16];
        for (let i = -4; i <= 4; i++) {
          push(lines, [i * 0.5, -2, 0], gc);
          push(lines, [i * 0.5, 2, 0], gc);
          push(lines, [-2, i * 0.5, 0], gc);
          push(lines, [2, i * 0.5, 0], gc);
        }
      }
      const axis = 0.55;
      push(lines, center, [1, 0.25, 0.2]);
      push(lines, add3(center, [axis, 0, 0]), [1, 0.25, 0.2]);
      push(lines, center, [0.3, 0.85, 0.35]);
      push(lines, add3(center, [0, axis, 0]), [0.3, 0.85, 0.35]);
      push(lines, center, [0.35, 0.55, 1]);
      push(lines, add3(center, [0, 0, axis]), [0.35, 0.55, 1]);

      const black = [0.02, 0.02, 0.02];
      const edgeCol = [0.22, 0.22, 0.22];
      for (let face = 0; face < 6; face++) {
        const ids = [];
        TRIPLES.forEach((t, i) => { if (t.includes(face)) ids.push(i); });
        const nrm = MIC_DIR[face];
        const ref = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const tng = norm(cross(nrm, ref));
        const bit = cross(nrm, tng);
        ids.sort((ia, ib) => {
          const da = VERTS[ia];
          const db = VERTS[ib];
          return Math.atan2(dot(da, bit), dot(da, tng)) - Math.atan2(dot(db, bit), dot(db, tng));
        });
        const q = ids.map((i) => add3(center, scale3(VERTS[i], FACE_R * Math.sqrt(3))));
        if (q.length === 4) {
          push(tris, q[0], black); push(tris, q[1], black); push(tris, q[2], black);
          push(tris, q[0], black); push(tris, q[2], black); push(tris, q[3], black);
        }
      }
      for (const [a, b] of EDGES) {
        const pa = add3(center, scale3(VERTS[a], FACE_R * Math.sqrt(3)));
        const pb = add3(center, scale3(VERTS[b], FACE_R * Math.sqrt(3)));
        push(lines, pa, edgeCol);
        push(lines, pb, edgeCol);
      }
      const gray = [0.58, 0.58, 0.6];
      const gray2 = [0.4, 0.4, 0.42];
      const seg = 16;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        const p0 = [Math.cos(a0) * TUBE_R, Math.sin(a0) * TUBE_R];
        const p1 = [Math.cos(a1) * TUBE_R, Math.sin(a1) * TUBE_R];
        const c = i % 2 ? gray : gray2;
        push(tris, [p0[0], p0[1], 0], c);
        push(tris, [p1[0], p1[1], 0], c);
        push(tris, [p1[0], p1[1], CUBE_Z], c);
        push(tris, [p0[0], p0[1], 0], c);
        push(tris, [p1[0], p1[1], CUBE_Z], c);
        push(tris, [p0[0], p0[1], CUBE_Z], c);
      }
      const roseZ = 0.012;
      const rose = [0.78, 0.8, 0.74];
      const north = [0.95, 0.93, 0.82];
      const roseR = 0.45;
      for (let i = 0; i < 40; i++) {
        const a0 = (i / 40) * Math.PI * 2;
        const a1 = ((i + 1) / 40) * Math.PI * 2;
        push(lines, [Math.cos(a0) * roseR, Math.sin(a0) * roseR, roseZ], rose);
        push(lines, [Math.cos(a1) * roseR, Math.sin(a1) * roseR, roseZ], rose);
      }
      const arms = [
        { d: [1, 0], len: 0.78, c: north },
        { d: [0, 1], len: 0.4, c: rose },
        { d: [-1, 0], len: 0.4, c: rose },
        { d: [0, -1], len: 0.4, c: rose },
      ];
      for (const arm of arms) {
        push(lines, [0, 0, roseZ], arm.c);
        push(lines, [arm.d[0] * arm.len, arm.d[1] * arm.len, roseZ], arm.c);
      }
      push(lines, [0.86, 0, roseZ], north);
      push(lines, [0.7, 0.09, roseZ], north);
      push(lines, [0.86, 0, roseZ], north);
      push(lines, [0.7, -0.09, roseZ], north);
      const x0 = 0.92;
      const x1 = 1.04;
      push(lines, [x0, -0.06, roseZ], north);
      push(lines, [x1, -0.06, roseZ], north);
      push(lines, [x0, 0.06, roseZ], north);
      push(lines, [x1, 0.06, roseZ], north);
      push(lines, [x0, -0.06, roseZ], north);
      push(lines, [x1, 0.06, roseZ], north);
      const planCol = [0.45, 0.5, 0.42];
      for (let i = 1; i < PLAN.length; i++) {
        push(lines, PLAN[i - 1], planCol);
        push(lines, PLAN[i], planCol);
      }
      const trail = state.trail || [];
      for (let i = 1; i < trail.length; i++) {
        const u = i / trail.length;
        const c = [0.75 + 0.2 * u, 0.9, 0.78];
        push(lines, trail[i - 1], c);
        push(lines, trail[i], c);
      }

      const pts = [];
      MIC_DIR.forEach((d, i) => {
        const p = add3(center, scale3(d, FACE_R));
        const hot = (state.levels && state.levels[i]) || 0;
        const col = i === 0 ? [1, 0.95, 0.85] : [0.2 + hot, 0.75, 0.35];
        push(pts, p, col);
      });

      if (state.drone) {
        const o = state.drone;
        const r = 0.07;
        const axes = [[r, 0, 0], [0, r, 0], [0, 0, r]];
        const sgn = [-1, 1];
        for (const ax of axes) {
          for (const s of sgn) {
            const tip = add3(o, scale3(ax, s));
            const b = ax[0] !== 0 ? [0, r * 0.55, 0] : [r * 0.55, 0, 0];
            const c = ax[2] !== 0 ? [0, r * 0.55, 0] : [0, 0, r * 0.55];
            const quad = [add3(o, b), add3(o, c), add3(o, scale3(b, -1)), add3(o, scale3(c, -1))];
            for (let k = 0; k < 4; k++) {
              push(tris, tip, [0.93, 0.96, 0.9]);
              push(tris, quad[k], [0.75, 0.82, 0.72]);
              push(tris, quad[(k + 1) % 4], [0.55, 0.7, 0.55]);
            }
          }
        }
      }

      function draw(arr, mode) {
        if (!arr.length) return;
        const data = new Float32Array(arr);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locPos);
        gl.enableVertexAttribArray(locCol);
        gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(mode, 0, arr.length / 6);
      }
      draw(lines, gl.LINES);
      draw(tris, gl.TRIANGLES);
      draw(pts, gl.POINTS);
    }

    return {
      frame,
      setGrid(on) { grid = !!on; },
      grid: () => grid,
      reset() {
        cam.yaw = CAM0.yaw;
        cam.pitch = CAM0.pitch;
        cam.dist = CAM0.dist;
      },
      place,
    };
  }

  window.Het68Cube = { attach, place };
})();
