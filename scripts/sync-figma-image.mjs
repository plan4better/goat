import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config({ path: path.resolve(".env.local") });

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FIGMA_FILE_KEY = "SmmQgQZ9QvWwg62NBlJcN8";
const FIGMA_PAGE_NODE_ID = "1790:117";
const DOCS_IMAGE_ROOT = path.resolve("apps/docs/static/img");

const defaults = {
  scale: "2",
  quality: "100",
  format: "webp",
};

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for argument --${key}`);
    }

    parsed[key] = value;
    i += 1;
  }

  return parsed;
}

function ensureTargetPath(targetArg) {
  if (!targetArg) {
    throw new Error(
      "Missing --target. Example: --target apps/docs/static/img/map/interface/map_interface.webp",
    );
  }

  if (path.isAbsolute(targetArg)) {
    throw new Error("Use a repo-relative --target path, not an absolute path.");
  }

  const normalizedTarget = targetArg.replace(/\\/g, "/");

  if (normalizedTarget.startsWith("goat/")) {
    throw new Error(
      'Do not prefix the target with "goat/". Use paths like apps/docs/static/img/...',
    );
  }

  if (!normalizedTarget.startsWith("apps/docs/static/img/")) {
    throw new Error('Target must stay inside "apps/docs/static/img/".');
  }

  const outputPath = path.resolve(normalizedTarget);
  const relativeToRoot = path.relative(DOCS_IMAGE_ROOT, outputPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error('Target must stay inside "apps/docs/static/img/".');
  }

  return {
    outputPath,
    targetName: path.basename(outputPath, path.extname(outputPath)),
  };
}

async function figmaGetJson(url) {
  const response = await fetch(url, {
    headers: {
      "X-Figma-Token": FIGMA_TOKEN,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Figma request failed: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

function findNodesByName(node, targetName, matches = []) {
  if (!node) {
    return matches;
  }

  if (node.name === targetName) {
    matches.push(node);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      findNodesByName(child, targetName, matches);
    }
  }

  return matches;
}

const args = parseArgs(process.argv.slice(2));
const SCALE = Number(args.scale ?? defaults.scale);
const QUALITY = Number(args.quality ?? defaults.quality);
const FORMAT = (args.format ?? defaults.format).toLowerCase();
const { outputPath, targetName } = ensureTargetPath(args.target);

if (!FIGMA_TOKEN) {
  throw new Error(
    "Missing FIGMA_TOKEN. Add it to .env.local before running this script.",
  );
}

if (!["webp", "png", "jpeg"].includes(FORMAT)) {
  throw new Error("Unsupported format. Use one of: webp, png, jpeg");
}

const pageData = await figmaGetJson(
  `https://api.figma.com/v1/files/${FIGMA_FILE_KEY}/nodes?ids=${encodeURIComponent(FIGMA_PAGE_NODE_ID)}`,
);

const pageNode = pageData.nodes?.[FIGMA_PAGE_NODE_ID]?.document;

if (!pageNode) {
  throw new Error(`Could not load Figma page node ${FIGMA_PAGE_NODE_ID}.`);
}

const matches = findNodesByName(pageNode, targetName);

if (matches.length === 0) {
  throw new Error(
    `No node named "${targetName}" was found under Figma page ${FIGMA_PAGE_NODE_ID}.`,
  );
}

if (matches.length > 1) {
  const duplicateIds = matches.map((node) => node.id).join(", ");
  throw new Error(
    `Multiple nodes named "${targetName}" were found under Figma page ${FIGMA_PAGE_NODE_ID}: ${duplicateIds}`,
  );
}

const figmaNodeId = matches[0].id;

const exportPayload = await figmaGetJson(
  `https://api.figma.com/v1/images/${FIGMA_FILE_KEY}?ids=${encodeURIComponent(figmaNodeId)}&format=png&scale=${SCALE}`,
);

const imageUrl = exportPayload.images?.[figmaNodeId];

if (!imageUrl) {
  throw new Error(`Figma did not return an image URL for node ${figmaNodeId}.`);
}

const imageResponse = await fetch(imageUrl);

if (!imageResponse.ok) {
  throw new Error(
    `Downloading the rendered image failed: ${imageResponse.status} ${await imageResponse.text()}`,
  );
}

const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

await fs.mkdir(path.dirname(outputPath), { recursive: true });

const image = sharp(imageBuffer);

if (FORMAT === "webp") {
  await image.webp({ quality: QUALITY }).toFile(outputPath);
} else if (FORMAT === "png") {
  await image.png({ quality: QUALITY }).toFile(outputPath);
} else {
  await image.jpeg({ quality: QUALITY }).toFile(outputPath);
}

console.log(`Updated ${outputPath} from Figma node ${figmaNodeId}`);
