// Shared crop geometry for the non-destructive folder-hero cover adjuster.
// Both directions rely on the exact same forward transform convention
// already established (and runtime-validated) by
// components/collection/photo-adjuster.tsx: an Animated.View wrapping a
// contentFit="contain" Image, transformed as
// `transform: [{translateX: tx}, {translateY: ty}, {scale}]`, which in
// React Native composes as `screen = S * (view - center) + center + t`.
//
// Unlike photo-adjuster.tsx (which crops/exports a physical file), nothing
// here touches the image itself — these functions only convert between a
// live gesture's {scale, tx, ty} (meaningful only for one specific
// container size and one specific decoded image size) and a persisted,
// resolution-independent {x, y, scale} crop (folders.cover_crop — see
// supabase/migrations/20260901130000_add_folder_cover_crop.sql for the
// exact field contract).
//
// The folder-cover adjuster's own preview frame IS its full container
// (unlike photo-adjuster.tsx's frame-smaller-than-container design, which
// exists there to support multiple switchable aspect ratios) — so every
// function below takes a single containerW/containerH pair rather than a
// separate frame rect.

import type { FolderCoverCrop } from '@/types';

// Clamps a candidate translation so the displayed (contentFit="contain",
// then scaled) image always fully covers the container — no blank space
// can enter the frame. Extracted verbatim from photo-adjuster.tsx's own
// worklet of the same name (with `frame` renamed to the more general
// `containerSize`/`frameStart`/`frameSize` this call site also uses when
// frame === container), so both crop tools share one proven derivation
// instead of two independently-maintained copies.
export function clampAxisTranslation(
  scale: number,
  raw: number,
  frameStart: number,
  frameSize: number,
  imgOffset: number,
  dispSize: number,
  containerSize: number,
) {
  'worklet';
  const max = frameStart - scale * (imgOffset - containerSize / 2) - containerSize / 2;
  const min = frameStart + frameSize - scale * (imgOffset + dispSize - containerSize / 2) - containerSize / 2;
  return Math.min(max, Math.max(min, raw));
}

type Geometry = {
  fitScale: number;
  dispW: number;
  dispH: number;
  offX: number;
  offY: number;
  minScale: number;
};

// contentFit="contain" placement of imageW x imageH within containerW x
// containerH, plus the additional zoom (minScale) needed on top of that to
// make the image fully cover the container with no gaps — the same
// two-step fit photo-adjuster.tsx computes for its own frame.
function computeGeometry(containerW: number, containerH: number, imageW: number, imageH: number): Geometry {
  const fitScale = Math.min(containerW / imageW, containerH / imageH);
  const dispW = imageW * fitScale;
  const dispH = imageH * fitScale;
  const offX = (containerW - dispW) / 2;
  const offY = (containerH - dispH) / 2;
  const minScale = Math.max(containerW / dispW, containerH / dispH);
  return { fitScale, dispW, dispH, offX, offY, minScale };
}

// Adjuster (Save) -> persisted crop. Reads the live gesture's final
// {scale, tx, ty} (JS-thread reads of the shared values — safe only when
// no gesture is active, i.e. right when the user taps Save, same
// assumption photo-adjuster.tsx's own cropToView() makes) and derives the
// image-native focal point + relative zoom that reproduces this exact
// framing at any future render size.
export function deriveFolderCoverCrop(params: {
  scale: number;
  tx: number;
  ty: number;
  containerW: number;
  containerH: number;
  imageW: number;
  imageH: number;
}): FolderCoverCrop {
  const { scale: S, tx, ty, containerW, containerH, imageW, imageH } = params;
  const { fitScale, offX, offY, minScale } = computeGeometry(containerW, containerH, imageW, imageH);

  // Inverse of the forward transform, evaluated at the container's own
  // center (screen_x = containerW/2) since frame === container here:
  // view_x = (screen_x - tx - containerW/2)/S + containerW/2
  //        = -tx/S + containerW/2   when screen_x = containerW/2
  const viewXCenter = -tx / S + containerW / 2;
  const viewYCenter = -ty / S + containerH / 2;
  const imgXCenter = (viewXCenter - offX) / fitScale;
  const imgYCenter = (viewYCenter - offY) / fitScale;

  return {
    x: imgXCenter / imageW,
    y: imgYCenter / imageH,
    scale: S / minScale,
  };
}

// Persisted crop -> render transform. Inverse of deriveFolderCoverCrop,
// re-evaluated against whatever containerW/containerH/imageW/imageH apply
// at render time (which may differ from adjust-time — a different device
// width, for instance) — this is exactly what makes the persisted crop
// resolution-independent. Re-clamps the result (defense in depth, same
// posture as photo-adjuster.tsx) so a saved crop can never render with
// gaps even from an edge-case image aspect ratio.
export function resolveFolderCoverTransform(params: {
  crop: FolderCoverCrop;
  containerW: number;
  containerH: number;
  imageW: number;
  imageH: number;
}): { tx: number; ty: number; scale: number } {
  const { crop, containerW, containerH, imageW, imageH } = params;
  const { fitScale, dispW, dispH, offX, offY, minScale } = computeGeometry(containerW, containerH, imageW, imageH);

  const S = Math.max(crop.scale * minScale, minScale);
  const imgXCenter = crop.x * imageW;
  const imgYCenter = crop.y * imageH;
  const viewXCenter = imgXCenter * fitScale + offX;
  const viewYCenter = imgYCenter * fitScale + offY;

  const rawTx = (containerW / 2 - viewXCenter) * S;
  const rawTy = (containerH / 2 - viewYCenter) * S;
  const tx = clampAxisTranslation(S, rawTx, 0, containerW, offX, dispW, containerW);
  const ty = clampAxisTranslation(S, rawTy, 0, containerH, offY, dispH, containerH);

  return { tx, ty, scale: S };
}
