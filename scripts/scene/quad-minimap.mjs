// The client's indoor minimap for WMO maps is built from "minimap quads":
// each WMO group's bounding box is tiled into a grid of 32-256 px square
// textures named <WMO>_<group>_<x>_<y>.blp (MinimapFrame.cpp SetupQuad,
// MapObj.cpp GetMinimapQuads in the client source). This module ports the
// quad-grid maths and the paste transform so a whole map's quad set can be
// composed into one image, at the client's fixed resolution (a texel is
// 0.5 world units).

// MinimapFrame.cpp: s_minimapTexelSize = 0.5, s_minimapQuadSize = 0.5*256.
export const QUAD_TEXEL_WORLD_UNITS = 0.5;
const QUAD_SIZE_WORLD_UNITS = QUAD_TEXEL_WORLD_UNITS * 256;

// MapObj.cpp GetMinimapQuads: the quad texture size for an axis span, a
// power of two texels clamped to [32, 256].
function quadTexelsForSpan(spanWorldUnits) {
  const power = 1 << Math.ceil(Math.log2(spanWorldUnits / QUAD_SIZE_WORLD_UNITS * 256));
  if (power < 256 && power < 32) return 32;
  if (power < 256) return power;
  return 256;
}

// The quads tiling one axis of the group's box: their start and end in
// world units, with the client's 1.0-unit border on the outer edges so the
// box is covered exactly.
function quadSteps(min, max) {
  const span = max - min;
  const step = quadTexelsForSpan(span) * QUAD_TEXEL_WORLD_UNITS;
  const count = Math.max(1, Math.ceil(span / step));
  const border = QUAD_TEXEL_WORLD_UNITS * 2;
  const quads = [];
  for (let index = 0; index < count; index += 1) {
    let from = index * step + min;
    let to = from + step;
    if (!index) from -= border;
    if (index === count - 1) to += border;
    quads.push({ from, to });
  }
  return quads;
}

// MapObj.cpp GetMinimapQuads for one group box: every (x, y) quad with its
// bounds. `box` is [minX, minY, minZ, maxX, maxY, maxZ] in WMO local space;
// the result's bounds use the same space, with z pinned to the box's mid.
export function groupQuadGrid(box, groupId) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = box;
  const centerZ = (maxZ + minZ) * 0.5;
  const stepsX = quadSteps(minX, maxX);
  const stepsY = quadSteps(minY, maxY);
  const quads = [];
  for (let y = 0; y < stepsY.length; y += 1) {
    for (let x = 0; x < stepsX.length; x += 1) {
      quads.push({
        groupId,
        x,
        y,
        bounds: [stepsX[x].from, stepsY[y].from, centerZ, stepsX[x].to, stepsY[y].to, centerZ],
      });
    }
  }
  return quads;
}

export function quadTextureName(wmoBaseName, groupId, x, y) {
  // MinimapFrame.cpp s_minimapQuadFormat: "%s_%03d_%02d_%02d.blp".
  return `${wmoBaseName}_${String(groupId).padStart(3, '0')}_${String(x).padStart(2, '0')}_${String(y).padStart(2, '0')}.blp`;
}

// The image's pixel mapping (instance-watch projectInstancePosition): the
// image's width runs with world -Y and its height with world -X. For a quad
// covering world [minX..maxX] x [minY..maxY] this is its rectangle in the
// image. `bounds` is the quad's world box ({minX, minY, maxX, maxY}).
export function quadImageRect(bounds, worldBounds, scale) {
  const { minX, minY, maxX, maxY } = bounds;
  return {
    left: (worldBounds.maxY - maxY) * scale,
    right: (worldBounds.maxY - minY) * scale,
    top: (worldBounds.maxX - maxX) * scale,
    bottom: (worldBounds.maxX - minX) * scale,
  };
}

// Paste one quad texture into the image buffer. The quad texture (rendered
// by the WMO toolchain in WMO local space, +X right and +Y down in the
// image) lands in world space through the WMO placement, which for
// single-WMO maps is a 180-degree Z rotation. The net effect, verified
// against the client by border-coherence between adjacent quads:
//   u runs with world -X (u 0 at the quad's maxX edge)
//   v runs with world +Y (v 0 at the quad's minY edge)
// The image's axes are the world's rotated 90 degrees (image col with -Y,
// image row with -X), so for an image pixel at (row, col):
//   u = (row - top) / height
//   v = (right - col) / width
export function pasteQuad(image, texture, rect) {
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));
  const right = Math.min(image.width, Math.round(rect.right));
  const bottom = Math.min(image.height, Math.round(rect.bottom));
  const spanU = rect.bottom - rect.top || 1;
  const spanV = rect.right - rect.left || 1;
  const clamp = (value, extent) => Math.max(0, Math.min(extent - 1 - 1e-6, value));
  for (let row = top; row < bottom; row += 1) {
    const uC = clamp((row - rect.top) / spanU * texture.width, texture.width);
    const u0 = Math.floor(uC);
    const fu = uC - u0;
    for (let col = left; col < right; col += 1) {
      const vC = clamp((rect.right - col) / spanV * texture.height, texture.height);
      const v0 = Math.floor(vC);
      const fv = vC - v0;
      const at = (tx, ty) => (ty * texture.width + tx) * 4;
      // Bilinear over the four texels (u0/v0 stay in-bounds by the clamp).
      const mix = (channel) => {
        const a = texture.rgba[at(u0, v0) + channel];
        const b = texture.rgba[at(u0 + 1, v0) + channel];
        const c = texture.rgba[at(u0, v0 + 1) + channel];
        const d = texture.rgba[at(u0 + 1, v0 + 1) + channel];
        return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
      };
      const alpha = (texture.rgba[at(u0, v0) + 3] * (1 - fu) + texture.rgba[at(u0 + 1, v0) + 3] * fu) * (1 - fv)
        + (texture.rgba[at(u0, v0 + 1) + 3] * (1 - fu) + texture.rgba[at(u0 + 1, v0 + 1) + 3] * fu) * fv;
      if (alpha <= 0) continue;
      const dest = (row * image.width + col) * 4;
      const over = alpha / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        image.pixels[dest + channel] = mix(channel) * over + image.pixels[dest + channel] * (1 - over);
      }
      image.pixels[dest + 3] = over * 255 + (image.pixels[dest + 3] / 255) * (1 - over) * 255;
    }
  }
}
