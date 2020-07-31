// https://github.com/googlefonts/tools/blob/master/experimental/make_kit.py
// https://github.com/filamentgroup/glyphhanger/blob/master/index.js

// Installation:
// pip install fonttools brotli zopfli

const childProcess = require('child_process');
const getTemporaryFilePath = require('gettemporaryfilepath');
const { readFile, writeFile, unlink } = require('fs').promises;
const execFile = require('util').promisify(childProcess.execFile);

try {
  childProcess.execSync('pyftsubset --help', { stdio: 'ignore' });
} catch (err) {
  throw new Error(
    'Subsetting tool not available. How to install: `pip install fonttools brotli zopfli`'
  );
}

const allowedFormats = ['truetype', 'woff', 'woff2'];

async function subsetLocalFont(
  inputBuffer,
  format,
  text,
  layoutFeatures
) {
  if (!allowedFormats.includes(format)) {
    throw new Error(
      `Invalid output format: \`${format}\`. Allowed formats: ${allowedFormats
        .map((t) => `\`${t}\``)
        .join(', ')}`
    );
  }

  text = text || '*';

  const tempInputFileName = getTemporaryFilePath({
    prefix: 'input-',
    suffix: `.${format}`,
  });
  const tempOutputFileName = getTemporaryFilePath({
    prefix: 'output-',
    suffix: `.${format}`,
  });

  const args = [
    tempInputFileName,
    `--output-file=${tempOutputFileName}`,
    '--obfuscate_names',
    `--text="${text.replace('"', '\\"')}"`,
  ];

  if (format === 'woff') {
    args.push('--with-zopfli');
  }

  if (format !== 'truetype') {
    args.push(`--flavor=${format}`);
  }

  if (layoutFeatures) {
    args.push(`--layout-features=${layoutFeatures}`);
  }

  try {
    await writeFile(tempInputFileName, inputBuffer);
    await execFile('pyftsubset', args);
    // Await to make sure the output file has been consumed before we delete it in the finally block below:
    return await readFile(tempOutputFileName);
  } catch (err) {
    if (
      err.message.includes(
        'fontTools.ttLib.TTLibError: Not a TrueType or OpenType font (not enough data)'
      )
    ) {
      throw new Error('Not a TrueType or OpenType font');
    }

    throw err;
  } finally {
    unlink(tempInputFileName).then(
      () => {},
      () => {}
    );
    unlink(tempOutputFileName).then(
      () => {},
      () => {}
    );
  }
}

module.exports = subsetLocalFont;
