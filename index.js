import { load } from "cheerio";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { pipeline } from "stream";
import glob from "tiny-glob";
import { promisify } from "util";
import zlib from "zlib";

const pipe = promisify(pipeline);

/** @type {import('.')} */
export default function ({
  pages = "build",
  assets = pages,
  fallback,
  precompress = false,
} = {}) {
  return {
    name: "sveltekit-adapter-chrome-extension",

    async adapt(builder) {
      builder.rimraf(assets);
      builder.rimraf(pages);

      builder.writeClient(assets);

      builder.writePrerendered(pages, { fallback });

      if (precompress) {
        if (pages === assets) {
          builder.log.minor("Compressing assets and pages");
          await compress(assets);
        } else {
          builder.log.minor("Compressing assets");
          await compress(assets);

          builder.log.minor("Compressing pages");
          await compress(pages);
        }
      }

      if (pages === assets) {
        builder.log(`Wrote site to "${pages}"`);
      } else {
        builder.log(`Wrote pages to "${pages}" and assets to "${assets}"`);
      }

      /* extension */
      await removeInlineScripts(assets, builder.log);

      await removeAppManifest(assets, builder.config.kit.appDir, builder.log);

      // operation required since generated app manifest will overwrite the static extension manifest.json
      reWriteExtensionManifest(assets, builder);
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
  const files = await glob(`**/${appDir}/manifest.json`, {
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
    aboslute: true,
    filesOnly: true,
  });

  files
    .map((f) => join(directory, f))
    .forEach((file) => {
      log.minor(`file: ${file}`);
      const f = readFileSync(file);
      const $ = load(f.toString());
      const node = $('script[type="module"]').get()[0];
      
      if (!node) return;
      if (Object.keys(node.attribs).includes("src")) return; // if there is a src, it's not an inline script

      const attribs = Object.keys(node.attribs).reduce(
        (a, c) => a + `${c}="${node.attribs[c]}" `,
        ""
      );
      const innerScript = node.children[0].data;
      const fullTag = $('script[type="module"]').toString();
      //get new filename
      const fn = `/script-${hash(innerScript)}.js`;
      //remove from orig html file and replace with new script tag
      const newHtml = f
        .toString()
        .replace(fullTag, `<script ${attribs} src="${fn}"></script>`);
      writeFileSync(file, newHtml);
      log.minor(`Rewrote ${file}`);

      const p = `${directory}${fn}`;
      writeFileSync(p, innerScript);
      log.success(`Inline script extracted and saved at: ${p}`);
    });
}

function reWriteExtensionManifest(directory, builder) {
  const { log, getStaticDirectory, copy } = builder;
  log("Re-writing extension manifest");
  const sourceFilePath = join(getStaticDirectory(), "manifest.json");
  if (existsSync(sourceFilePath)) {
    log.info("Extension manifest found");
    const res = copy(sourceFilePath, join(directory, "manifest.json"));
    log.success("Successfully re-wrote extension manifest");
  } else {
    log.error(
      "Extesion manifest not found. Make sure you've added your extension manifest in your statics directory with the name manifest.json"
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
