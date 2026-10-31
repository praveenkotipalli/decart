/**
 * Small images drawn once with Canvas2D and uploaded as textures: the burnt-in
 * "not AI" label for the local preview, and the geometry test card.
 */

const FONT_UI = '"Inter Tight Variable", "Inter Tight", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

export function drawPreviewLabel(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 720;
  c.height = 92;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(4, 6, 12, 0.78)";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#ffb4bd";
  g.fillRect(0, 0, 8, c.height);
  g.fillStyle = "#f4f7ff";
  g.font = `600 34px ${FONT_UI}`;
  g.textBaseline = "middle";
  g.fillText("LOCAL PREVIEW — NOT AI OUTPUT", 30, 34);
  g.fillStyle = "rgba(220, 228, 255, 0.72)";
  g.font = `400 21px ${FONT_MONO}`;
  g.fillText("on-device stylisation · Decart is not connected", 30, 68);
  return c;
}

export function drawTestCard(width = 1280, height = 720): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  g.fillStyle = "#070a14";
  g.fillRect(0, 0, width, height);

  // Grid: straight lines must stay straight under a projective map.
  g.strokeStyle = "rgba(120, 160, 255, 0.22)";
  g.lineWidth = 2;
  const step = width / 16;
  for (let x = step; x < width; x += step) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
  }
  for (let y = step; y < height; y += step) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke();
  }
  g.strokeStyle = "rgba(220, 232, 255, 0.85)";
  g.lineWidth = 6;
  g.strokeRect(3, 3, width - 6, height - 6);

  // Diagonals meet at the centre — under perspective they meet at the *projected* centre.
  g.strokeStyle = "rgba(139, 108, 255, 0.55)";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(width, height);
  g.moveTo(width, 0);
  g.lineTo(0, height);
  g.stroke();

  g.strokeStyle = "rgba(90, 168, 255, 0.95)";
  g.lineWidth = 5;
  g.beginPath();
  g.arc(width / 2, height / 2, height * 0.3, 0, Math.PI * 2);
  g.stroke();

  const corners: [string, number, number, string][] = [
    ["P1", 0, 0, "#5aa8ff"],
    ["P2", width, 0, "#8b6cff"],
    ["P3", width, height, "#e8f2ff"],
    ["P4", 0, height, "#47d6ff"],
  ];
  const s = height * 0.2;
  for (const [label, x, y, color] of corners) {
    const dx = x === 0 ? 1 : -1;
    const dy = y === 0 ? 1 : -1;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + dx * s, y);
    g.lineTo(x, y + dy * s);
    g.closePath();
    g.fill();
    g.fillStyle = "#05070d";
    g.font = `700 ${Math.round(s * 0.26)}px ${FONT_UI}`;
    g.textAlign = dx > 0 ? "left" : "right";
    g.textBaseline = dy > 0 ? "top" : "bottom";
    g.fillText(label, x + dx * s * 0.12, y + dy * s * 0.1);
  }

  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#f4f7ff";
  g.font = `600 ${Math.round(height * 0.07)}px ${FONT_UI}`;
  g.fillText("TEST PATTERN", width / 2, height / 2 - height * 0.04);
  g.fillStyle = "rgba(200, 214, 255, 0.75)";
  g.font = `400 ${Math.round(height * 0.032)}px ${FONT_MONO}`;
  g.fillText("↑ up · projective mapping check", width / 2, height / 2 + height * 0.05);
  return c;
}
