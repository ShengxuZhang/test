/* ============================================================
 * 梁上开孔有限元分析 —— FEA 求解内核 + Three.js 三维后处理
 * 平面应力 CST 常应变三角形单元 · CSR 稀疏矩阵 · 共轭梯度法
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 全局参数 ---------------- */
  var MODEL = { L: 1000, H: 120, t: 20, E: 206000, nu: 0.3, sigmaY: 235 };
  var state = {
    holeD: 30, holeX: 400, support: 'ss', loadKN: 5, density: 'normal',
    view: 'mises', showMesh: true, deformPct: 100
  };
  var DENSITY = { coarse: 12, normal: 9, fine: 7 };

  var lastResult = null;   // 最近一次求解结果
  var solveTimer = null;
  var glOK = false;        // WebGL 可用性

  function $(id) { return document.getElementById(id); }

  /* ============================================================
   * 1. 网格生成：矩形域 - 圆孔，Delaunay 三角化 + 孔边加密
   * ============================================================ */
  function hash2(i, j) {
    var h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return h - Math.floor(h);
  }

  function buildMesh(cfg) {
    var L = MODEL.L, H = MODEL.H;
    var s = cfg.s, r = cfg.holeD / 2, cx = cfg.holeX, cy = H / 2;
    var pts = [];

    /* --- 外边界（沿周长布点） --- */
    var nL = Math.max(6, Math.round(L / s));
    var nH = Math.max(4, Math.round(H / s));
    var i, j, k;
    for (i = 0; i < nL; i++) pts.push([L * i / nL, 0]);          // 底边 →
    for (j = 0; j < nH; j++) pts.push([L, H * j / nH]);           // 右边 ↑
    for (i = nL; i > 0; i--) pts.push([L * i / nL, H]);           // 顶边 ←
    for (j = nH; j > 0; j--) pts.push([0, H * j / nH]);           // 左边 ↓

    /* --- 孔边布点（间距约 s/2，保证圆孔顺滑） --- */
    var nC = Math.min(80, Math.max(28, Math.round(Math.PI * cfg.holeD / (0.45 * s))));
    for (k = 0; k < nC; k++) {
      var a0 = 2 * Math.PI * k / nC;
      pts.push([cx + r * Math.cos(a0), cy + r * Math.sin(a0)]);
    }

    /* --- 孔周渐变过渡环（放射加密） --- */
    var ringRs = [];
    for (var m = 1; m <= 5; m++) {
      var R = r + s * (0.85 * m + 0.3 * m * m);
      if (R >= Math.min(cx, L - cx, cy, H - cy) - 0.6 * s) break;
      ringRs.push(R);
    }
    ringRs.forEach(function (R, mi) {
      for (k = 0; k < nC; k++) {
        var a = 2 * Math.PI * (k + 0.5 * ((mi + 1) % 2)) / nC;
        pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
      }
    });
    var Rbg = ringRs.length ? ringRs[ringRs.length - 1] : r;

    /* --- 背景网格（扰动 + 避让孔区） --- */
    var bg = s * 1.35;
    var gx = Math.ceil(L / bg), gy = Math.ceil(H / bg);
    for (i = 1; i < gx; i++) {
      for (j = 1; j < gy; j++) {
        var x = i * bg + (hash2(i, j) - 0.5) * 0.3 * bg;
        var y = j * bg + (hash2(j, i) - 0.5) * 0.3 * bg;
        if (x < 0.6 * s || x > L - 0.6 * s || y < 0.6 * s || y > H - 0.6 * s) continue;
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < (Rbg + 0.9 * s) * (Rbg + 0.9 * s)) continue;
        pts.push([x, y]);
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

    /* --- Delaunay 三角化 + 过滤孔内单元 --- */
    var coords = new Float64Array(n * 2);
    for (i = 0; i < n; i++) { coords[2 * i] = nodes[i][0]; coords[2 * i + 1] = nodes[i][1]; }
    var del = new Delaunator(coords);
    var T = del.triangles;

    /* 圆孔节点索引及其圆周序号（用于剔除"跳点"劣质三角形） */
    var circleIdx = new Int32Array(n).fill(-1);
    for (k = 0; k < nC; k++) {
      var px = cx + r * Math.cos(2 * Math.PI * k / nC);
      var py = cy + r * Math.sin(2 * Math.PI * k / nC);
      var best = -1, bd = Infinity;
      for (var q2 = 0; q2 < n; q2++) {
        var ddx2 = nodes[q2][0] - px, ddy2 = nodes[q2][1] - py;
        var d2 = ddx2 * ddx2 + ddy2 * ddy2;
        if (d2 < bd) { bd = d2; best = q2; }
      }
      circleIdx[best] = k;
    }

    var tris = [];
    var r2 = r * r * 0.985;
    for (var t3 = 0; t3 < T.length; t3 += 3) {
      var a = T[t3], b = T[t3 + 1], c = T[t3 + 2];
      var ax = nodes[a][0], ay = nodes[a][1];
      var bx = nodes[b][0], by = nodes[b][1];
      var ex = nodes[c][0], ey = nodes[c][1];
      var area = 0.5 * ((bx - ax) * (ey - ay) - (ex - ax) * (by - ay));
      if (Math.abs(area) < 1e-6) continue;
      var gcx = (ax + bx + ex) / 3, gcy = (ay + by + ey) / 3;
      var gdx = gcx - cx, gdy = gcy - cy;
      if (gdx * gdx + gdy * gdy < r2) continue;                 // 质心在孔内 → 删除
      /* 孔边跳点检查：两孔节点不相邻 → 劣质跨越三角形 */
      var ca = circleIdx[a], cb = circleIdx[b], cc = circleIdx[c];
      var nCirc = 0;
      if (ca >= 0) nCirc++; if (cb >= 0) nCirc++; if (cc >= 0) nCirc++;
      if (nCirc >= 2) {
        var bad = false;
        var pairList = [];
        if (ca >= 0 && cb >= 0) pairList.push([ca, cb]);
        if (ca >= 0 && cc >= 0) pairList.push([ca, cc]);
        if (cb >= 0 && cc >= 0) pairList.push([cb, cc]);
        for (var pp = 0; pp < pairList.length; pp++) {
          var d = Math.abs(pairList[pp][0] - pairList[pp][1]);
          d = Math.min(d, nC - d);
          if (d >= 2) { bad = true; break; }
        }
        if (bad) continue;
      }
      /* 统一定向为逆时针（保证刚度矩阵正定） */
      if (area < 0) tris.push(a, c, b); else tris.push(a, b, c);
    }

    /* --- 提取边界边（用于 3D 侧壁与载荷/约束识别） --- */
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

    return { nodes: nodes, n: n, tris: tris, nTri: tris.length / 3, bndEdges: bndEdges, nC: nC };
  }

  /* ============================================================
   * 2. FEA 求解：CST 单元 + CSR 稀疏 CG
   * ============================================================ */
  function solveFEA(mesh, cfg) {
    var t0 = performance.now();
    var L = MODEL.L, H = MODEL.H, t = MODEL.t, E = MODEL.E, nu = MODEL.nu;
    var n = mesh.n, ndof = 2 * n;
    var nodes = mesh.nodes, tris = mesh.tris, s = cfg.s;

    /* --- 边界条件标记 --- */
    var bc = new Uint8Array(ndof);
    var loadX = (cfg.support === 'ss') ? L / 2 : L;
    var loadY = (cfg.support === 'ss') ? H : H / 2;

    function nodeNear(x, y, tol) {
      var best = -1, bd = Infinity;
      for (var i = 0; i < n; i++) {
        var dx = nodes[i][0] - x, dy = nodes[i][1] - y, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = i; }
      }
      return (bd <= tol * tol) ? best : -1;
    }

    var pinNode = -1;
    if (cfg.support === 'ss') {
      pinNode = nodeNear(0, 0, s);
      if (pinNode >= 0) { bc[2 * pinNode] = 1; bc[2 * pinNode + 1] = 1; }
      for (var i1 = 0; i1 < n; i1++)
        if (nodes[i1][0] > L - 1e-6 && nodes[i1][1] < 1e-6) bc[2 * i1 + 1] = 1;  // 右下滚支
    } else {
      for (var i2 = 0; i2 < n; i2++)
        if (nodes[i2][0] < 1e-6) { bc[2 * i2] = 1; bc[2 * i2 + 1] = 1; }        // 左端固支
    }

    /* --- 载荷向量（在加载点邻域内均分，避免单点奇异） --- */
    var f = new Float64Array(ndof);
    var loadedNodes = [];
    var win = Math.max(s, 4);
    for (var i3 = 0; i3 < n; i3++) {
      if (cfg.support === 'ss') {
        if (Math.abs(nodes[i3][0] - L / 2) <= win && nodes[i3][1] > H - 1e-6) loadedNodes.push(i3);
      } else {
        if (nodes[i3][0] > L - 1e-6) loadedNodes.push(i3);
      }
    }
    if (!loadedNodes.length) loadedNodes.push(nodeNear(loadX, loadY, s));
    var P = cfg.loadKN * 1000;
    loadedNodes.forEach(function (id) { f[2 * id + 1] -= P / loadedNodes.length; });

    /* --- 自由度映射（缩减） --- */
    var freeList = [], idxOf = new Int32Array(ndof).fill(-1);
    for (var d0 = 0; d0 < ndof; d0++) if (!bc[d0]) { idxOf[d0] = freeList.length; freeList.push(d0); }
    var nf = freeList.length;

    /* --- 组装 CSR（平面应力 CST） --- */
    var D0 = E / (1 - nu * nu);
    var D = [D0, D0 * nu, 0, D0 * nu, D0, 0, 0, 0, D0 * (1 - nu) / 2];
    var rows = new Array(nf); for (var r0 = 0; r0 < nf; r0++) rows[r0] = new Map();

    var B = new Float64Array(18), ue = new Float64Array(6), ke = new Float64Array(36), DB = new Float64Array(18);
    var elemStress = null;

    for (var e = 0; e < tris.length; e += 3) {
      var a1 = tris[e], b1 = tris[e + 1], c1 = tris[e + 2];
      var x1 = nodes[a1][0], y1 = nodes[a1][1];
      var x2 = nodes[b1][0], y2 = nodes[b1][1];
      var x3 = nodes[c1][0], y3 = nodes[c1][1];
      var A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
      if (Math.abs(A) < 1e-9) continue;
      /* b_i = y_j - y_m ; c_i = x_m - x_j */
      var bs = [y2 - y3, y3 - y1, y1 - y2];
      var cs = [x3 - x2, x1 - x3, x2 - x1];
      B.set([bs[0], 0, bs[1], 0, bs[2], 0,
             0, cs[0], 0, cs[1], 0, cs[2],
             cs[0], bs[0], cs[1], bs[1], cs[2], bs[2]]);
      for (var ib = 0; ib < 18; ib++) B[ib] /= (2 * A);

      /* DB = D·B */
      for (var r1 = 0; r1 < 3; r1++) for (var c2 = 0; c2 < 6; c2++) {
        var sum = 0;
        for (var k1 = 0; k1 < 3; k1++) sum += D[r1 * 3 + k1] * B[k1 * 6 + c2];
        DB[r1 * 6 + c2] = sum;
      }
      /* ke = t·A·Bᵀ·DB */
      for (var p1 = 0; p1 < 6; p1++) for (var q1 = 0; q1 < 6; q1++) {
        var s2 = 0;
        for (var k2 = 0; k2 < 3; k2++) s2 += B[k2 * 6 + p1] * DB[k2 * 6 + q1];
        ke[p1 * 6 + q1] = t * A * s2;
      }
      /* 散布到整体矩阵 */
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

    /* --- 分块异步共轭梯度 --- */
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
          if (pAp === 0) break;
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
      var vm = new Float64Array(n), uMag = new Float64Array(n);
      for (var i = 0; i < n; i++) {
        var sx = sX[i] / w[i], sy = sY[i] / w[i], ty = sT[i] / w[i];
        vm[i] = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * ty * ty);
        uMag[i] = Math.hypot(fullU[2 * i], fullU[2 * i + 1]);
      }
      return { vm: vm, uMag: uMag, sx: sX, w: w, u: fullU };
    }

    return cgChunked(function (it, mx) { setSolveProgress(it / mx); }).then(function (xf) {
      var fullU = new Float64Array(ndof);
      for (var d2 = 0; d2 < ndof; d2++) if (idxOf[d2] >= 0) fullU[d2] = xf[idxOf[d2]];
      var post = recover(fullU);

      /* --- 峰值统计（剔除载荷/支座局部奇异区） --- */
      var exclR2 = (3 * s) * (3 * s);
      function excluded(i) {
        var x = nodes[i][0], y = nodes[i][1];
        if (cfg.support === 'ss') {
          var d1x = x, d1y = y; if (d1x * d1x + d1y * d1y < exclR2) return true;
          var d2x = x - L, d2y = y; if (d2x * d2x + d2y * d2y < exclR2) return true;
        } else if (x < 4 * s) return true;
        var d3x = x - loadX, d3y = y - loadY;
        return d3x * d3x + d3y * d3y < exclR2;
      }
      var vmMax = 0, vmNode = -1, uMax = 0;
      for (var i5 = 0; i5 < n; i5++) {
        if (post.uMag[i5] > uMax) uMax = post.uMag[i5];
        if (!excluded(i5) && post.vm[i5] > vmMax) { vmMax = post.vm[i5]; vmNode = i5; }
      }

      /* --- 孔缘局部峰值（孔缘节点窗口 r+0.5s） --- */
      var holeR2 = Math.pow(cfg.holeD / 2 + 0.5 * s, 2);
      var holeVmMax = 0, holeVmNode = -1;
      for (var i6 = 0; i6 < n; i6++) {
        var ddx = nodes[i6][0] - cfg.holeX, ddy = nodes[i6][1] - H / 2;
        if (ddx * ddx + ddy * ddy < holeR2 && post.vm[i6] > holeVmMax) { holeVmMax = post.vm[i6]; holeVmNode = i6; }
      }

      /* --- 名义应力（开孔净截面弯曲正应力） --- */
      var dHole = cfg.holeD, rH = dHole / 2;
      var Mx = (cfg.support === 'ss') ? P / 2 * Math.min(cfg.holeX, L - cfg.holeX) : P * (L - cfg.holeX);
      var INet = Math.pow(H - dHole, 3) * t / 12;
      var sigmaNom = Mx * ((H - dHole) / 2) / INet;
      var IGross = H * H * H * t / 12;
      var sigmaYield = 235;
      var Kt = sigmaNom > 0 ? holeVmMax / sigmaNom : 0;
      var dTh = (cfg.support === 'ss') ? P * L * L * L / (48 * E * IGross) : P * L * L * L / (3 * E * IGross);

      return {
        mesh: mesh, vm: post.vm, uMag: post.uMag, sx: post.sx, u: post.u,
        vmMax: vmMax, vmNode: vmNode, holeVmMax: holeVmMax, holeVmNode: holeVmNode,
        uMax: uMax, Kt: Kt,
        sigmaNom: sigmaNom, sigmaTh: dTh, Mx: Mx,
        excluded: excluded, loadX: loadX, loadY: loadY, loadNodes: loadedNodes,
        nNodes: n, nElems: mesh.nTri, solveMs: performance.now() - t0,
        cfg: { holeD: cfg.holeD, holeX: cfg.holeX, support: cfg.support, loadKN: cfg.loadKN, s: cfg.s }
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
   * 4. Three.js 三维后处理
   * ============================================================ */
  var renderer, scene, camera, beamGroup, refGroup;
  var surfMesh, wireMesh, surfGeo, wireGeo, surfMatColor, surfMatGray;
  var posArr, colArr, nVert, orbit = { theta: -0.9, phi: 1.12, r: 1500, tx: MODEL.L / 2, ty: MODEL.H / 2, tz: 0 };
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
    camera = new THREE.PerspectiveCamera(40, wrap.clientWidth / wrap.clientHeight, 1, 20000);
    orbit0 = JSON.parse(JSON.stringify(orbit));
    updateCamera();

    scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x161a22, 0.95));
    var dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(500, 900, 700); scene.add(dl);
    var dl2 = new THREE.DirectionalLight(0x7fa8ff, 0.22); dl2.position.set(-700, 300, -500); scene.add(dl2);

    var grid = new THREE.GridHelper(2200, 44, 0x2a3444, 0x1c2430);
    grid.position.set(MODEL.L / 2, -90, 0);
    grid.material.transparent = true; grid.material.opacity = 0.5;
    scene.add(grid);

    beamGroup = new THREE.Group(); scene.add(beamGroup);
    refGroup = new THREE.Group(); scene.add(refGroup);

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
      if (drag.btn === 2 || drag.shift) {          // 平移
        var pf = orbit.r * 0.0011;
        orbit.tx -= (Math.cos(orbit.theta) * dx) * pf;
        orbit.tz -= (Math.sin(orbit.theta) * dx) * pf;
        orbit.ty += dy * pf;
        orbit.ty = Math.max(-100, Math.min(600, orbit.ty));
      } else {                                     // 旋转
        orbit.theta -= dx * 0.005;
        orbit.phi = Math.max(0.08, Math.min(1.52, orbit.phi + dy * 0.005));
      }
      updateCamera();
    });
    el.addEventListener('pointerup', function () { drag = null; });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      orbit.r = Math.max(220, Math.min(6500, orbit.r * Math.exp(e.deltaY * 0.0012)));
      updateCamera();
    }, { passive: false });
    el.addEventListener('dblclick', resetView);
  }
  function resetView() { orbit = JSON.parse(JSON.stringify(orbit0)); updateCamera(); }

  /* --- 由 2D 结果构建 3D 实体（顶面 + 底面 + 侧壁） --- */
  function build3DGeometry(res) {
    if (!glOK) return;                       // 无 WebGL 时跳过 3D，求解与图表照常
    if (surfMesh) {
      beamGroup.remove(surfMesh); beamGroup.remove(wireMesh);
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
      idx.push(a, b, c, a + n, c + n, b + n);            // 顶面 + 底面
      widx.push(a, b, b, c, c, a, a + n, c + n, c + n, b + n, b + n, a + n);
    }
    /* 侧壁（边界边 → 四边形） */
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
    beamGroup.add(surfMesh);

    wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));  // 共享位置
    wireGeo.setIndex(widx);
    wireMesh = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({
      color: 0x0d1219, transparent: true, opacity: 0.22
    }));
    wireMesh.frustumCulled = false;
    wireMesh.visible = state.showMesh;
    beamGroup.add(wireMesh);

    buildReferences(res);
    applyDeform();
    applyColors();
    updateCamera();
  }

  /* --- 支座 / 载荷箭头等参考符号 --- */
  function buildReferences(res) {
    while (refGroup.children.length) {
      var o = refGroup.children[0];
      refGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    var matRef = new THREE.MeshLambertMaterial({ color: 0x5b6675 });
    var matRed = new THREE.MeshLambertMaterial({ color: 0xd84315 });
    var t = MODEL.t;

    if (res.cfg.support === 'ss') {
      var pin = new THREE.Mesh(new THREE.ConeGeometry(13, 22, 3), matRef);
      pin.rotation.x = 0; pin.rotation.y = Math.PI / 2;
      pin.position.set(0, -13, 0);
      refGroup.add(pin);
      var roll = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, t + 18, 16), matRef);
      roll.rotation.x = Math.PI / 2;
      roll.position.set(MODEL.L, -8, 0);
      refGroup.add(roll);
    } else {
      var clamp = new THREE.Mesh(new THREE.BoxGeometry(26, MODEL.H + 34, t + 20), matRef);
      clamp.position.set(-15, MODEL.H / 2, 0);
      refGroup.add(clamp);
    }
    /* 载荷箭头（两种工况均竖直向下） */
    var arrow = new THREE.Group();
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 55, 12), matRed);
    shaft.position.y = 27.5;
    var head = new THREE.Mesh(new THREE.ConeGeometry(11, 22, 14), matRed);
    head.rotation.x = Math.PI;                    // 锥尖朝下
    head.position.y = -9;
    arrow.add(shaft); arrow.add(head);
    arrow.position.set(res.cfg.support === 'ss' ? MODEL.L / 2 : MODEL.L, MODEL.H + 14, 0);
    refGroup.add(arrow);
  }

  /* --- 变形缩放（自动放大 + 用户百分比） --- */
  function autoScale() {
    if (!lastResult) return 1;
    var m = lastResult.uMax;
    return m > 1e-9 ? Math.min(800, 0.18 * MODEL.H / m) : 1;
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
    var arr = state.view === 'mises' ? res.vm : res.uMag;
    var vmax = state.view === 'mises' ? res.vmMax : res.uMax;
    for (var i = 0; i < n; i++) {
      var c = colorAt(arr[i] / (vmax || 1));
      colArr[3 * i] = c[0] / 255; colArr[3 * i + 1] = c[1] / 255; colArr[3 * i + 2] = c[2] / 255;
      colArr[3 * (i + n)] = colArr[3 * i]; colArr[3 * (i + n) + 1] = colArr[3 * i + 1]; colArr[3 * (i + n) + 2] = colArr[3 * i + 2];
    }
    surfGeo.attributes.color.needsUpdate = true;
    updateLegend(state.view === 'mises' ? 'von Mises 应力 (MPa)' : '位移幅值 (mm)',
                 0, state.view === 'mises' ? res.vmMax : res.uMax, state.view === 'mises' ? 1 : 3);
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
    state.holeD = +$('ctl-holeD').value;
    state.holeX = +$('ctl-holeX').value;
    state.loadKN = +$('ctl-load').value;
    state.support = $('ctl-support').value;
    state.density = $('ctl-density').value;
    $('lbl-holeD').textContent = 'Φ' + state.holeD;
    $('lbl-holeX').textContent = state.holeX;
    $('lbl-load').textContent = state.loadKN.toFixed(1);
  }

  function scheduleSolve() {
    clearTimeout(solveTimer);
    $('solve-status').textContent = '参数已变更，待重算…';
    solveTimer = setTimeout(runSolve, 260);
  }

  function runSolve() {
    readControls();
    var spinner = $('spinner');
    spinner.style.display = 'flex';
    $('solve-status').textContent = '正在生成网格…';
    setTimeout(function () {
      var s = DENSITY[state.density];
      var mesh;
      try {
        mesh = buildMesh({ holeD: state.holeD, holeX: state.holeX, s: s });
      } catch (err) {
        spinner.style.display = 'none';
        $('solve-status').textContent = '网格生成失败：' + err.message;
        return;
      }
      $('solve-status').textContent = '组装刚度矩阵并求解…';
      setTimeout(function () {
        solveFEA(mesh, {
          holeD: state.holeD, holeX: state.holeX, support: state.support,
          loadKN: state.loadKN, s: s
        }).then(function (res) {
          lastResult = res;
          build3DGeometry(res);
          updateMetrics(res);
          if (window.FEACharts) window.FEACharts.updateAll(res, MODEL);
          spinner.style.display = 'none';
          $('solve-status').textContent = '完成 · ' + res.nNodes + ' 节点 / ' + res.nElems + ' 单元 · 求解 ' + Math.round(res.solveMs) + ' ms';
        }).catch(function (err) {
          spinner.style.display = 'none';
          $('solve-status').textContent = '求解失败：' + err.message;
        });
      }, 30);
    }, 30);
  }

  function updateMetrics(res) {
    $('m-vmax').textContent = res.holeVmMax.toFixed(1);
    $('m-bmax').textContent = res.vmMax.toFixed(1);
    $('m-kt').textContent = res.Kt.toFixed(2);
    $('m-disp').textContent = res.uMax.toFixed(3);
    $('m-dth').textContent = res.sigmaTh.toFixed(3);
    var sigCrit = Math.max(res.vmMax, res.holeVmMax);
    var margin = sigCrit > 0 ? MODEL.sigmaY / sigCrit : 99;
    var badge = $('m-badge');
    badge.className = 'badge ' + (margin >= 1.5 ? 'ok' : margin >= 1 ? 'warn' : 'bad');
    badge.textContent = margin >= 1.5 ? '满足强度' : margin >= 1 ? '接近屈服' : '超过屈服';
    $('m-margin').textContent = margin > 90 ? '—' : margin.toFixed(2);
    $('m-size').textContent = res.nNodes + ' / ' + res.nElems;
    $('m-sig-nom').textContent = res.sigmaNom.toFixed(1);
    $('m-scale').textContent = autoScale().toFixed(0);
  }

  function bindUI() {
    ['ctl-holeD', 'ctl-holeX', 'ctl-load'].forEach(function (id) {
      $(id).addEventListener('input', scheduleSolve);
    });
    $('ctl-support').addEventListener('change', scheduleSolve);
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
    if (!init3D()) {
      // 无 WebGL：跳过三维渲染，但有限元求解、指标与图表仍照常工作
      $('solve-status').textContent = '提示：当前浏览器不支持 WebGL，3D 视图不可用，其余功能正常。';
    }
    $('legend-bar').style.background = 'linear-gradient(90deg,' + cmapCSS() + ')';
    runSolve();
  });
})();
