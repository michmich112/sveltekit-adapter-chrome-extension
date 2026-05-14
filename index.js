import staticAdapter from "@sveltejs/adapter-static";
import { load } from "cheerio";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { pipeline } from "stream";
import glob from "tiny-glob";
import { promisify } from "util";
import zlib from "zlib";

const pipe = promisify(pipeline);

/** @type {import('.')} */
export default function(options) {
  return {
    name: "sveltekit-adapter-chrome-extension",

    async adapt(builder) {
      staticAdapter(options).adapt(builder);

      /* extension */
      const pages = options?.pages ?? "build";
      const assets = options?.assets ?? pages;
      const manifest = options?.manifest ?? "manifest.json";

      await removeInlineScripts(assets, builder.log);

      await removeAppManifest(assets, builder.config.kit.appDir, builder.log);
      await removeAppManifest(".", assets, builder.log);

      // operation required since generated app manifest will overwrite the static extension manifest.json
      reWriteExtensionManifest(assets, manifest, builder);
    },
  };
}

/**
 * Hash using djb2
 * @param {import('types/hooks').StrictBody} value
 */
function hash(value) {
  let hash = 5381;
  let i = value.length;

  if (typeof value === "string") {
    while (i) hash = (hash * 33) ^ value.charCodeAt(--i);
  } else {
    while (i) hash = (hash * 33) ^ value[--i];
  }

  return (hash >>> 0).toString(36);
}

async function removeAppManifest(directory, appDir, log) {
  log("Removing App Manifest");
  const files = await glob(`**/${appDir}/*manifest*.json`, {
    cwd: directory,
    dot: true,
    absolute: true,
    filesOnly: true,
  });

  files.forEach((path) => {
    try {
      unlinkSync(path);
      log.success(`Removed app manifest file at path: ${path}`);
    } catch (err) {
      log.warn(
        `Error removing app manifest file at path: ${path}. You may have to delete it manually before submitting you extension.\nError: ${err}`
      );
    }
  });
}

async function removeInlineScripts(directory, log) {
  log("Removing Inline Scripts");

  const files = await glob("**/*.{html}", {
    cwd: directory,
    dot: true,
    absolute: true,
    filesOnly: true,
  });

  for (const file of files) {
    log.minor(`Processing file: ${file}`);

    // Ensure the file exists
    if (!existsSync(file)) {
      log.warn(`Skipping missing file: ${file}`);
      continue;
    }

    const html = readFileSync(file, "utf-8");
    const $ = load(html);
    const scriptNodes = $("script").get();

    if (scriptNodes.length === 0) continue;

    let modified = false;
    let scriptIndex = 0;

    for (const node of scriptNodes) {
      // Skip external scripts (those with src attribute)
      if (node.attribs && "src" in node.attribs) continue;

      const scriptContent =
        node.children && node.children[0] && node.children[0].data
          ? node.children[0].data.trim()
          : "";

      if (!scriptContent) continue;

      const attribs = Object.keys(node.attribs || {}).reduce(
        (a, c) => a + `${c}="${node.attribs[c]}" `,
        ""
      );

      const scriptHash = hash(scriptContent);
      const scriptFilename = `script-${scriptIndex}-${scriptHash}.js`;
      const scriptPath = join(directory, scriptFilename);

      // Make sure directory exists (avoid ENOENT)
      mkdirSync(dirname(scriptPath), { recursive: true });

      // Replace inline script with external file reference
      $(node).replaceWith(`<script ${attribs}src="/${scriptFilename}"></script>`);
      writeFileSync(scriptPath, scriptContent);
      log.success(`Extracted inline script -> ${scriptPath}`);

      modified = true;
      scriptIndex++;
    }

    if (modified) {
      writeFileSync(file, $.html());
      log.minor(`Rewrote HTML file: ${file}`);
    }
  }
}

function reWriteExtensionManifest(directory, manifest, builder) {
  const { log, getStaticDirectory, getClientDirectory, copy } = builder;
  log("Re-writing extension manifest");
  let sourceFilePath;
  if (typeof getStaticDirectory !== "undefined") {
    sourceFilePath = join(getStaticDirectory(), manifest);
  } else {
    sourceFilePath = join(getClientDirectory(), manifest);
  }
  if (existsSync(sourceFilePath)) {
    log.info("Extension manifest found");
    const res = copy(sourceFilePath, join(directory, "manifest.json"));
    log.success("Successfully re-wrote extension manifest");
  } else {
    log.error(
      `Extension manifest not found. Make sure you've added your extension manifest in your statics directory with the name ${manifest}`
    );
  }
}

/**
 * @param {string} directory
 */
async function compress(directory) {
  const files = await glob("**/*.{html,js,json,css,svg,xml}", {
    cwd: directory,
    dot: true,
    absolute: true,
    filesOnly: true,
  });

  await Promise.all(
    files.map((file) =>
      Promise.all([compress_file(file, "gz"), compress_file(file, "br")])
    )
  );
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file, format = "gz") {
  const compress =
    format == "br"
      ? zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]:
            zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size,
        },
      })
      : zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });

  const source = createReadStream(file);
  const destination = createWriteStream(`${file}.${format}`);

  await pipe(source, compress, destination);
}
