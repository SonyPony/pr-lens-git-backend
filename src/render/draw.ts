import {
  PrLensRenderError,
  renderAll,
  renderAssetFileName,
  type RenderAtlas,
} from "@coldtea/pr-lens-renderer";
import type { GraphDoc, View } from "@coldtea/pr-lens-schema";

import { cannotDraw } from "../errors.ts";

/**
 * A tile as this server knows it: everything the contract asks for except the
 * absolute addresses, which depend on the origin the request arrived on and are
 * filled in by the route.
 */
export type DrawnTile = {
  id: string;
  title: string;
  lens: string;
  crumbs: string[];
  hero: boolean;
  width: number;
  height: number;
  /** Theme to the picture's own content hash, the contract's opaque handle. */
  renders: Record<string, string>;
  /** Theme to the file name under /images/{id}/, joined to an origin later. */
  files: Record<string, string>;
  /**
   * Where each lane, node, edge and flow step landed, in the picture's viewBox
   * units. A theme changes colours, never positions, so one atlas serves every
   * theme. The canvas page reads it; the contract's tiles never carry it.
   */
  atlas: RenderAtlas;
};

export type Drawing = {
  tiles: DrawnTile[];
  /** File name to SVG source, for the image routes to serve. */
  images: Map<string, string>;
  /** What holding this drawing in memory costs. */
  bytes: number;
};

export const EMPTY_DRAWING: Drawing = {
  tiles: [],
  images: new Map(),
  bytes: 0,
};

type ViewPlace = { view: View; crumbs: string[] };

/** Every view in the drill-down tree with its place in it, root first. */
const placeViews = (views: readonly View[]): Map<string, ViewPlace> => {
  const places = new Map<string, ViewPlace>();

  const walk = (view: View, above: readonly string[]): void => {
    const crumbs = [...above, view.id];
    places.set(view.id, { view, crumbs });
    for (const child of view.children) walk(child, crumbs);
  };

  for (const view of views) walk(view, []);
  return places;
};

/**
 * One document in, every picture it has out, both themes each.
 *
 * The renderer draws per view and per lens, never a flow on its own, so the
 * tiles this server produces are `view:{id}` and `lens:{lens}` and never
 * `flow:{id}`. The contract leaves that choice to the server; what it fixes is
 * what the ids mean when they do appear.
 */
export const draw = (doc: GraphDoc): Drawing => {
  let rendered;
  try {
    rendered = renderAll(doc);
  } catch (error) {
    // The renderer's failures all describe a document it cannot draw, never an
    // internal fault, so they are the author's to hear about.
    if (error instanceof PrLensRenderError) throw cannotDraw(error.message);
    throw error;
  }

  const places = placeViews(doc.views);
  const images = new Map<string, string>();
  const byTile = new Map<string, DrawnTile>();
  const order: string[] = [];
  let bytes = 0;

  for (const drawn of rendered.assets) {
    const { lens, theme, view, contentHash } = drawn.asset;
    const key = `${lens}|${view ?? ""}`;
    const fileName = renderAssetFileName({ lens, theme, view }, contentHash);

    images.set(fileName, drawn.svg);
    bytes += drawn.asset.bytes;

    let tile = byTile.get(key);
    if (tile === undefined) {
      const place = view === undefined ? undefined : places.get(view);
      tile = {
        id: view === undefined ? `lens:${lens}` : `view:${view}`,
        title: place?.view.title ?? doc.title,
        lens,
        crumbs: place?.crumbs ?? [],
        // Rewritten below: exactly one tile carries it, and it is the first.
        hero: false,
        width: drawn.width,
        height: drawn.height,
        renders: {},
        files: {},
        atlas: drawn.atlas,
      };
      byTile.set(key, tile);
      order.push(key);
    }

    tile.renders[theme] = contentHash;
    tile.files[theme] = fileName;
  }

  const tiles = order.map((key, index) => {
    const tile = byTile.get(key);
    if (tile === undefined) throw new Error(`lost tile ${key}`);
    return { ...tile, hero: index === 0 };
  });

  assertWalkthroughIsDrawable(doc, tiles);

  return { tiles, images, bytes };
};

/**
 * A walkthrough is a tour of pictures, so a step that stages something this
 * server did not draw is a document it cannot show, which is the contract's own
 * example of CANNOT_DRAW. Flow stages are checked loosely on purpose: this
 * server draws flows inside their data-flow view rather than alone, so a flow
 * step is satisfied by any data-flow tile.
 */
const assertWalkthroughIsDrawable = (
  doc: GraphDoc,
  tiles: readonly DrawnTile[],
): void => {
  if (doc.walkthrough === undefined) return;

  const ids = new Set(tiles.map((tile) => tile.id));
  const hasDataFlow = tiles.some((tile) => tile.lens === "data-flow");

  for (const step of doc.walkthrough.steps) {
    if (step.stage === undefined) continue;

    if (step.stage.kind === "view" && !ids.has(`view:${step.stage.view}`))
      throw cannotDraw(
        `Walkthrough step "${step.id}" plays over view "${step.stage.view}", which this server does not draw`,
      );

    if (step.stage.kind === "flow" && !hasDataFlow)
      throw cannotDraw(
        `Walkthrough step "${step.id}" plays over flow "${step.stage.flow}", but this document has no data-flow diagram to play it on`,
      );
  }
};
