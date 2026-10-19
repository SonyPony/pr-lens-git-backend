import type { Box } from "@coldtea/pr-lens-renderer";
import type { FileRef, GraphDoc, GraphEdge, GraphNode } from "@coldtea/pr-lens-schema";

import type { DrawnTile } from "./render/draw.ts";

/**
 * The parts of a diagram a reader can click, and where they sit.
 *
 * Keys are `node:{id}` and `edge:{id}`, since a node and an edge may share an
 * id. Every node is clickable; an edge only when it names the code it stands
 * for, because its atlas box bounds the whole curve and an edge with nothing
 * to show would only steal clicks from the space around it.
 */

/** What the side panel shows for one element; built from the stored document. */
export type ClickableElement = {
  element: "node" | "edge";
  label: string;
  /** The node's or the edge's own kind, e.g. `module` or `http`. */
  type: string;
  delta: string;
  summary: string | undefined;
  files: FileRef[];
  /** Edges only: the labels of the two ends. */
  from?: string;
  to?: string;
};

const nodeElement = (node: GraphNode): ClickableElement => ({
  element: "node",
  label: node.label,
  type: node.kind,
  delta: node.delta,
  summary: node.summary,
  files: node.files,
});

const edgeElement = (edge: GraphEdge, labels: ReadonlyMap<string, string>): ClickableElement => {
  const from = labels.get(edge.from) ?? edge.from;
  const to = labels.get(edge.to) ?? edge.to;
  return {
    element: "edge",
    label: edge.label ?? `${from} → ${to}`,
    type: edge.kind,
    delta: edge.delta,
    summary: edge.summary,
    files: edge.files,
    from,
    to,
  };
};

const labelsOf = (document: GraphDoc) => new Map(document.nodes.map((node) => [node.id, node.label]));

export const clickableElements = (document: GraphDoc | undefined): Record<string, ClickableElement> => {
  const elements: Record<string, ClickableElement> = {};
  if (document === undefined) return elements;
  const labels = labelsOf(document);
  for (const node of document.nodes) elements[`node:${node.id}`] = nodeElement(node);
  for (const edge of document.edges)
    if (edge.files.length > 0) elements[`edge:${edge.id}`] = edgeElement(edge, labels);
  return elements;
};

/** One element by its key, without building the whole map: what a click asks for. */
export const elementOf = (document: GraphDoc, key: string): ClickableElement | undefined => {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === "node") {
    const node = document.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? undefined : nodeElement(node);
  }
  if (kind === "edge") {
    const edge = document.edges.find((candidate) => candidate.id === id);
    return edge === undefined || edge.files.length === 0 ? undefined : edgeElement(edge, labelsOf(document));
  }
  return undefined;
};

/** A click target on one tile, as fractions of the tile so it scales with any zoom. */
export type Hotspot = { key: string; x: number; y: number; w: number; h: number };

const fraction = (value: number, of: number): number => Math.round((value / of) * 100000) / 100000;

/**
 * The click targets of one tile, edges first so a node drawn over an edge's
 * bounding box stays on top of it and wins the click.
 */
export const hotspotsOf = (tile: DrawnTile, elements: Record<string, ClickableElement>): Hotspot[] => {
  const spots: Hotspot[] = [];
  const add = (prefix: "node" | "edge", boxes: Record<string, Box>) => {
    for (const [id, box] of Object.entries(boxes)) {
      const key = `${prefix}:${id}`;
      if (!(key in elements)) continue;
      spots.push({
        key,
        x: fraction(box.x, tile.width),
        y: fraction(box.y, tile.height),
        w: fraction(box.width, tile.width),
        h: fraction(box.height, tile.height),
      });
    }
  };
  add("edge", tile.atlas.edges);
  add("node", tile.atlas.nodes);
  return spots;
};
