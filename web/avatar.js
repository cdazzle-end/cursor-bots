// Blob avatars in the style of the Grok Bot app: a soft colored shape with two
// small "eye" marks near the top right.

const PATHS = {
  classic: "M50 8 C75 8 92 26 92 52 C92 76 74 92 50 92 C25 92 8 75 8 50 C8 26 25 8 50 8Z",
  wink: "M52 10 C78 12 94 32 90 58 C86 82 64 94 42 90 C18 86 6 66 10 42 C14 20 30 8 52 10Z",
  bean: "M30 18 C48 6 78 10 88 32 C98 54 86 82 60 88 C36 94 12 84 9 60 C6 40 14 28 30 18Z",
  drop: "M50 6 C64 26 90 40 90 62 C90 82 72 94 50 94 C28 94 10 82 10 62 C10 40 36 26 50 6Z",
  ghost:
    "M50 8 C74 8 90 26 90 50 L90 86 C85 80 79 80 73 86 C67 92 61 92 55 86 C50 80 44 80 38 86 C32 92 26 92 20 86 C16 82 12 82 10 84 L10 50 C10 26 26 8 50 8Z",
  cube: "M28 10 H72 C82 10 90 18 90 28 V72 C90 82 82 90 72 90 H28 C18 90 10 82 10 72 V28 C10 18 18 10 28 10Z",
  star: starPath(),
  cloud:
    "M30 40 C30 24 46 16 58 22 C66 12 86 16 88 32 C98 38 96 58 84 62 C86 78 68 88 56 80 C46 92 24 88 22 74 C8 72 4 52 16 46 C14 40 22 36 30 40Z",
};

export const SHAPES = Object.keys(PATHS);
export const COLORS = ["#ff3b3b", "#ff7a1a", "#ffc928", "#30c85e", "#16c2a3", "#1f7cff", "#9b5cff", "#ff4fa3", "#e8e8e8", "#8d8d8d"];

function starPath() {
  const pts = [];
  const n = 7;
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 44 : 33;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push([50 + r * Math.cos(a), 52 + r * Math.sin(a)]);
  }
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    d += i === 0 ? `M${mid[0].toFixed(1)} ${mid[1].toFixed(1)} ` : "";
    const nxt = pts[(i + 1) % pts.length];
    const nmid = [(nxt[0] + pts[(i + 2) % pts.length][0]) / 2, (nxt[1] + pts[(i + 2) % pts.length][1]) / 2];
    d += `Q${nxt[0].toFixed(1)} ${nxt[1].toFixed(1)} ${nmid[0].toFixed(1)} ${nmid[1].toFixed(1)} `;
  }
  return d + "Z";
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function avatarSvg(avatar) {
  const shape = PATHS[avatar?.shape] ? avatar.shape : "classic";
  const color = avatar?.color || "#e8e8e8";
  const eye = luminance(color) > 0.28 ? "#111" : "#fff";
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${PATHS[shape]}" fill="${color}"/>` +
    `<rect x="55" y="24" width="8.5" height="17" rx="4.2" transform="rotate(-18 59 32)" fill="${eye}"/>` +
    `<rect x="70.5" y="28" width="8.5" height="13" rx="4.2" transform="rotate(-18 75 34)" fill="${eye}"/></svg>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function avatarHtml(avatar, size, opts = {}) {
  const inner = avatar?.image
    ? `<img src="/api/files/raw?path=${encodeURIComponent(avatar.image)}" alt="">`
    : avatarSvg(avatar);
  const star = opts.star ? `<span class="star"><svg viewBox="0 0 24 24" width="70%" height="70%"><path fill="#fff" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg></span>` : "";
  return `<span class="avatar" style="width:${size}px;height:${size}px" ${opts.title ? `title="${esc(opts.title)}"` : ""}>${inner}${star}</span>`;
}

export function initialHtml(name, size, color = "#1f7cff") {
  const letter = esc((name || "?").trim().charAt(0).toLowerCase() || "?");
  return `<span class="initial" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.52)}px;background:${color}">${letter}</span>`;
}

/** 2x2 cluster: you, then up to three member bots (like the group rows in Grok Bot). */
export function groupAvatarHtml(members, user, size) {
  const s = Math.round(size * 0.56);
  const items = [initialHtml(user?.name, s), ...members.slice(0, 3).map((b) => avatarHtml(b?.avatar, s))];
  const pos = [
    [0, 0],
    [size - s, 0],
    [0, size - s],
    [size - s, size - s],
  ];
  if (items.length === 3) pos[2] = [Math.round((size - s) / 2), size - s];
  return `<span class="group-avatar" style="width:${size}px;height:${size}px">${items
    .map((html, i) => html.replace(/^<span class="(avatar|initial)" style="/, `<span class="$1" style="left:${pos[i][0]}px;top:${pos[i][1]}px;`))
    .join("")}</span>`;
}
