import type { CharacterKind } from "./types";

interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface PortraitLayout {
  src: string;
  blink: string;
  eyes: [Eye, Eye];
  glints: [{ x: number; y: number }, { x: number; y: number }];
  plate: string;
  mask: { cx: number; top: number; half: number };
  scan: { x: number; y: number; width: number };
}

/** Mask sits over the mouth and chin. The stylized portrait keeps its own colors. */
const boy: PortraitLayout = {
  src: "/assets/cyber-boy.png?v=5",
  blink: "/assets/cyber-boy-blink.png?v=1",
  eyes: [
    { cx: 193, cy: 239, rx: 36, ry: 24 },
    { cx: 298, cy: 239, rx: 36, ry: 24 },
  ],
  glints: [{ x: 192, y: 227 }, { x: 297, y: 227 }],
  plate: "M202 318C216 304 228 296 240 296C252 296 264 304 278 318L284 360C270 376 256 384 240 386C224 384 210 376 196 360Z",
  mask: { cx: 240, top: 288, half: 40 },
  scan: { x: 168, y: 96, width: 144 },
};

const girl: PortraitLayout = {
  src: "/assets/cyber-girl.png?v=5",
  blink: "/assets/cyber-girl-blink.png?v=1",
  eyes: [
    { cx: 180, cy: 232, rx: 42, ry: 26 },
    { cx: 308, cy: 232, rx: 48, ry: 26 },
  ],
  glints: [{ x: 185, y: 223 }, { x: 287, y: 223 }],
  plate: "M194 292C208 278 224 272 240 272C256 272 272 278 286 292L292 342C276 360 258 368 240 370C222 368 204 360 188 342Z",
  mask: { cx: 240, top: 282, half: 46 },
  scan: { x: 172, y: 92, width: 136 },
};

function mask(layout: PortraitLayout): string {
  const { cx, top, half } = layout.mask;
  const distances = [3, 2, 1, 0, 1, 2, 3];
  const bars = distances.map((distance, index) => {
    const inset = distance * 10;
    const width = half * 2 - inset * 2;
    const y = top + 16 + index * 13;
    const height = distance === 0 ? 7 : 5.5;
    return `<rect class="mask-bar" data-distance="${distance}" x="${cx - width / 2}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#22c7ff" fill-opacity="0.9"/>`;
  }).join("");
  const equalizer = distances.map((distance, index) => {
    const x = cx - half + 6 + index * ((half * 2 - 12) / 6);
    return `<rect class="eq-bar" data-distance="${distance}" x="${x}" y="${top + 14}" width="9" height="72" rx="3.5" fill="#22c7ff" fill-opacity="0.9"/>`;
  }).join("");
  const mid = top + 52;
  return `
    <g class="holo-mask">
      <path class="mask-plate" d="${layout.plate}" fill="#041018" fill-opacity="0.72" stroke="#22c7ff" stroke-width="1.4"/>
      <path class="mask-seam" d="M${cx - half + 14} ${mid - 14}H${cx + half - 14}M${cx - half + 8} ${mid + 12}H${cx + half - 8}" fill="none" stroke="#22c7ff" stroke-opacity="0.45" stroke-width="1"/>
      <g class="mask-segmented">${bars}</g>
      <g class="mask-equalizer">${equalizer}</g>
      <g class="mask-waveform">
        <path class="mask-wave" data-left="${cx - half + 6}" data-right="${cx + half - 6}" data-mid="${mid}" d="M${cx - half + 6} ${mid}L${cx + half - 6} ${mid}" fill="none" stroke="#22c7ff" stroke-width="2.6" stroke-linecap="round"/>
      </g>
    </g>`;
}

/** Stylized portrait. Speech is still drawn by the mask, not the mouth. */
export function characterMarkup(kind: CharacterKind): string {
  const layout = kind === "cyber_boy" ? boy : girl;
  const sockets = layout.eyes.map((eye) => `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}"/>`).join("");
  const glints = layout.glints.map((glint) => `<ellipse cx="${glint.x}" cy="${glint.y}" rx="3.2" ry="2.2"/>`).join("");
  return `
    <svg class="holo-avatar" data-kind="${kind}" viewBox="0 0 480 640" width="480" height="640" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <clipPath id="${kind}-blink" clipPathUnits="userSpaceOnUse">${sockets}</clipPath>
      </defs>
      <g class="holo-pose">
        <image class="holo-portrait" href="${layout.src}" x="18" y="8" width="444" height="592" preserveAspectRatio="xMidYMid meet"/>
        <image class="holo-blink" href="${layout.blink}" x="18" y="8" width="444" height="592" preserveAspectRatio="xMidYMid meet" clip-path="url(#${kind}-blink)"/>
        <g class="holo-glints">${glints}</g>
        ${mask(layout)}
        <circle class="holo-core" cx="240" cy="528" r="4.5" fill="#22c7ff"/>
        <rect class="holo-scan" x="${layout.scan.x}" y="${layout.scan.y}" width="${layout.scan.width}" height="3" rx="1.5" fill="#22c7ff"/>
      </g>
    </svg>`;
}
