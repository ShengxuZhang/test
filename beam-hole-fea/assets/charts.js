/* ============================================================
 * 结果图表：下缘弯曲正应力分布 + 关键应力对比（ECharts）
 * ============================================================ */
(function () {
  'use strict';

  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();

  var chartLine = null, chartBar = null;

  function init() {
    var el1 = document.getElementById('chart-sigma-x');
    var el2 = document.getElementById('chart-compare');
    if (el1 && window.echarts) {
      chartLine = echarts.init(el1, null, { renderer: 'svg' });
      window.addEventListener('resize', function () { chartLine.resize(); });
    }
    if (el2 && window.echarts) {
      chartBar = echarts.init(el2, null, { renderer: 'svg' });
      window.addEventListener('resize', function () { chartBar.resize(); });
    }
    if (window.mermaid) {
      mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
    }
  }

  function updateAll(res, MODEL) {
    updateLine(res, MODEL);
    updateBar(res, MODEL);
  }

  /* ---- 图 1：下缘弯曲正应力 σx 分布 ---- */
  function updateLine(res, MODEL) {
    if (!chartLine) return;
    var n = res.mesh.n, xs = [], fea = [];
    for (var i = 0; i < n; i++) {
      if (Math.abs(res.mesh.nodes[i][1]) < 1e-6) {
        xs.push(Math.round(res.mesh.nodes[i][0] * 10) / 10);
        fea.push([Math.round(res.mesh.nodes[i][0] * 10) / 10, res.sx[i]]);
      }
    }
    fea.sort(function (a, b) { return a[0] - b[0]; });

    var theory = [];
    var P = res.cfg.loadKN * 1000, L = MODEL.L, H = MODEL.H, t = MODEL.t;
    var IG = H * H * H * t / 12;
    for (var x = 0; x <= L; x += 20) {
      var M = (res.cfg.support === 'ss')
        ? P / 2 * Math.min(x, L - x) : P * (L - x);
      theory.push([x, M * (H / 2) / IG]);
    }
    var hx = res.cfg.holeX, hd = res.cfg.holeD;

    chartLine.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis', appendToBody: true,
        valueFormatter: function (v) { return (+v).toFixed(1) + ' MPa'; }
      },
      legend: { data: ['有限元 σx（下缘）', '材料力学理论解'], textStyle: { color: muted }, top: 0 },
      grid: { left: 64, right: 24, top: 40, bottom: 40 },
      xAxis: {
        type: 'value', name: 'x (mm)', nameTextStyle: { color: muted },
        min: 0, max: L, axisLabel: { color: muted },
        axisLine: { lineStyle: { color: rule } }, splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: 'σx (MPa)', nameTextStyle: { color: muted },
        axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: '有限元 σx（下缘）', type: 'line', data: fea, symbol: 'none',
          lineStyle: { color: accent, width: 2 }, color: accent
        },
        {
          name: '材料力学理论解', type: 'line', data: theory, symbol: 'none',
          lineStyle: { color: muted, width: 1.5, type: 'dashed' }, color: muted
        },
        {
          name: '孔位置', type: 'line', data: [], markLine: {
            silent: true, symbol: 'none',
            data: [{ xAxis: hx }],
            lineStyle: { color: accent2, type: 'dashed' },
            label: { formatter: '孔中心', color: accent2 }
          },
          markArea: {
            silent: true,
            data: [[{ xAxis: hx - hd / 2 }, { xAxis: hx + hd / 2 }]],
            itemStyle: { color: 'rgba(216,67,21,0.10)' }
          }
        }
      ]
    });
  }

  /* ---- 图 2：关键应力对比 ---- */
  function updateBar(res, MODEL) {
    if (!chartBar) return;
    chartBar.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis', appendToBody: true,
        axisPointer: { type: 'shadow' },
        valueFormatter: function (v) { return (+v).toFixed(1) + ' MPa'; }
      },
      grid: { left: 64, right: 24, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: ['开孔净截面名义应力', '孔缘 von Mises 峰值（FEA）', '梁整体最大应力（FEA）', '材料屈服强度'],
        axisLabel: { color: muted, interval: 0, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: 'value', name: 'MPa', nameTextStyle: { color: muted },
        axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } }
      },
      series: [{
        type: 'bar', barWidth: '42%',
        data: [
          { value: +res.sigmaNom.toFixed(1), itemStyle: { color: muted } },
          { value: +res.holeVmMax.toFixed(1), itemStyle: { color: accent } },
          { value: +res.vmMax.toFixed(1), itemStyle: { color: '#7fa6c9' } },
          { value: MODEL.sigmaY, itemStyle: { color: accent2 } }
        ],
        label: { show: true, position: 'top', color: ink, formatter: function (p) { return p.value + ' MPa'; } }
      }]
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.FEACharts = { updateAll: updateAll };
})();
