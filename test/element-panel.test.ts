import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { renderAll } from "@coldtea/pr-lens-renderer";
import { parseGraphDoc, type GraphDoc } from "@coldtea/pr-lens-schema";
import { payloadGraph } from "@coldtea/pr-lens-schema/examples";

import { call, pushDocument, start, type Harness } from "./harness.ts";
import { clickableElements, hotspotsOf } from "../src/elements.ts";
import { draw } from "../src/render/draw.ts";

/**
 * Clicking a diagram element: the atlas the renderer hands back has to survive
 * the drawing, line up with the picture it came with, and reach the canvas page
 * as click targets, without ever reaching the contract's own tiles.
 */

/** Through the schema, so defaults the renderer relies on are filled in. */
const parse = (value: unknown): GraphDoc => parseGraphDoc(value);

const doc = parse(payloadGraph);

/** The example with one edge given files, so an edge has something to show. */
const withEdgeFiles = (): { doc: GraphDoc; edgeId: string } => {
  const copy = JSON.parse(JSON.stringify(payloadGraph));
  const edge = copy.edges[0];
  edge.files = [{ path: "src/queue/route.ts", startLine: 3, endLine: 9 }];
  return { doc: parse(copy), edgeId: edge.id };
};

describe("the atlas behind each tile", () => {
  it("keeps the renderer's atlas on every tile", () => {
    const { tiles } = draw(doc);
    assert.ok(tiles.length > 0);
    for (const tile of tiles) {
      assert.ok(tile.atlas, `tile ${tile.id} lost its atlas`);
      assert.equal(typeof tile.atlas.nodes, "object");
    }
    const placed = new Set(tiles.flatMap((tile) => Object.keys(tile.atlas.nodes)));
    for (const node of doc.nodes) {
      assert.ok(placed.has(node.id), `node ${node.id} is in no tile's atlas`);
    }
  });

  it("places every box inside its own picture", () => {
    for (const tile of draw(doc).tiles) {
      for (const box of Object.values(tile.atlas.nodes)) {
        assert.ok(box.x >= 0 && box.y >= 0, `${tile.id}: box starts off the picture`);
        assert.ok(box.x + box.width <= tile.width + 0.5, `${tile.id}: box runs off the right`);
        assert.ok(box.y + box.height <= tile.height + 0.5, `${tile.id}: box runs off the bottom`);
      }
    }
  });

  it("draws the picture in the same units the atlas uses", () => {
    for (const asset of renderAll(doc).assets) {
      const viewBox = /viewBox="([^"]+)"/.exec(asset.svg)?.[1];
      assert.equal(viewBox, `0 0 ${asset.width} ${asset.height}`);
    }
  });

  it("puts every element in the same place in both themes", () => {
    const byView = new Map<string, unknown>();
    for (const asset of renderAll(doc).assets) {
      const key = `${asset.lens}|${asset.view ?? ""}`;
      if (!byView.has(key)) byView.set(key, asset.atlas);
      else assert.deepEqual(asset.atlas, byView.get(key), `${key}: themes disagree`);
    }
  });
});

describe("what a click can open", () => {
  it("makes every node clickable, keyed by its kind", () => {
    const elements = clickableElements(doc);
    for (const node of doc.nodes) {
      const element = elements[`node:${node.id}`];
      assert.ok(element, `node ${node.id} is not clickable`);
      assert.equal(element.label, node.label);
      assert.equal(element.delta, node.delta);
      assert.deepEqual(element.files, node.files);
    }
  });

  it("leaves out an edge with no files, and keeps one that has them", () => {
    assert.equal(
      Object.keys(clickableElements(doc)).filter((key) => key.startsWith("edge:")).length,
      0,
    );

    const { doc: edged, edgeId } = withEdgeFiles();
    const element = clickableElements(edged)[`edge:${edgeId}`];
    assert.ok(element);
    assert.equal(element.element, "edge");
    assert.equal(element.files[0]?.path, "src/queue/route.ts");
    const edge = edged.edges.find((candidate) => candidate.id === edgeId);
    const fromLabel = edged.nodes.find((node) => node.id === edge?.from)?.label;
    assert.equal(element.from, fromLabel);
  });

  it("has no elements for a document this server cannot read", () => {
    assert.deepEqual(clickableElements(undefined), {});
  });

  it("puts targets in fractions of the tile, nodes after edges", () => {
    const { doc: edged, edgeId } = withEdgeFiles();
    const elements = clickableElements(edged);
    const tile = draw(edged).tiles.find((candidate) => edgeId in candidate.atlas.edges);
    assert.ok(tile, "no tile drew the edge");

    const spots = hotspotsOf(tile, elements);
    for (const spot of spots) {
      assert.ok(spot.key in elements);
      for (const value of [spot.x, spot.y, spot.w, spot.h]) {
        assert.ok(value >= 0 && value <= 1.001, `${spot.key}: ${value} is not a fraction`);
      }
    }
    const lastEdge = spots.map((spot) => spot.key.startsWith("edge:")).lastIndexOf(true);
    const firstNode = spots.findIndex((spot) => spot.key.startsWith("node:"));
    assert.ok(lastEdge < firstNode, "a node must sit above every edge");

    const nodeId = Object.keys(tile.atlas.nodes)[0] as string;
    const box = tile.atlas.nodes[nodeId];
    const spot = spots.find((candidate) => candidate.key === `node:${nodeId}`);
    assert.ok(box && spot);
    assert.ok(Math.abs(spot.x * tile.width - box.x) < 0.01);
    assert.ok(Math.abs(spot.h * tile.height - box.height) < 0.01);
  });
});

describe("the canvas page", () => {
  let harness: Harness;
  before(async () => {
    harness = await start({ LOG_REQUESTS: "false" });
  });
  after(async () => harness.close());

  const push = (document: unknown) => pushDocument(harness, document);

  const pageData = (html: string) => {
    const json = /<script id="pr-lens-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(json, "the page carries no data");
    return JSON.parse(json);
  };

  it("carries the elements and one list of targets per tile", async () => {
    const id = await push(payloadGraph);
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();
    const data = pageData(html);

    assert.equal(data.hotspots.length, data.tiles.length);
    for (const node of doc.nodes) assert.ok(data.elements[`node:${node.id}`]);
    const keys = new Set(data.hotspots.flat().map((spot: { key: string }) => spot.key));
    for (const node of doc.nodes) assert.ok(keys.has(`node:${node.id}`), `no target for ${node.id}`);

    assert.match(html, /<aside class="el-panel" id="el-panel" hidden/);
  });

  it("keeps a label that looks like markup inert", async () => {
    const copy = JSON.parse(JSON.stringify(payloadGraph));
    copy.nodes[0].label = "</script><img src=x onerror=alert(1)>";
    const id = await push(copy);
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    assert.equal(html.includes("</script><img src=x"), false);
    assert.equal(pageData(html).elements[`node:${copy.nodes[0].id}`].label, copy.nodes[0].label);
  });

  it("never hands the atlas to the contract's tiles", async () => {
    const id = await push(payloadGraph);
    const fetched = await call(`${harness.url}/api/canvas/${id}`);
    for (const tile of fetched.body.tiles) assert.equal(tile.atlas, undefined);
  });
});
