// Shared by the app (live preview, swatches) and the mockup renderer, so both draw identical backgrounds.
// A background is { type, base, a, b, c, angle, size, fade }; which fields matter depends on the type.
window.BG_TYPES = {
  solid: { label: 'Solid', fields: { base: 'Color' } },
  gradient: { label: 'Gradient', fields: { a: 'Color 1', b: 'Color 2', c: 'Color 3' }, angle: true },
  mesh: { label: 'Mesh', fields: { base: 'Base', a: 'Glow 1', b: 'Glow 2', c: 'Glow 3' } },
  grid: { label: 'Grid', fields: { base: 'Background', a: 'Lines' }, size: true, fade: true },
  dots: { label: 'Dot grid', fields: { base: 'Background', a: 'Dots' }, size: true, fade: true },
};

window.BG_PRESETS = {
  aurora: { type: 'mesh', base: '#0e0b24', a: '#7c5cff', b: '#00c2ff', c: '#ff5fb4' },
  graphite: { type: 'mesh', base: '#111114', a: '#3b3b44', b: '#23232a', c: '#2c2c34' },
  sunset: { type: 'gradient', a: '#ffb88c', b: '#ff6a88', c: '#b06ab3', angle: 135 },
  ocean: { type: 'gradient', a: '#5b7cfa', b: '#764ba2', c: '', angle: 135 },
  mint: { type: 'gradient', a: '#d4fc79', b: '#96e6a1', c: '', angle: 135 },
  paper: { type: 'solid', base: '#efece6' },
  blueprint: { type: 'grid', base: '#0b1d3a', a: '#23467e', size: 56, fade: true },
  graph: { type: 'grid', base: '#fafafa', a: '#e2e2e8', size: 48, fade: true },
  dots: { type: 'dots', base: '#f3f3f5', a: '#bdbdc7', size: 28, fade: true },
  night: { type: 'dots', base: '#0c0c10', a: '#3a3a48', size: 26, fade: true },
};

// u = pixels per design unit (the renderer passes canvasSize/1080 so patterns scale with the output).
window.bgCSS = (bg, u = 1) => {
  const { type, base = '#111111', a = '#ffffff', b = '#888888', c = '', angle = 135, size = 40, fade = false } = bg || {};
  const px = (v) => `${(v * u).toFixed(2)}px`;
  const cell = `${px(size)} ${px(size)}`;
  const vignette = fade ? `radial-gradient(ellipse 70% 65% at 50% 50%, transparent 25%, ${base} 95%), ` : '';
  switch (type) {
    case 'gradient':
      return `linear-gradient(${angle}deg, ${[a, b, c].filter(Boolean).join(', ')})`;
    case 'mesh':
      return `radial-gradient(at 18% 22%, ${a} 0, transparent 52%), radial-gradient(at 85% 18%, ${b} 0, transparent 50%), `
        + `radial-gradient(at 60% 95%, ${c || a} 0, transparent 55%), ${base}`;
    case 'grid': {
      const line = `${Math.max(1, u).toFixed(2)}px`;
      return `${vignette}linear-gradient(${a} ${line}, transparent ${line}) center / ${cell}, `
        + `linear-gradient(90deg, ${a} ${line}, transparent ${line}) center / ${cell}, ${base}`;
    }
    case 'dots':
      return `${vignette}radial-gradient(circle, ${a} ${px(1.6)}, transparent ${px(2.2)}) center / ${cell}, ${base}`;
    default:
      return base;
  }
};
