import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream';
import glob from 'tiny-glob';
import { promisify } from 'util';
import zlib from 'zlib';
import cheerio from 'cheerio';

const pipe = promisify(pipeline);

/** @type {import('.')} */
export default function ({ pages = 'build', assets = pages, fallback, precompress = false } = {}) {
  return {
    name: 'sveltekit-adapter-chrome-extension',

    async adapt(builder) {
      builder.rimraf(assets);
      builder.rimraf(pages);

      builder.writeStatic(assets);
      builder.writeClient(assets);

      await builder.prerender({
        fallback,
        all: !fallback,
        dest: pages
      });

      if (precompress) {
        if (pages === assets) {
          builder.log.minor('Compressing assets and pages');
          await compress(assets);
        } else {
          builder.log.minor('Compressing assets');
          await compress(assets);

          builder.log.minor('Compressing pages');
          await compress(pages);
        }
      }

      if (pages === assets) {
        builder.log(`Wrote site to "${pages}"`);
      } else {
        builder.log(`Wrote pages to "${pages}" and assets to "${assets}"`);
      }

      /* extension */
      await removeInlineScripts(assets, builder.log.minor);
    }
  };
}

/**
 * Hash using djb2
 * @param {import('types/hooks').StrictBody} value
 */
function hash(value) {
  let hash = 5381;
  let i = value.length;

  if (typeof value === 'string') {
    while (i) hash = (hash * 33) ^ value.charCodeAt(--i);
  } else {
    while (i) hash = (hash * 33) ^ value[--i];
  }

  return (hash >>> 0).toString(36);
}

async function removeInlineScripts(directory, log) {
  const files = await glob('**/*.{html}', {
    cwd: directory,
    dot: true,
    aboslute: true,
    filesOnly: true
  });

  files.map(f => join(directory, f))
    .forEach((file) => {
      const f = readFileSync(file);
      const $ = cheerio.load(f.toString());
      const innerScript = $('script[type="module"]').get()[0].children[0].data;
      const fullTag = $('script[type="module"]').toString();
      //get new filename
      const fn = `/script-${hash(innerScript)}}.js`;
      //remove from orig html file and replace with new script tag
      const newHtml = f.toString().replace(fullTag, `<script type="module" src="${fn}"></script>`);
      writeFileSync(file, newHtml);
      log(`rewrote ${file}`);
      
      const p = `${directory}${fn}`;
      writeFileSync(p, innerScript);
      log(`wrote ${p}`);
    });
}
/**
 * @param {string} directory
 */
async function compress(directory) {
  const files = await glob('**/*.{html,js,json,css,svg,xml}', {
    cwd: directory,
    dot: true,
    absolute: true,
    filesOnly: true
  });

  await Promise.all(
    files.map((file) => Promise.all([compress_file(file, 'gz'), compress_file(file, 'br')]))
  );
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file, format = 'gz') {
  const compress =
    format == 'br'
      ? zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size
        }
      })
      : zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });

  const source = createReadStream(file);
  const destination = createWriteStream(`${file}.${format}`);

  await pipe(source, compress, destination);
}
