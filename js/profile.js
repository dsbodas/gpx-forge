/**
 * Elevation profile chart.
 *
 * Canvas rather than SVG: a 200 km route carries 20 000 profile samples and
 * SVG chokes on that many nodes. Rendering is column-based — one vertical
 * strip per device pixel, coloured by the gradient at that point — which makes
 * cost proportional to the chart width instead of the point count.
 */

import { bandFor, GRADIENT_BANDS } from './analysis.js';
import { fmtDistance, fmtElevation, clamp } from './util.js';

const PAD = { top: 16, right: 12, bottom: 26, left: 48 };

export class ElevationProfile {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stats = null;
    this.units = opts.units || 'metric';
    this.onHover = opts.onHover || (() => {});
    this.hoverDist = null;
    this.selectedClimb = null;

    this._onMove = this._onMove.bind(this);
    this._onLeave = this._onLeave.bind(this);

    canvas.addEventListener('mousemove', this._onMove);
    canvas.addEventListener('mouseleave', this._onLeave);
    canvas.addEventListener('touchmove', this._onMove, { passive: true });
    canvas.addEventListener('touchend', this._onLeave);
    canvas.addEventListener('click', (e) => {
      const hit = this._climbAt(this._distFromEvent(e));
      opts.onClimbClick?.(hit);
    });

