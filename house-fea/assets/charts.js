/* ============================================================
 * 结果图表：基底竖向压应力分布 + 关键应力强度对比（ECharts · SVG）
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
    var el1 = document.getElementById('chart-base');
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

  /* ---- 图 1：基底竖向压应力分布（拱效应可视化） ---- */
  function updateLine(res, MODEL) {
    if (!chartLine) return;
    var mesh = res.mesh, n = mesh.n;
    var base = [];
    for (var i = 0; i < n; i++) {
      if (mesh.nodes[i][1] < 1e-6) base.push([mesh.nodes[i][0], -res.sy[i]]);
    }
    base.sort(function (a, b) { return a[0] - b[0]; });
    var door = res.openings[0];
    var W = MODEL.W;

    chartLine.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        valueFormatter: function (v) { return (+v).toFixed(3) + ' MPa'; }
      },
      grid: { left: 64, right: 24, top: 34, bottom: 46 },
      xAxis: {
        type: 'value', name: 'x (mm)', nameTextStyle: { color: muted },
        min: 0, max: W, axisLabel: { color: muted },
        splitLine: { lineStyle: { color: rule } }, axisLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: 'value', name: '基底压应力 (MPa)', nameTextStyle: { color: muted },
        axisLabel: { color: muted, formatter: function (v) { return v.toFixed(2); } },
        splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: 'FEA 基底压应力', type: 'line', data: base, symbol: 'none',
          lineStyle: { color: accent, width: 2 }, smooth: false
        },
        {
          name: '净截面名义压应力', type: 'line', markLine: {
            symbol: 'none', silent: true, label: { color: muted, formatter: '净截面名义 {c} MPa' },
            lineStyle: { color: muted, type: 'dashed' },
            data: [{ yAxis: res.sigmaNom }]
          },
          data: []
        },
        {
          name: '门洞范围', type: 'line', data: [],
          markArea: {
            silent: true, itemStyle: { color: 'rgba(216,67,21,0.08)' },
            label: { color: accent2, fontSize: 11, position: 'insideTop' },
            data: [[{ name: '门洞（无墙体）', xAxis: door.x0 }, { xAxis: door.x1 }]]
          }
        }
      ]
    });
  }

  /* ---- 图 2：关键应力 vs 砌体强度对比 ---- */
  function updateBar(res, MODEL) {
    if (!chartBar) return;
    chartBar.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis', appendToBody: true,
        axisPointer: { type: 'shadow' },
        valueFormatter: function (v) { return (+v).toFixed(3) + ' MPa'; }
      },
      grid: { left: 64, right: 24, top: 30, bottom: 46 },
      xAxis: {
        type: 'category',
        data: ['洞口角部主拉峰值 (FEA)', '砌体抗拉强度 f_t', '基底最大压应力 (FEA)', '砌体抗压强度 f_c'],
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
          { value: +res.s1Max.toFixed(3), itemStyle: { color: accent } },
          { value: MODEL.ft, itemStyle: { color: '#b03014' } },
          { value: +res.scMax.toFixed(3), itemStyle: { color: '#7fa6c9' } },
          { value: MODEL.fc, itemStyle: { color: accent2 } }
        ],
        label: { show: true, position: 'top', color: ink, formatter: function (p) { return p.value + ' MPa'; } }
      }]
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.FEACharts = { updateAll: updateAll };
})();
