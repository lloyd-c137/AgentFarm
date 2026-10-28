/* A small night farm drawn at low resolution and scaled up with crisp pixels.
   The scene is painted once into an offscreen canvas; only stars and fireflies are redrawn, at 8 fps,
   and nothing runs while the tab is hidden or when reduced motion is requested. */
(() => {
  const cv = document.getElementById('farm-bg'); if (!cv) return;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, base = null, stars = [], flies = [], last = 0;
  const C = { sky: ['#120e24', '#1b1530', '#241c3e', '#2e2450', '#3a2d5c'], hill: ['#1a2a2e', '#1d3a2b', '#22462f'], g: ['#1d3a2b', '#2a5634', '#3b7438', '#56943f'],
    soil: ['#2a1a1c', '#3b241f', '#553426'], wood: ['#24161a', '#3b241f', '#553426', '#6e4630'], roof: ['#341626', '#5c2236'], win: '#f2c14e', moon: ['#fbefd2', '#e8d8b4', '#c8b48e'] };
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(20261028);
  const rect = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x | 0, y | 0, w | 0, h | 0); };

  function paint() {
    const c = base.getContext('2d');
    // sky: a smooth ramp through the palette, ordered-dithered like the game's skies
    const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], skyH = Math.ceil(H * 0.7);
    const rgb = C.sky.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    const img = c.createImageData(W, skyH), d = img.data;
    for (let y = 0; y < skyH; y++) {
      const t = Math.pow(y / skyH, 1.2) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(t)), f = t - i;
      for (let x = 0; x < W; x++) {
        const col = B4[(y & 3) * 4 + (x & 3)] / 16 < f ? rgb[i + 1] : rgb[i], k = (y * W + x) * 4;
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    // moon
    const mx = Math.round(W * 0.8), my = Math.round(H * 0.16), r = Math.max(6, Math.round(H * 0.05));
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) rect(c, mx + x, my + y, 1, 1, x + y > r * 0.6 ? C.moon[1] : C.moon[0]);
    rect(c, mx - 2, my - 1, 2, 2, C.moon[2]); rect(c, mx + 2, my + 3, 1, 1, C.moon[2]);
    // two rows of hills
    const hillY = H * 0.58;
    for (let k = 0; k < 2; k++) {
      const amp = H * (0.06 - k * 0.02), base0 = hillY + k * H * 0.05, ph = k * 2.1;
      for (let x = 0; x < W; x++) { const y = Math.round(base0 - amp * (Math.sin(x / (W * 0.13) + ph) * 0.6 + Math.sin(x / (W * 0.05) + ph * 3) * 0.4)); rect(c, x, y, 1, H - y, C.hill[k]); }
    }
    // pine silhouettes
    for (let i = 0; i < Math.round(W / 18); i++) {
      const tx = Math.round(rnd() * W), th = 8 + Math.round(rnd() * 10), ty = Math.round(hillY + H * 0.04);
      for (let j = 0; j < th; j++) { const w = Math.max(1, Math.round((j / th) * th * 0.45)); rect(c, tx - (w >> 1), ty - th + j, w, 1, C.hill[0]); }
    }
    // ground
    const gy = Math.round(H * 0.68);
    rect(c, 0, gy, W, H - gy, C.g[1]);
    for (let i = 0; i < W * (H - gy) / 14; i++) rect(c, rnd() * W, gy + rnd() * (H - gy), 1, 1, rnd() < 0.5 ? C.g[0] : C.g[2]);
    // farmhouse on the left with a lit window
    const hx = Math.round(W * 0.1), hy = gy - 16;
    rect(c, hx, hy, 22, 16, C.wood[2]); for (let y = hy + 2; y < hy + 16; y += 3) rect(c, hx, y, 22, 1, C.wood[1]);
    for (let j = 0; j < 9; j++) rect(c, hx - 2 + j, hy - 9 + j, 26 - 2 * j, 1, j % 3 ? C.roof[1] : C.roof[0]);
    rect(c, hx + 4, hy + 5, 5, 5, C.win); rect(c, hx + 6, hy + 5, 1, 5, C.wood[1]); rect(c, hx + 4, hy + 7, 5, 1, C.wood[1]);
    rect(c, hx + 14, hy + 7, 5, 9, C.wood[0]); rect(c, hx + 17, hy - 13, 3, 6, C.wood[1]);
    for (let i = 0; i < 18; i++) { const a = rnd(); rect(c, hx + 2 + a * 10 - 4, hy + 10 + rnd() * 8, 1, 1, 'rgba(242,193,78,0.25)'); }
    // tilled field with rows of sprouts on the right
    const fx = Math.round(W * 0.42), fw = Math.round(W * 0.5), fy = gy + 6, rows = Math.max(3, Math.floor((H - fy - 6) / 8));
    for (let r = 0; r < rows; r++) {
      const y = fy + r * 8; rect(c, fx, y, fw, 6, C.soil[1]); rect(c, fx, y, fw, 1, C.soil[2]); rect(c, fx, y + 5, fw, 1, C.soil[0]);
      for (let x = fx + 4; x < fx + fw - 4; x += 10) {
        const s = rnd(); if (s < 0.25) continue; const h = 1 + Math.round(s * 3);
        rect(c, x, y + 2 - h, 1, h + 1, C.g[2]); rect(c, x - 1, y + 2 - h, 1, 1, C.g[3]); rect(c, x + 1, y + 1 - h, 1, 1, C.g[3]);
        if (s > 0.93) { rect(c, x, y - h - 3, 1, 1, '#76b6e6'); }
      }
    }
    // fence in the foreground
    const fy2 = gy + 1;
    rect(c, 0, fy2 + 1, W, 1, C.wood[2]); rect(c, 0, fy2 + 4, W, 1, C.wood[2]);
    for (let x = 2; x < W; x += 7) { rect(c, x, fy2 - 1, 2, 8, C.wood[3]); rect(c, x, fy2 - 1, 2, 1, C.wood[2]); }
  }

  function resize() {
    const scale = Math.max(2, Math.round(Math.min(innerWidth / 320, innerHeight / 180)));
    W = Math.ceil(innerWidth / scale); H = Math.ceil(innerHeight / scale);
    cv.width = W; cv.height = H;
    base = document.createElement('canvas'); base.width = W; base.height = H; paint();
    stars = Array.from({ length: Math.round(W * H / 420) }, () => ({ x: rnd() * W | 0, y: rnd() * H * 0.5 | 0, p: rnd() * 6.28, s: 0.5 + rnd() }));
    flies = Array.from({ length: Math.max(4, Math.round(W / 40)) }, () => ({ x: rnd() * W, y: H * (0.62 + rnd() * 0.3), p: rnd() * 6.28 }));
    draw(performance.now());
  }
  function draw(t) {
    ctx.drawImage(base, 0, 0);
    for (const s of stars) { const a = 0.5 + 0.5 * Math.sin(t / 900 * s.s + s.p); ctx.fillStyle = a > 0.75 ? '#fff6c8' : a > 0.35 ? '#c6c4d2' : '#6c6a82'; ctx.fillRect(s.x, s.y, 1, 1); }
    for (const f of flies) { const a = Math.sin(t / 700 + f.p); if (a < 0) continue; ctx.fillStyle = a > 0.6 ? '#ffe58a' : '#b4d872'; ctx.fillRect((f.x + Math.sin(t / 2300 + f.p) * 6) | 0, (f.y + Math.cos(t / 1700 + f.p) * 3) | 0, 1, 1); }
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function loop(t) { if (t - last > 125) { last = t; draw(t); } if (!still) requestAnimationFrame(loop); }
  let rt = 0; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 120); });
  resize(); if (!still) requestAnimationFrame(loop);
})();
