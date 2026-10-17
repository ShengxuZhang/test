/* ============================================================
 * 砖混房屋墙体开洞有限元分析 —— FEA 求解内核 + Three.js 三维后处理
 * 平面应力 CST 常应变三角形单元 · CSR 稀疏矩阵 · 共轭梯度法
 * 模型：带门洞 + 双窗洞的坡屋顶房屋山墙（立面），基础全固定
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 全局参数 ---------------- */
  var MODEL = {
    W: 6000, H1: 3000, H2: 1500,       // 墙长 / 檐口高 / 坡屋脊高 (mm)
    t: 240,                             // 墙厚 (mm)
    E: 2400, nu: 0.15,                  // 砖砌体 MU10·M5：E=1600f≈2.4 GPa
    ft: 0.11, fc: 1.5                   // 抗拉(沿齿缝) / 抗压强度设计值 (MPa)
  };
  var state = {
    doorW: 900, winW: 1200, loadcase: 'comb', roofQ: 20, windF: 30,
    density: 'normal', view: 's1', showMesh: true, deformPct: 100
  };
  var DENSITY = { coarse: 340, normal: 240, fine: 170 };

  var lastResult = null;
  var solveTimer = null;
  var glOK = false;

  function $(id) { return document.getElementById(id); }

  /* 房屋外轮廓（凸多边形，CCW） */
  var POLY = [
    [0, 0], [MODEL.W, 0], [MODEL.W, MODEL.H1],
    [MODEL.W / 2, MODEL.H1 + MODEL.H2], [0, MODEL.H1]
  ];

  function getOpenings(cfg) {
    return [
      { x0: 700, x1: 700 + cfg.doorW, y0: 0, y1: 2100, type: 'door' },
      { x0: 3400 - cfg.winW / 2, x1: 3400 + cfg.winW / 2, y0: 900, y1: 2100, type: 'win' },
      { x0: 5000 - cfg.winW / 2, x1: 5000 + cfg.winW / 2, y0: 900, y1: 2100, type: 'win' }
    ];
  }

  /* 点到凸多边形的有向距离（>margin 为严格内部） */
  function inPoly(x, y, margin) {
    for (var i = 0; i < POLY.length; i++) {
      var a = POLY[i], b = POLY[(i + 1) % POLY.length];
      var ex = b[0] - a[0], ey = b[1] - a[1];
      var cr = ex * (y - a[1]) - ey * (x - a[0]);
      if (cr / Math.hypot(ex, ey) < margin) return false;
    }
    return true;
  }
  function rectDist(px, py, o) {
    var dx = Math.max(o.x0 - px, 0, px - o.x1);
    var dy = Math.max(o.y0 - py, 0, py - o.y1);
    return Math.sqrt(dx * dx + dy * dy);
  }
  /* 线段与（收缩后的）矩形是否相交 — Liang-Barsky */
  function segHitsRect(x1, y1, x2, y2, o) {
    var t0 = 0, t1 = 1, dx = x2 - x1, dy = y2 - y1;
    var p = [-dx, dx, -dy, dy];
    var q = [x1 - o.x0, o.x1 - x1, y1 - o.y0, o.y1 - y1];
    for (var i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return false; }
      else {
        var r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
    }
    return true;
  }

  function hash2(i, j) {
    var h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return h - Math.floor(h);
  }

  /* ============================================================
   * 1. 网格生成：房屋轮廓域 − 门/窗矩形洞，Delaunay + 洞边加密
   * ============================================================ */
  function buildMesh(cfg) {
    var s = cfg.s, ops = getOpenings(cfg), eps = 0.5;
    var pts = [];
    var i, j, k;

    /* --- 外边界（5 条边，不含终点） --- */
    for (var e5 = 0; e5 < 5; e5++) {
      var A = POLY[e5], B = POLY[(e5 + 1) % 5];
      var len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      var nseg = Math.max(2, Math.round(len / s));
      for (i = 0; i < nseg; i++) {
        var tt = i / nseg;
        pts.push([A[0] + (B[0] - A[0]) * tt, A[1] + (B[1] - A[1]) * tt]);
      }
    }

    /* --- 洞口周边（角点必布） + 4 层渐变过渡环 --- */
    ops.forEach(function (o) {
      var cor = [[o.x0, o.y0], [o.x1, o.y0], [o.x1, o.y1], [o.x0, o.y1]];
      var hs = 0.55 * s;
      for (var ci = 0; ci < 4; ci++) {
        var P = cor[ci], Q = cor[(ci + 1) % 4];
        var l2 = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
        var n2 = Math.max(2, Math.round(l2 / hs));
        for (j = 0; j < n2; j++) {
          var t2 = j / n2;
          pts.push([P[0] + (Q[0] - P[0]) * t2, P[1] + (Q[1] - P[1]) * t2]);
        }
      }
      for (var m = 1; m <= 4; m++) {
        var d = s * 0.7 * m;
        var ro = { x0: o.x0 - d, x1: o.x1 + d, y0: o.y0 - d, y1: o.y1 + d };
        var rc = [[ro.x0, ro.y0], [ro.x1, ro.y0], [ro.x1, ro.y1], [ro.x0, ro.y1]];
        var hr = 1.1 * s;
        for (var c2 = 0; c2 < 4; c2++) {
          var P2 = rc[c2], Q2 = rc[(c2 + 1) % 4];
          var l3 = Math.hypot(Q2[0] - P2[0], Q2[1] - P2[1]);
          var n3 = Math.max(2, Math.round(l3 / hr));
          for (k = 0; k < n3; k++) {
            var t3 = k / n3;
            var x3 = P2[0] + (Q2[0] - P2[0]) * t3, y3 = P2[1] + (Q2[1] - P2[1]) * t3;
            if (!inPoly(x3, y3, 0.3 * s)) continue;
            var clash = false;
            for (var oi = 0; oi < ops.length; oi++)
              if (rectDist(x3, y3, ops[oi]) < 0.45 * s) { clash = true; break; }
            if (!clash) pts.push([x3, y3]);
          }
        }
      }
    });

    /* --- 背景网格（扰动 + 避让洞口） --- */
    var bg = 1.3 * s;
    var gx = Math.ceil(MODEL.W / bg), gy = Math.ceil((MODEL.H1 + MODEL.H2) / bg);
    for (i = 1; i < gx; i++) {
      for (j = 1; j < gy; j++) {
        var x = i * bg + (hash2(i, j) - 0.5) * 0.3 * bg;
        var y = j * bg + (hash2(j, i) - 0.5) * 0.3 * bg;
        if (!inPoly(x, y, 0.55 * s)) continue;
        var near = false;
        for (k = 0; k < ops.length; k++)
          if (rectDist(x, y, ops[k]) < 1.0 * s) { near = true; break; }
        if (!near) pts.push([x, y]);
      }
    }

    /* --- 去重（空间哈希网格） --- */
    var cell = 0.5 * s, minD2 = (0.4 * s) * (0.4 * s);
    var cellMap = new Map(), nodes = [];
    function addPt(x, y) {
      var ix = Math.floor(x / cell), iy = Math.floor(y / cell);
      for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
        var arr = cellMap.get((ix + di) + '_' + (iy + dj));
        if (arr) for (var q = 0; q < arr.length; q++) {
          var ddx = nodes[arr[q]][0] - x, ddy = nodes[arr[q]][1] - y;
          if (ddx * ddx + ddy * ddy < minD2) return -1;
        }
      }
      var id = nodes.length; nodes.push([x, y]);
      var key = ix + '_' + iy;
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key).push(id);
      return id;
    }
    for (i = 0; i < pts.length; i++) addPt(pts[i][0], pts[i][1]);
    var n = nodes.length;

    /* --- Delaunay 三角化 + 过滤洞内/跨越单元 --- */
    var coords = new Float64Array(n * 2);
    for (i = 0; i < n; i++) { coords[2 * i] = nodes[i][0]; coords[2 * i + 1] = nodes[i][1]; }
    var T = new Delaunator(coords).triangles;
    var opsS = ops.map(function (o) {
      return { x0: o.x0 + eps, x1: o.x1 - eps, y0: o.y0 + eps, y1: o.y1 - eps };
    });

    var tris = [];
    for (var t4 = 0; t4 < T.length; t4 += 3) {
      var a = T[t4], b = T[t4 + 1], c = T[t4 + 2];
      var ax = nodes[a][0], ay = nodes[a][1];
      var bx = nodes[b][0], by = nodes[b][1];
      var ex = nodes[c][0], ey = nodes[c][1];
      var area = 0.5 * ((bx - ax) * (ey - ay) - (ex - ax) * (by - ay));
      if (Math.abs(area) < 1e-6) continue;
      var gcx = (ax + bx + ex) / 3, gcy = (ay + by + ey) / 3;
      var drop = false;
      for (k = 0; k < opsS.length; k++) {
        var so = opsS[k];
        if (gcx > so.x0 && gcx < so.x1 && gcy > so.y0 && gcy < so.y1) { drop = true; break; }
        if (segHitsRect(ax, ay, bx, by, so) ||
            segHitsRect(bx, by, ex, ey, so) ||
            segHitsRect(ex, ey, ax, ay, so)) { drop = true; break; }
      }
      if (drop) continue;
      /* 统一定向为逆时针（保证刚度矩阵正定） */
      if (area < 0) tris.push(a, c, b); else tris.push(a, b, c);
    }

    /* --- 提取边界边（用于 3D 侧壁） --- */
    var edgeCount = new Map();
    for (i = 0; i < tris.length; i += 3) {
      var v = [tris[i], tris[i + 1], tris[i + 2]];
      for (k = 0; k < 3; k++) {
        var u1 = v[k], u2 = v[(k + 1) % 3];
        var key = u1 < u2 ? u1 * 100000 + u2 : u2 * 100000 + u1;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    var bndEdges = [];
    edgeCount.forEach(function (cnt, key) {
      if (cnt === 1) bndEdges.push(Math.floor(key / 100000), key % 100000);
    });

    return { nodes: nodes, n: n, tris: tris, nTri: tris.length / 3, bndEdges: bndEdges };
  }

  /* ============================================================
   * 2. FEA 求解：CST 单元 + CSR 稀疏 CG
   * ============================================================ */
  function solveFEA(mesh, cfg) {
    var t0 = performance.now();
    var W = MODEL.W, H1 = MODEL.H1, t = MODEL.t, E = MODEL.E, nu = MODEL.nu;
    var n = mesh.n, ndof = 2 * n;
    var nodes = mesh.nodes, tris = mesh.tris, s = cfg.s;

    /* --- 边界条件：基础顶面（y=0）全固定 --- */
    var bc = new Uint8Array(ndof);
    for (var i0 = 0; i0 < n; i0++)
      if (nodes[i0][1] < 1e-6) { bc[2 * i0] = 1; bc[2 * i0 + 1] = 1; }

    /* --- 载荷向量 --- */
    var f = new Float64Array(ndof);
    var Ntot = 0, Htot = 0;

    function nodesOnSeg(x1, y1, x2, y2, tol) {
      var out = [], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      for (var i = 0; i < n; i++) {
        var tt = ((nodes[i][0] - x1) * dx + (nodes[i][1] - y1) * dy) / (L * L);
        if (tt < -1e-6 || tt > 1 + 1e-6) continue;
        var px = x1 + tt * dx, py = y1 + tt * dy;
        var d = Math.hypot(nodes[i][0] - px, nodes[i][1] - py);
        if (d <= tol) out.push({ i: i, t: tt });
      }
      out.sort(function (a, b) { return a.t - b.t; });
      /* 影响长度（参数 t 域上的中点权重，Σw = L） */
      for (var q2 = 0; q2 < out.length; q2++) {
        var tl = q2 > 0 ? out[q2 - 1].t : Math.max(0, out[0].t - (out[1] ? out[1].t - out[0].t : 1));
        var tr = q2 < out.length - 1 ? out[q2 + 1].t : Math.min(1, out[q2].t + (out[q2].t - tl));
        out[q2].w = Math.max(0, (tr - tl) / 2) * L;
      }
      return out;
    }

    /* 屋面荷载：沿两坡均布线荷载（竖直向下） */
    if (cfg.loadcase !== 'h') {
      var qn = cfg.roofQ;                          // kN/m → N/mm（数值相等）
      var slopes = [
        nodesOnSeg(W, H1, W / 2, H1 + MODEL.H2, 0.35 * s),
        nodesOnSeg(W / 2, H1 + MODEL.H2, 0, H1, 0.35 * s)
      ];
      slopes.forEach(function (list) {
        list.forEach(function (nd) {
          var F = qn * nd.w;
          f[2 * nd.i + 1] -= F;
          Ntot += F;
        });
      });
    }
    /* 风荷载：沿左墙边水平均布（推向 +x） */
    if (cfg.loadcase !== 'v') {
      var ql = cfg.windF * 1000 / H1;              // kN → N 均布到檐口高度
      var left = nodesOnSeg(0, 0, 0, H1, 0.35 * s);
      left.forEach(function (nd) {
        var F = ql * nd.w;
        f[2 * nd.i] += F;
        Htot += F;
      });
    }

    /* --- 自由度映射（缩减） --- */
    var freeList = [], idxOf = new Int32Array(ndof).fill(-1);
    for (var d0 = 0; d0 < ndof; d0++) if (!bc[d0]) { idxOf[d0] = freeList.length; freeList.push(d0); }
    var nf = freeList.length;

    /* --- 组装 CSR（平面应力 CST） --- */
    var D0 = E / (1 - nu * nu);
    var D = [D0, D0 * nu, 0, D0 * nu, D0, 0, 0, 0, D0 * (1 - nu) / 2];
    var rows = new Array(nf); for (var r0 = 0; r0 < nf; r0++) rows[r0] = new Map();

    var B = new Float64Array(18), ue = new Float64Array(6), ke = new Float64Array(36), DB = new Float64Array(18);

    for (var e = 0; e < tris.length; e += 3) {
      var a1 = tris[e], b1 = tris[e + 1], c1 = tris[e + 2];
      var x1 = nodes[a1][0], y1 = nodes[a1][1];
      var x2 = nodes[b1][0], y2 = nodes[b1][1];
      var x3 = nodes[c1][0], y3 = nodes[c1][1];
      var A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
      if (Math.abs(A) < 1e-9) continue;
      var bs = [y2 - y3, y3 - y1, y1 - y2];
      var cs = [x3 - x2, x1 - x3, x2 - x1];
      B.set([bs[0], 0, bs[1], 0, bs[2], 0,
             0, cs[0], 0, cs[1], 0, cs[2],
             cs[0], bs[0], cs[1], bs[1], cs[2], bs[2]]);
      for (var ib = 0; ib < 18; ib++) B[ib] /= (2 * A);
      for (var r1 = 0; r1 < 3; r1++) for (var c2 = 0; c2 < 6; c2++) {
        var sum = 0;
        for (var k1 = 0; k1 < 3; k1++) sum += D[r1 * 3 + k1] * B[k1 * 6 + c2];
        DB[r1 * 6 + c2] = sum;
      }
      for (var p1 = 0; p1 < 6; p1++) for (var q1 = 0; q1 < 6; q1++) {
        var s2 = 0;
        for (var k2 = 0; k2 < 3; k2++) s2 += B[k2 * 6 + p1] * DB[k2 * 6 + q1];
        ke[p1 * 6 + q1] = t * A * s2;
      }
      var conn = [2 * a1, 2 * a1 + 1, 2 * b1, 2 * b1 + 1, 2 * c1, 2 * c1 + 1];
      for (var p2 = 0; p2 < 6; p2++) {
        var R = idxOf[conn[p2]];
        if (R < 0) continue;
        var row = rows[R];
        for (var q2b = 0; q2b < 6; q2b++) {
          var C = idxOf[conn[q2b]];
          if (C < 0) continue;
          row.set(C, (row.get(C) || 0) + ke[p2 * 6 + q2b]);
        }
      }
    }

    /* Map → CSR */
    var nnz = 0; for (var r2b = 0; r2b < nf; r2b++) nnz += rows[r2b].size;
    var rowPtr = new Int32Array(nf + 1), cols = new Int32Array(nnz), vals = new Float64Array(nnz);
    var ptr = 0;
    for (var r3 = 0; r3 < nf; r3++) {
      rowPtr[r3] = ptr;
      rows[r3].forEach(function (v2, c3) { cols[ptr] = c3; vals[ptr] = v2; ptr++; });
    }
    rowPtr[nf] = ptr;

    /* Jacobi 预条件 */
    var diagInv = new Float64Array(nf);
    for (var r4 = 0; r4 < nf; r4++) {
      var dv = 0;
      for (var p3 = rowPtr[r4]; p3 < rowPtr[r4 + 1]; p3++) if (cols[p3] === r4) dv = vals[p3];
      diagInv[r4] = dv !== 0 ? 1 / dv : 1;
    }
    var bf = new Float64Array(nf);
    for (var d1 = 0; d1 < ndof; d1++) if (idxOf[d1] >= 0) bf[idxOf[d1]] = f[d1];

    function matvec(x, y) {
      for (var i = 0; i < nf; i++) {
        var sm = 0;
        for (var p = rowPtr[i]; p < rowPtr[i + 1]; p++) sm += vals[p] * x[cols[p]];
        y[i] = sm;
      }
    }

    /* --- 分块异步预条件共轭梯度 --- */
    function cgChunked(onIter) {
      var x = new Float64Array(nf), r = new Float64Array(nf), z = new Float64Array(nf), Ap = new Float64Array(nf);
      var pk = new Float64Array(nf);
      var bnorm = 0; for (var i = 0; i < nf; i++) bnorm += bf[i] * bf[i];
      bnorm = Math.sqrt(bnorm) || 1;
      matvec(x, Ap);
      var rz = 0;
      for (var i = 0; i < nf; i++) { r[i] = bf[i] - Ap[i]; z[i] = diagInv[i] * r[i]; rz += r[i] * z[i]; }
      for (var i = 0; i < nf; i++) pk[i] = z[i];
      var maxIter = 12000, iter = 0;
      function stepChunk() {
        var end = Math.min(iter + 120, maxIter);
        for (; iter < end; iter++) {
          matvec(pk, Ap);
          var pAp = 0; for (var i = 0; i < nf; i++) pAp += pk[i] * Ap[i];
          if (pAp === 0) return null;
          var alpha = rz / pAp;
          for (var i = 0; i < nf; i++) x[i] += alpha * pk[i];
          for (var i = 0; i < nf; i++) r[i] -= alpha * Ap[i];
          var rzn = 0; for (var i = 0; i < nf; i++) rzn += r[i] * diagInv[i] * r[i];
          var rnorm = 0; for (var i = 0; i < nf; i++) rnorm += r[i] * r[i];
          if (Math.sqrt(rnorm) / bnorm < 1e-9) { iter++; return null; }
          var beta = rzn / rz;
          for (var i = 0; i < nf; i++) pk[i] = diagInv[i] * r[i] + beta * pk[i];
          rz = rzn;
        }
        if (iter >= maxIter) return null;
        onIter(iter, maxIter);
        return new Promise(function (res) { setTimeout(function () { res(true); }, 0); });
      }
      function loop() {
        return Promise.resolve(stepChunk()).then(function (again) { return again ? loop() : x; });
      }
      return loop();
    }

    /* --- 应力恢复（逐单元 → 节点面积加权平均） --- */
    function recover(fullU) {
      var sX = new Float64Array(n), sY = new Float64Array(n), sT = new Float64Array(n), w = new Float64Array(n);
      var eps = new Float64Array(3), sig = new Float64Array(3);
      for (var e = 0; e < tris.length; e += 3) {
        var a1 = tris[e], b1 = tris[e + 1], c1 = tris[e + 2];
        var x1 = nodes[a1][0], y1 = nodes[a1][1];
        var x2 = nodes[b1][0], y2 = nodes[b1][1];
        var x3 = nodes[c1][0], y3 = nodes[c1][1];
        var A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
        if (Math.abs(A) < 1e-9) continue;
        var bs = [y2 - y3, y3 - y1, y1 - y2];
        var cs = [x3 - x2, x1 - x3, x2 - x1];
        B.set([bs[0], 0, bs[1], 0, bs[2], 0,
               0, cs[0], 0, cs[1], 0, cs[2],
               cs[0], bs[0], cs[1], bs[1], cs[2], bs[2]]);
        for (var ib = 0; ib < 18; ib++) B[ib] /= (2 * A);
        ue[0] = fullU[2 * a1]; ue[1] = fullU[2 * a1 + 1];
        ue[2] = fullU[2 * b1]; ue[3] = fullU[2 * b1 + 1];
        ue[4] = fullU[2 * c1]; ue[5] = fullU[2 * c1 + 1];
        for (var r5 = 0; r5 < 3; r5++) {
          var sm = 0;
          for (var c4 = 0; c4 < 6; c4++) sm += B[r5 * 6 + c4] * ue[c4];
          eps[r5] = sm;
        }
        for (var r6 = 0; r6 < 3; r6++) {
          var sm2 = 0;
          for (var k3 = 0; k3 < 3; k3++) sm2 += D[r6 * 3 + k3] * eps[k3];
          sig[r6] = sm2;
        }
        sX[a1] += sig[0] * A; sY[a1] += sig[1] * A; sT[a1] += sig[2] * A; w[a1] += A;
        sX[b1] += sig[0] * A; sY[b1] += sig[1] * A; sT[b1] += sig[2] * A; w[b1] += A;
        sX[c1] += sig[0] * A; sY[c1] += sig[1] * A; sT[c1] += sig[2] * A; w[c1] += A;
      }
      var vm = new Float64Array(n), s1 = new Float64Array(n), uMag = new Float64Array(n);
      var syMin = 0, syMaxv = 0, tauMaxv = 0;
      for (var i = 0; i < n; i++) {
        var sx = sX[i] / w[i], sy = sY[i] / w[i], ty = sT[i] / w[i];
        sX[i] = sx; sY[i] = sy; sT[i] = ty;
        vm[i] = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * ty * ty);
        s1[i] = (sx + sy) / 2 + Math.sqrt(Math.pow((sx - sy) / 2, 2) + ty * ty);
        uMag[i] = Math.hypot(fullU[2 * i], fullU[2 * i + 1]);
        if (sY[i] < syMin) syMin = sY[i];
        if (sY[i] > syMaxv) syMaxv = sY[i];
        if (Math.abs(sT[i]) > tauMaxv) tauMaxv = Math.abs(sT[i]);
      }
      return { vm: vm, s1: s1, sy: sY, tau: sT, uMag: uMag, u: fullU, syMin: syMin, syMax: syMaxv, tauMax: tauMaxv };
    }

    return cgChunked(function (it, mx) { setSolveProgress(it / mx); }).then(function (xf) {
      var fullU = new Float64Array(ndof);
      for (var d2 = 0; d2 < ndof; d2++) if (idxOf[d2] >= 0) fullU[d2] = xf[idxOf[d2]];
      var post = recover(fullU);

      /* --- 洞口角部主拉应力峰值（角点邻域 r=0.9s） --- */
      var ops = getOpenings(cfg);
      var c1 = 0.9 * s, c1sq = c1 * c1;
      var s1Max = 0, s1Node = -1, cornerTag = '';
      ops.forEach(function (o) {
        var cs = [[o.x0, o.y1, (o.type === 'door' ? '门' : '窗') + '顶角'],
                  [o.x1, o.y1, (o.type === 'door' ? '门' : '窗') + '顶角']];
        if (o.y0 > 1) {
          cs.push([o.x0, o.y0, (o.type === 'door' ? '门' : '窗') + '底角'],
                  [o.x1, o.y0, (o.type === 'door' ? '门' : '窗') + '底角']);
        }
        cs.forEach(function (cp) {
          for (var i = 0; i < n; i++) {
            var dx = nodes[i][0] - cp[0], dy = nodes[i][1] - cp[1];
            if (dx * dx + dy * dy < c1sq && post.s1[i] > s1Max) {
              s1Max = post.s1[i]; s1Node = i; cornerTag = cp[2];
            }
          }
        });
      });

      /* --- 基底最大压应力（剔除墙角/门脚应力奇异邻域） --- */
      var syMinBase = 0;
      var exclX = [0, W, ops[0].x0, ops[0].x1];
      for (var i5 = 0; i5 < n; i5++) {
        if (nodes[i5][1] > 1e-6) continue;
        var nearSing = false;
        for (var q3 = 0; q3 < exclX.length; q3++)
          if (Math.abs(nodes[i5][0] - exclX[q3]) < 2 * s) { nearSing = true; break; }
        if (!nearSing && post.sy[i5] < syMinBase) syMinBase = post.sy[i5];
      }
      var scMax = -syMinBase;

      var uMax = 0, uMaxX = 0;
      for (var i6 = 0; i6 < n; i6++) {
        if (post.uMag[i6] > uMax) uMax = post.uMag[i6];
        if (Math.abs(fullU[2 * i6]) > uMaxX) uMaxX = Math.abs(fullU[2 * i6]);
      }

      /* --- 名义压应力（基底净截面） --- */
      var sigmaNom = Ntot / ((W - cfg.doorW) * t);

      return {
        mesh: mesh, vm: post.vm, s1: post.s1, sy: post.sy, tau: post.tau,
        uMag: post.uMag, u: post.u,
        vmMax: (function () { var m = 0; for (var i = 0; i < n; i++) if (post.vm[i] > m) m = post.vm[i]; return m; })(),
        s1AllMax: (function () { var m = 0; for (var i = 0; i < n; i++) if (post.s1[i] > m) m = post.s1[i]; return m; })(),
        syMin: post.syMin, syMax: post.syMax, tauMax: post.tauMax,
        s1Max: s1Max, s1Node: s1Node, cornerTag: cornerTag,
        scMax: scMax, sigmaNom: sigmaNom,
        uMax: uMax, uMaxX: uMaxX, drift: uMaxX / H1,
        Ntot: Ntot, Htot: Htot,
        openings: ops,
        nNodes: n, nElems: mesh.nTri, solveMs: performance.now() - t0,
        cfg: { doorW: cfg.doorW, winW: cfg.winW, loadcase: cfg.loadcase, roofQ: cfg.roofQ, windF: cfg.windF, s: cfg.s }
      };
    });
  }

  /* ============================================================
   * 3. FEA 色谱（经典 CAE 风格）
   * ============================================================ */
  var CMAP = [
    [0.00, 40, 70, 200], [0.14, 0, 150, 240], [0.29, 0, 205, 210],
    [0.43, 70, 210, 120], [0.57, 185, 225, 55], [0.71, 252, 195, 40],
    [0.85, 240, 100, 30], [1.00, 190, 25, 25]
  ];
  function colorAt(t01) {
    t01 = Math.min(1, Math.max(0, t01));
    for (var i = 1; i < CMAP.length; i++) {
      if (t01 <= CMAP[i][0]) {
        var a = CMAP[i - 1], b = CMAP[i];
        var f = (t01 - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
      }
    }
    var l = CMAP[CMAP.length - 1]; return [l[1], l[2], l[3]];
  }
  function cmapCSS() {
    return CMAP.map(function (c) { return 'rgb(' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + Math.round(c[3]) + ') ' + (c[0] * 100).toFixed(0) + '%'; }).join(',');
  }

  /* ============================================================
   * 4. Three.js 三维后处理（房屋场景）
   * ============================================================ */
  var renderer, scene, camera, wallGroup, refGroup, houseGroup;
  var surfMesh, wireMesh, surfGeo, wireGeo, surfMatColor, surfMatGray;
  var posArr, colArr, nVert;
  var orbit = { theta: -0.55, phi: 1.22, r: 8600, tx: MODEL.W / 2, ty: 1900, tz: 0 };
  var orbit0 = null;

  function init3D() {
    var wrap = $('viewport');
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (err) {
      glOK = false;
      $('gl-fail').style.display = 'flex';
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    renderer.setClearColor(0x11161f, 1);
    wrap.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, wrap.clientWidth / wrap.clientHeight, 1, 40000);
    orbit0 = JSON.parse(JSON.stringify(orbit));
    updateCamera();

    scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x161a22, 0.95));
    var dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(2500, 4500, 3500); scene.add(dl);
    var dl2 = new THREE.DirectionalLight(0x7fa8ff, 0.22); dl2.position.set(-3500, 1500, -2500); scene.add(dl2);

    var grid = new THREE.GridHelper(14000, 46, 0x2a3444, 0x1c2430);
    grid.position.set(MODEL.W / 2, -370, 0);
    grid.material.transparent = true; grid.material.opacity = 0.5;
    scene.add(grid);

    wallGroup = new THREE.Group(); scene.add(wallGroup);
    refGroup = new THREE.Group(); scene.add(refGroup);
    houseGroup = new THREE.Group(); scene.add(houseGroup);
    buildHouseDressing();

    surfMatColor = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    surfMatGray = new THREE.MeshLambertMaterial({ color: 0x94a3b8, side: THREE.DoubleSide });

    bindOrbit(wrap);
    glOK = true;
    var ro = new ResizeObserver(function () {
      if (!wrap.clientWidth) return;
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
      camera.aspect = wrap.clientWidth / wrap.clientHeight;
      camera.updateProjectionMatrix();
    });
    ro.observe(wrap);
    requestAnimationFrame(function loop() { renderer.render(scene, camera); requestAnimationFrame(loop); });
    return true;
  }

  /* --- 房屋 dressing：双坡屋面 + 脊 + 基础（静态装饰） --- */
  function buildHouseDressing() {
    var roofMat = new THREE.MeshLambertMaterial({ color: 0x9c4a3a });
    var ridgeMat = new THREE.MeshLambertMaterial({ color: 0x7e3a2e });
    var fMat = new THREE.MeshLambertMaterial({ color: 0x64707f });
    var slopeLen = Math.hypot(MODEL.W / 2, MODEL.H2) + 520;   // 含挑檐
    var ang = Math.atan2(MODEL.H2, MODEL.W / 2);
    var H1 = MODEL.H1, H2 = MODEL.H2, W = MODEL.W;

    [[1, 1], [-1, -1]].forEach(function (sg) {
      var roof = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 130, MODEL.t + 560), roofMat);
      roof.rotation.z = sg[0] * ang;
      var midX = W / 2 + sg[1] * W / 4, midY = H1 + H2 / 2;
      var nx = sg[1] * Math.sin(ang), ny = Math.cos(ang);
      roof.position.set(midX + nx * 65, midY + ny * 65, 0);
      houseGroup.add(roof);
    });
    var ridge = new THREE.Mesh(new THREE.BoxGeometry(320, 100, MODEL.t + 640), ridgeMat);
    ridge.position.set(W / 2, H1 + H2 + 55, 0);
    houseGroup.add(ridge);

    var fnd = new THREE.Mesh(new THREE.BoxGeometry(W + 400, 350, MODEL.t + 640), fMat);
    fnd.position.set(W / 2, -175, 0);
    houseGroup.add(fnd);
  }

  function updateCamera() {
    var sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
    camera.position.set(
      orbit.tx + orbit.r * sp * Math.cos(orbit.theta),
      orbit.ty + orbit.r * cp,
      orbit.tz + orbit.r * sp * Math.sin(orbit.theta));
    camera.lookAt(orbit.tx, orbit.ty, orbit.tz);
  }

  function bindOrbit(wrap) {
    var el = renderer.domElement;
    el.style.touchAction = 'none';
    var drag = null;
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 2 || drag.shift) {
        var pf = orbit.r * 0.0011;
        orbit.tx -= (Math.cos(orbit.theta) * dx) * pf;
        orbit.tz -= (Math.sin(orbit.theta) * dx) * pf;
        orbit.ty += dy * pf;
        orbit.ty = Math.max(-300, Math.min(5200, orbit.ty));
      } else {
        orbit.theta -= dx * 0.005;
        orbit.phi = Math.max(0.08, Math.min(1.52, orbit.phi + dy * 0.005));
      }
      updateCamera();
    });
    el.addEventListener('pointerup', function () { drag = null; });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      orbit.r = Math.max(1500, Math.min(26000, orbit.r * Math.exp(e.deltaY * 0.0012)));
      updateCamera();
    }, { passive: false });
    el.addEventListener('dblclick', resetView);
  }
  function resetView() { orbit = JSON.parse(JSON.stringify(orbit0)); updateCamera(); }

  /* --- 由 2D 结果构建 3D 墙体（顶面 + 底面 + 侧壁） --- */
  function build3DGeometry(res) {
    if (!glOK) return;
    if (surfMesh) {
      wallGroup.remove(surfMesh); wallGroup.remove(wireMesh);
      surfGeo.dispose(); wireGeo.dispose();
      surfMesh = wireMesh = null;
    }
    var mesh = res.mesh, n = mesh.n, t = MODEL.t, h2 = t / 2;
    nVert = 2 * n;
    posArr = new Float32Array(nVert * 3);
    colArr = new Float32Array(nVert * 3);
    var i;
    for (i = 0; i < n; i++) {
      var x = mesh.nodes[i][0], y = mesh.nodes[i][1];
      posArr[3 * i] = x; posArr[3 * i + 1] = y; posArr[3 * i + 2] = h2;
      posArr[3 * (i + n)] = x; posArr[3 * (i + n) + 1] = y; posArr[3 * (i + n) + 2] = -h2;
    }
    var idx = [], widx = [];
    var T = mesh.tris;
    for (i = 0; i < T.length; i += 3) {
      var a = T[i], b = T[i + 1], c = T[i + 2];
      idx.push(a, b, c, a + n, c + n, b + n);
      widx.push(a, b, b, c, c, a, a + n, c + n, c + n, b + n, b + n, a + n);
    }
    var be = mesh.bndEdges;
    for (i = 0; i < be.length; i += 2) {
      var e1 = be[i], e2 = be[i + 1];
      idx.push(e1, e1 + n, e2 + n, e1, e2 + n, e2);
    }

    surfGeo = new THREE.BufferGeometry();
    surfGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    surfGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    surfGeo.setIndex(idx);
    surfMesh = new THREE.Mesh(surfGeo, state.view === 'orig' ? surfMatGray : surfMatColor);
    surfMesh.frustumCulled = false;
    wallGroup.add(surfMesh);

    wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    wireGeo.setIndex(widx);
    wireMesh = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({
      color: 0x0d1219, transparent: true, opacity: 0.22
    }));
    wireMesh.frustumCulled = false;
    wireMesh.visible = state.showMesh;
    wallGroup.add(wireMesh);

    buildReferences(res);
    applyDeform();
    applyColors();
    updateCamera();
  }

  /* --- 载荷箭头（按工况显示） --- */
  function buildReferences(res) {
    while (refGroup.children.length) {
      var o = refGroup.children[0];
      refGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    var matRed = new THREE.MeshLambertMaterial({ color: 0xd84315 });
    var t = MODEL.t;
    var lc = res.cfg.loadcase;
    var H1 = MODEL.H1, H2 = MODEL.H2, W = MODEL.W;

    function vArrow(x, y, scale) {
      var g = new THREE.Group();
      var shaft = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 170 * scale, 12), matRed);
      shaft.position.y = 85 * scale;
      var head = new THREE.Mesh(new THREE.ConeGeometry(34, 66, 14), matRed);
      head.rotation.x = Math.PI;
      head.position.y = -33 * scale;
      g.add(shaft); g.add(head);
      g.position.set(x, y, 0);
      refGroup.add(g);
    }
    function hArrow(y, scale) {
      var g = new THREE.Group();
      var shaft = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 170 * scale, 12), matRed);
      shaft.rotation.z = Math.PI / 2;
      shaft.position.x = -85 * scale;
      var head = new THREE.Mesh(new THREE.ConeGeometry(34, 66, 14), matRed);
      head.rotation.z = -Math.PI / 2;
      head.position.x = 33 * scale;
      g.add(shaft); g.add(head);
      g.position.set(0, y, 0);
      refGroup.add(g);
    }

    if (lc !== 'h') {           // 屋面荷载箭头：两坡各 3 个
      var sA = [[W, H1], [W / 2, H1 + H2]], sB = [[W / 2, H1 + H2], [0, H1]];
      [sA, sB].forEach(function (sg) {
        for (var k = 1; k <= 3; k++) {
          var tt = k / 4;
          vArrow(sg[0][0] + (sg[1][0] - sg[0][0]) * tt,
                 sg[0][1] + (sg[1][1] - sg[0][1]) * tt + 70, 1);
        }
      });
    }
    if (lc !== 'v') {           // 风荷载箭头：左墙边 4 个
      for (var m = 1; m <= 4; m++) hArrow(H1 * m / 5, 1);
    }
  }

  /* --- 变形缩放 --- */
  function autoScale() {
    if (!lastResult) return 1;
    var m = lastResult.uMax;
    return m > 1e-12 ? Math.min(30000, Math.max(1, 0.15 * (MODEL.H1 + MODEL.H2) / m)) : 1;
  }
  function applyDeform() {
    if (!lastResult || !surfMesh || !glOK) return;
    var sc = autoScale() * state.deformPct / 100;
    var res = lastResult, n = res.mesh.n;
    for (var i = 0; i < n; i++) {
      var dx = res.u[2 * i] * sc, dy = res.u[2 * i + 1] * sc;
      posArr[3 * i] = res.mesh.nodes[i][0] + dx;
      posArr[3 * i + 1] = res.mesh.nodes[i][1] + dy;
      posArr[3 * (i + n)] = res.mesh.nodes[i][0] + dx;
      posArr[3 * (i + n) + 1] = res.mesh.nodes[i][1] + dy;
    }
    surfGeo.attributes.position.needsUpdate = true;
    surfGeo.computeVertexNormals();
    surfGeo.computeBoundingSphere();
  }

  /* --- 顶点着色 --- */
  function applyColors() {
    if (!lastResult || !surfMesh || !glOK) return;
    var res = lastResult, n = res.mesh.n;
    surfMesh.material = state.view === 'orig' ? surfMatGray : surfMatColor;
    if (state.view === 'orig') {
      wireMesh.material.opacity = 0.12;
      updateLegend('原始模型（未着色）', 0, 1, 0);
      return;
    }
    wireMesh.material.opacity = 0.22;
    var arr, vmax, vmin = 0, title, digits = 2;
    if (state.view === 'mises') { arr = res.vm; vmax = res.vmMax; title = 'von Mises 应力 (MPa)'; }
    else if (state.view === 's1') { arr = res.s1; vmax = res.s1AllMax; title = '主拉应力 σ₁ (MPa)'; }
    else if (state.view === 'sy') { arr = res.sy; vmin = res.syMin; vmax = res.syMax; title = '竖向应力 σy (MPa，负为压)'; }
    else { arr = res.tau; vmax = res.tauMax; title = '剪应力 |τxy| (MPa)'; }
    for (var i = 0; i < n; i++) {
      var c = colorAt((arr[i] - vmin) / ((vmax - vmin) || 1));
      colArr[3 * i] = c[0] / 255; colArr[3 * i + 1] = c[1] / 255; colArr[3 * i + 2] = c[2] / 255;
      colArr[3 * (i + n)] = colArr[3 * i]; colArr[3 * (i + n) + 1] = colArr[3 * i + 1]; colArr[3 * (i + n) + 2] = colArr[3 * i + 2];
    }
    surfGeo.attributes.color.needsUpdate = true;
    updateLegend(title, vmin, vmax, digits);
  }

  function updateLegend(title, v0, v1, digits) {
    $('legend-title').textContent = title;
    $('legend-bar').style.background = 'linear-gradient(90deg,' + cmapCSS() + ')';
    $('legend-min').textContent = v0.toFixed(digits);
    $('legend-mid').textContent = (v0 + (v1 - v0) / 2).toFixed(digits);
    $('legend-max').textContent = v1.toFixed(digits);
  }

  /* ============================================================
   * 5. UI 控制与求解调度
   * ============================================================ */
  function setSolveProgress(p) {
    var el = $('solve-progress');
    if (el) el.textContent = '求解中 ' + Math.min(99, Math.round(p * 100)) + '%';
  }

  function readControls() {
    state.doorW = +$('ctl-doorW').value;
    state.winW = +$('ctl-winW').value;
    state.loadcase = $('ctl-case').value;
    state.roofQ = +$('ctl-roof').value;
    state.windF = +$('ctl-wind').value;
    state.density = $('ctl-density').value;
    return { s: DENSITY[state.density], doorW: state.doorW, winW: state.winW,
             loadcase: state.loadcase, roofQ: state.roofQ, windF: state.windF };
  }

  var solving = false, pendingSolve = false;
  function scheduleSolve() {
    updateLabels();
    if (solving) { pendingSolve = true; return; }
    solving = true;
    $('spinner').style.display = 'flex';
    $('solve-progress').textContent = '';
    var cfg = readControls();
    setTimeout(function () {
      var mesh;
      try {
        mesh = buildMesh(cfg);
      } catch (err) {
        var spinner = $('spinner');
        spinner.style.display = 'none';
        $('solve-status').textContent = '网格生成失败：' + err.message;
        solving = false;
        return;
      }
      $('solve-status').textContent = '组装刚度矩阵并求解…';
      setTimeout(function () {
        solveFEA(mesh, cfg).then(function (res) {
          lastResult = res;
          build3DGeometry(res);
          updateMetrics(res);
          if (window.FEACharts) window.FEACharts.updateAll(res, MODEL);
          $('spinner').style.display = 'none';
          $('solve-status').textContent = '完成 · ' + res.nNodes + ' 节点 / ' + res.nElems + ' 单元 · 求解 ' + Math.round(res.solveMs) + ' ms';
          solving = false;
          if (pendingSolve) { pendingSolve = false; scheduleSolve(); }
        }).catch(function (err) {
          $('spinner').style.display = 'none';
          $('solve-status').textContent = '求解失败：' + err.message;
          solving = false;
        });
      }, 30);
    }, 30);
  }

  function updateLabels() {
    $('lbl-doorW').textContent = $('ctl-doorW').value + ' mm';
    $('lbl-winW').textContent = $('ctl-winW').value + ' mm';
    $('lbl-roof').textContent = $('ctl-roof').value + ' kN/m';
    $('lbl-wind').textContent = $('ctl-wind').value + ' kN';
  }

  function updateMetrics(res) {
    $('m-s1').textContent = res.s1Max.toFixed(3);
    $('m-sc').textContent = res.scMax.toFixed(3);
    $('m-nom').textContent = res.sigmaNom.toFixed(3);
    $('m-ux').textContent = res.uMaxX >= 0.001 ? res.uMaxX.toFixed(3) : (res.uMaxX * 1000).toFixed(1) + '×10⁻³';
    $('m-drift').textContent = res.uMaxX > 1e-9 ? '1/' + Math.round(MODEL.H1 / res.uMaxX).toLocaleString() : '—';
    var mt = res.s1Max > 1e-9 ? MODEL.ft / res.s1Max : 99;
    var mc = res.scMax > 1e-9 ? MODEL.fc / res.scMax : 99;
    var margin = Math.min(mt, mc);
    var badge = $('m-badge');
    var txt, cls;
    if (res.s1Max >= MODEL.ft) { txt = '拉裂风险'; cls = 'bad'; }
    else if (res.scMax >= MODEL.fc) { txt = '受压超限'; cls = 'bad'; }
    else if (margin >= 2) { txt = '满足要求'; cls = 'ok'; }
    else { txt = '接近限值'; cls = 'warn'; }
    badge.className = 'badge ' + cls;
    badge.textContent = txt;
    $('m-margin').textContent = margin > 90 ? '—' : margin.toFixed(2);
    $('m-size').textContent = res.nNodes + ' / ' + res.nElems;
    $('m-scale').textContent = autoScale().toFixed(0);
  }

  function bindUI() {
    ['ctl-doorW', 'ctl-winW', 'ctl-roof', 'ctl-wind'].forEach(function (id) {
      $(id).addEventListener('input', scheduleSolve);
    });
    $('ctl-case').addEventListener('change', scheduleSolve);
    $('ctl-density').addEventListener('change', scheduleSolve);
    $('ctl-view').addEventListener('change', function () {
      state.view = this.value;
      applyColors();
    });
    $('ctl-mesh').addEventListener('change', function () {
      state.showMesh = this.checked;
      if (wireMesh) wireMesh.visible = state.showMesh;
    });
    $('ctl-deform').addEventListener('input', function () {
      state.deformPct = +this.value;
      $('lbl-deform').textContent = state.deformPct + '%';
      applyDeform();
    });
    $('btn-reset-view').addEventListener('click', resetView);
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    bindUI();
    updateLabels();
    if (!init3D()) {
      $('solve-status').textContent = '提示：当前浏览器不支持 WebGL，3D 视图不可用，其余功能正常。';
    }
    $('legend-bar').style.background = 'linear-gradient(90deg,' + cmapCSS() + ')';
    runFirst();
  });

  function runFirst() {
    updateLabels();
    scheduleSolve();
  }
})();