    this._resizeObserver = new ResizeObserver(() => this.draw());
    this._resizeObserver.observe(canvas.parentElement || canvas);
  }

  setUnits(units) { this.units = units; this.draw(); }

  setData(stats) {
    this.stats = stats;
    this.draw();
  }

  /** Highlights a position from elsewhere in the UI (map hover). */
  setCursor(dist) {
    this.hoverDist = dist;
    this.draw();
  }

  highlightClimb(climb) {
    this.selectedClimb = climb;
    this.draw();
  }

  destroy() {
    this._resizeObserver.disconnect();
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('mouseleave', this._onLeave);
  }

  /* ---------------- geometry helpers ---------------- */

  _plot() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      w, h,
      x0: PAD.left,
      x1: w - PAD.right,
      y0: PAD.top,
      y1: h - PAD.bottom,
      innerW: Math.max(1, w - PAD.left - PAD.right),
      innerH: Math.max(1, h - PAD.top - PAD.bottom),
    };
  }

  _scales() {
    const s = this.stats;
    const p = this._plot();
    const maxDist = s.distance || 1;
    // Round the elevation axis outward to a sensible step, and never show a
    // band narrower than 50 m or flat routes look like rollercoasters.
    const rawMin = s.minEle;
    const rawMax = s.maxEle;
    const mid = (rawMin + rawMax) / 2;
    const half = Math.max(25, (rawMax - rawMin) / 2 * 1.15);
    const lo = Math.floor((mid - half) / 25) * 25;
    const hi = Math.ceil((mid + half) / 25) * 25;
    return {
      ...p,
      maxDist,
      eleLo: lo,
      eleHi: hi,
      x: (d) => p.x0 + (d / maxDist) * p.innerW,
      y: (e) => p.y1 - ((e - lo) / Math.max(1, hi - lo)) * p.innerH,
      dOf: (px) => clamp(((px - p.x0) / p.innerW) * maxDist, 0, maxDist),
    };
  }

  _distFromEvent(e) {
    if (!this.stats?.profile?.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    return this._scales().dOf(clientX - rect.left);
  }

  _sampleAt(dist) {
    const p = this.stats.profile;
    if (!p.length) return null;
    const i = clamp(Math.round(dist / (this.stats.interval || 10)), 0, p.length - 1);
    return p[i];
  }

  _climbAt(dist) {
    if (dist == null) return null;
    return this.stats?.climbs?.find((c) => dist >= c.startDist && dist <= c.endDist) || null;
  }

  _onMove(e) {
    if (!this.stats?.hasElevation) return;
    const dist = this._distFromEvent(e);
    this.hoverDist = dist;
    const sample = this._sampleAt(dist);
    this.onHover(sample ? { ...sample, climb: this._climbAt(dist) } : null);
    this.draw();
  }

  _onLeave() {
    this.hoverDist = null;
    this.onHover(null);
    this.draw();
  }

  /* ---------------- rendering ---------------- */

  draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(canvas);
    const ink = style.getPropertyValue('--chart-ink').trim() || '#5b6472';
    const grid = style.getPropertyValue('--chart-grid').trim() || 'rgba(120,130,145,0.18)';

    if (!this.stats?.hasElevation || !this.stats.profile.length) {
      ctx.fillStyle = ink;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No elevation data yet', w / 2, h / 2);
      return;
    }

    const s = this._scales();
    this._drawGrid(ctx, s, ink, grid);
    this._drawArea(ctx, s);
    this._drawClimbs(ctx, s, ink);
    this._drawOutline(ctx, s);
    this._drawCursor(ctx, s, ink);
  }

  _drawGrid(ctx, s, ink, grid) {
    ctx.save();
    ctx.strokeStyle = grid;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';

    // Elevation gridlines — aim for ~5 lines on a nice round step.
    const span = s.eleHi - s.eleLo;
    const step = niceStep(span / 5);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let e = Math.ceil(s.eleLo / step) * step; e <= s.eleHi; e += step) {
      const y = Math.round(s.y(e)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(s.x0, y);
      ctx.lineTo(s.x1, y);
      ctx.stroke();
      ctx.fillText(fmtElevation(e, this.units).replace(/\s?(m|ft)$/, ''), s.x0 - 8, y);
    }

    // Distance gridlines.
    const kmSpan = s.maxDist / 1000;
    const kmStep = niceStep(kmSpan / 6) || 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let km = 0; km <= kmSpan + 0.001; km += kmStep) {
      const x = Math.round(s.x(km * 1000)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, s.y0);
      ctx.lineTo(x, s.y1);
      ctx.stroke();
      ctx.fillText(String(Math.round(km * 100) / 100), x, s.y1 + 6);
    }

    ctx.restore();
  }

  /**
   * One vertical strip per pixel column, coloured by the mean gradient in that
   * column.
   *
   * The mean, not the extreme: DEM elevation carries several metres of noise,
   * and on switchbacks the per-sample gradient swings wildly either side of
   * the true value. Colouring by the extreme turns a steady 8% alpine climb
   * into a flickering barcode of 3% and 15% stripes. The mean shows the
   * gradient a rider actually experiences.
   */
  _drawArea(ctx, s) {
    const profile = this.stats.profile;
    const n = profile.length;
    const width = Math.round(s.innerW);
    const interval = this.stats.interval || 10;

    ctx.save();
    for (let px = 0; px < width; px++) {
      const dA = (px / width) * s.maxDist;
      const dB = ((px + 1) / width) * s.maxDist;
      const iA = clamp(Math.floor(dA / interval), 0, n - 1);
      const iB = clamp(Math.ceil(dB / interval), 0, n - 1);

      let ele = profile[iA].ele;
      let gradeSum = 0;
      let count = 0;
      for (let i = iA; i <= iB; i++) {
        gradeSum += profile[i].grade;
        count++;
        ele = Math.max(ele, profile[i].ele);
      }

      const x = s.x0 + px;
      const y = s.y(ele);
      ctx.fillStyle = bandFor(count ? gradeSum / count : 0).color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, 1.05, s.y1 - y);
    }
    ctx.restore();
  }

  _drawClimbs(ctx, s, ink) {
    const climbs = this.stats.climbs || [];
    ctx.save();
    for (const climb of climbs) {
      const xa = s.x(climb.startDist);
      const xb = s.x(climb.endDist);
      const selected = this.selectedClimb && this.selectedClimb.number === climb.number;

      ctx.fillStyle = selected ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
      ctx.fillRect(xa, s.y0, xb - xa, s.y1 - s.y0);

      ctx.strokeStyle = climb.category.color;
      ctx.globalAlpha = selected ? 1 : 0.75;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(xa) + 0.5, s.y0);
      ctx.lineTo(Math.round(xa) + 0.5, s.y1);
      ctx.moveTo(Math.round(xb) + 0.5, s.y0);
      ctx.lineTo(Math.round(xb) + 0.5, s.y1);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Only badge climbs with room for the label.
      if (xb - xa > 26) {
        const label = climb.category.label === 'Uncategorised' ? `${climb.number}` : climb.category.label;
        ctx.font = '600 10px system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = (xa + xb) / 2 - tw / 2 - 4;
        ctx.fillStyle = climb.category.color;
        roundRect(ctx, bx, s.y0 + 2, tw + 8, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, bx + 4, s.y0 + 5);
      }
    }
    void ink;
    ctx.restore();
  }

  _drawOutline(ctx, s) {
    const profile = this.stats.profile;
    ctx.save();
    ctx.beginPath();
    const stride = Math.max(1, Math.floor(profile.length / (s.innerW * 2)));
    for (let i = 0; i < profile.length; i += stride) {
      const x = s.x(profile[i].dist);
      const y = s.y(profile[i].ele);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    const last = profile[profile.length - 1];
    ctx.lineTo(s.x(last.dist), s.y(last.ele));
    ctx.strokeStyle = 'rgba(30,38,50,0.55)';
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  _drawCursor(ctx, s, ink) {
    if (this.hoverDist == null) return;
    const sample = this._sampleAt(this.hoverDist);
    if (!sample) return;

    const x = s.x(sample.dist);
    const y = s.y(sample.ele);

    ctx.save();
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, s.y0);
    ctx.lineTo(Math.round(x) + 0.5, s.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = bandFor(sample.grade).color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Tooltip, flipped to whichever side has room.
    const lines = [
      `${fmtDistance(sample.dist, this.units)}`,
      `${fmtElevation(sample.ele, this.units)}`,
      `${(sample.grade * 100).toFixed(1)}%`,
    ];
    ctx.font = '600 11px system-ui, sans-serif';
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = tw + 16;
    const boxH = 14 * lines.length + 10;
    const bx = x + boxW + 12 < s.x1 ? x + 10 : x - boxW - 10;
    const by = clamp(y - boxH - 10, s.y0, s.y1 - boxH);

    ctx.fillStyle = 'rgba(22,28,38,0.92)';
    roundRect(ctx, bx, by, boxW, boxH, 5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 6 + i * 14));
    ctx.restore();
  }
}

/* ---------------- helpers ---------------- */

function niceStep(raw) {
  if (!isFinite(raw) || raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Legend swatches for the gradient bands, used under the chart. */
export function gradientLegend() {
  return GRADIENT_BANDS.map((b) => ({ label: b.label, color: b.color, id: b.id }));
}
