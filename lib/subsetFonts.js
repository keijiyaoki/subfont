const _ = require('lodash');
const memoizeSync = require('memoizesync');
const urltools = require('urltools');

const fontTracer = require('font-tracer');
const fontSnapper = require('font-snapper');

const AssetGraph = require('assetgraph');
const compileQuery = require('assetgraph/lib/compileQuery');

const HeadlessBrowser = require('./HeadlessBrowser');
const gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
const getGoogleIdForFontProps = require('./getGoogleIdForFontProps');
const findCustomPropertyDefinitions = require('./findCustomPropertyDefinitions');
const extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
const stripLocalTokens = require('./stripLocalTokens');
const injectSubsetDefinitions = require('./injectSubsetDefinitions');
const cssFontParser = require('css-font-parser');
const cssListHelpers = require('css-list-helpers');
const LinesAndColumns = require('lines-and-columns').default;
const fontkit = require('fontkit');
const fontFamily = require('font-family-papandreou');
const crypto = require('crypto');

const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const getCssRulesByProperty = require('./getCssRulesByProperty');
const unicodeRange = require('./unicodeRange');
const convertFontBuffer = require('./convertFontBuffer');

const googleFontsCssUrlRegex = /^(?:https?:)?\/\/fonts\.googleapis\.com\/css/;

const initialValueByProp = _.pick(require('./initialValueByProp'), [
  'font-style',
  'font-weight',
  'font-stretch',
]);

function uniqueChars(text) {
  return [...new Set([...text])].sort().join('');
}

function cssQuoteIfNecessary(value) {
  if (/^\w+$/.test(value)) {
    return value;
  } else {
    return `'${value.replace(/'/g, "\\'")}'`;
  }
}

function getGoogleFontSubsetCssUrl(fontProps, text) {
  const googleFontId = getGoogleIdForFontProps(fontProps);

  return `https://fonts.googleapis.com/css?family=${googleFontId}&text=${encodeURIComponent(
    text
  )}`;
}

function getPreferredFontUrl(cssFontFaceSrcRelations = []) {
  const formatOrder = ['woff2', 'woff', 'truetype', 'opentype'];

  const typeOrder = ['Woff2', 'Woff', 'Ttf', 'Otf'];

  for (const format of formatOrder) {
    const relation = cssFontFaceSrcRelations.find(
      (r) => r.format && r.format.toLowerCase() === format
    );

    if (relation) {
      return relation.to.url;
    }
  }

  for (const assetType of typeOrder) {
    const relation = cssFontFaceSrcRelations.find(
      (r) => r.to.type === assetType
    );

    if (relation) {
      return relation.to.url;
    }
  }
}

// Hack to extract '@font-face { ... }' with all absolute urls
function getFontFaceDeclarationText(node, relations) {
  const originalHrefTypeByRelation = new Map();
  for (const relation of relations) {
    originalHrefTypeByRelation.set(relation.hrefType);
    relation.hrefType = 'absolute';
  }

  const text = node.toString();
  // Put the hrefTypes that were set to absolute back to their original state:
  for (const [
    relation,
    originalHrefType,
  ] of originalHrefTypeByRelation.entries()) {
    relation.hrefType = originalHrefType;
  }
  return text;
}

// Takes the output of fontTracer
function groupTextsByFontFamilyProps(
  textByPropsArray,
  availableFontFaceDeclarations
) {
  const snappedTexts = _.flatMapDeep(textByPropsArray, (textAndProps) => {
    const family = textAndProps.props['font-family'];
    if (family === undefined) {
      return [];
    }

    // Find all the families in the traced font-family that we have @font-face declarations for:
    const families = fontFamily
      .parse(family)
      .filter((family) =>
        availableFontFaceDeclarations.some(
          (fontFace) =>
            fontFace['font-family'].toLowerCase() === family.toLowerCase()
        )
      );

    return families.map((family) => {
      const activeFontFaceDeclaration = fontSnapper(
        availableFontFaceDeclarations,
        {
          ...textAndProps.props,
          'font-family': fontFamily.stringify([family]),
        }
      );

      if (!activeFontFaceDeclaration) {
        return [];
      }

      const { relations, ...props } = activeFontFaceDeclaration;
      const fontUrl = getPreferredFontUrl(relations);

      return {
        htmlAsset: textAndProps.htmlAsset,
        text: textAndProps.text,
        props,
        fontRelations: relations,
        fontUrl,
      };
    });
  }).filter((textByProps) => textByProps && textByProps.fontUrl);

  const textsByFontUrl = _.groupBy(snappedTexts, 'fontUrl');

  return _.map(textsByFontUrl, (textsPropsArray, fontUrl) => {
    const texts = textsPropsArray.map((obj) => obj.text);
    const fontFamilies = new Set(
      textsPropsArray.map((obj) => obj.props['font-family'])
    );

    let smallestOriginalSize;
    let smallestOriginalFormat;
    for (const relation of textsPropsArray[0].fontRelations) {
      if (relation.to.isLoaded) {
        const size = relation.to.rawSrc.length;
        if (smallestOriginalSize === undefined || size < smallestOriginalSize) {
          smallestOriginalSize = size;
          smallestOriginalFormat = relation.to.type.toLowerCase();
        }
      }
    }

    return {
      smallestOriginalSize,
      smallestOriginalFormat,
      pageText: uniqueChars(texts.join('')),
      props: { ...textsPropsArray[0].props },
      fontUrl,
      fontFamilies,
      preload: true,
    };
  });
}

function getParents(assetGraph, asset, assetQuery) {
  const assetMatcher = compileQuery(assetQuery);
  const seenAssets = new Set();
  const parents = [];
  (function visit(asset) {
    if (seenAssets.has(asset)) {
      return;
    }
    seenAssets.add(asset);

    for (const incomingRelation of asset.incomingRelations) {
      if (assetMatcher(incomingRelation.from)) {
        parents.push(incomingRelation.from);
      } else {
        visit(incomingRelation.from);
      }
    }
  })(asset);

  return parents;
}

function asyncLoadStyleRelationWithFallback(htmlAsset, originalRelation) {
  // Async load google font stylesheet
  // Insert async CSS loading <script>
  const asyncCssLoadingRelation = htmlAsset.addRelation(
    {
      type: 'HtmlScript',
      hrefType: 'inline',
      to: {
        type: 'JavaScript',
        text: `
          (function () {
            var el = document.createElement('link');
            el.href = '${htmlAsset.assetGraph.buildRootRelativeUrl(
              originalRelation.to.url,
              htmlAsset.url
            )}'.toString('url');
            el.rel = 'stylesheet';
            ${
              originalRelation.media
                ? `el.media = '${originalRelation.media}';`
                : ''
            }
            document.body.appendChild(el);
          }())
        `,
      },
    },
    'lastInBody'
  );

  // Insert <noscript> fallback sync CSS loading
  const noScriptFallbackRelation = htmlAsset.addRelation(
    {
      type: 'HtmlNoscript',
      to: {
        type: 'Html',
        text: '',
      },
    },
    'lastInBody'
  );

  noScriptFallbackRelation.to.addRelation(
    {
      type: 'HtmlStyle',
      media: originalRelation.media,
      to: originalRelation.to,
      hrefType: 'rootRelative',
    },
    'last'
  );

  noScriptFallbackRelation.inline();
  asyncCssLoadingRelation.to.minify();
  htmlAsset.markDirty();
}

function getSubsetPromiseId(text, fontUrl, format) {
  return [text, fontUrl, format].join('\x1d');
}

async function getSubsetsForFontUsage(
  assetGraph,
  htmlAssetTextsWithProps,
  formats,
  harfbuzz,
  layoutFeatures
) {
  let subsetLocalFont;

  if (harfbuzz) {
    subsetLocalFont = require('./subsetLocalFontWithHarfbuzz');
  } else {
    try {
      subsetLocalFont = require('./subsetLocalFont');
    } catch (err) {}
  }

  const allFonts = [];

  for (const item of htmlAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) {
        continue;
      }

      if (!allFonts.includes(fontUsage.fontUrl)) {
        allFonts.push(fontUsage.fontUrl);
      }
    }
  }

  if (subsetLocalFont) {
    await assetGraph.populate({
      followRelations: {
        to: { url: { $or: allFonts } },
      },
    });

    const originalFontBuffers = allFonts.reduce((result, fontUrl) => {
      const fontAsset = assetGraph.findAssets({
        url: fontUrl,
        isLoaded: true,
      })[0];

      if (fontAsset) {
        result[fontUrl] = fontAsset.rawSrc;
      }

      return result;
    }, {});

    const subsetPromiseMap = {};
    const globalFontUsages = htmlAssetTextsWithProps.globalFontUsages;

    for (const item of htmlAssetTextsWithProps) {
      for (const fontUsage of item.fontUsages) {
        const fontBuffer = originalFontBuffers[fontUsage.fontUrl];
        const text = (globalFontUsages) ?
              globalFontUsages[fontUsage.fontUrl].text :
              fontUsage.pageText;
        for (const format of formats) {
          const promiseId = getSubsetPromiseId(text, fontUsage.fontUrl, format);

          if (!subsetPromiseMap[promiseId]) {
            subsetPromiseMap[promiseId] = subsetLocalFont(
              fontBuffer,
              format,
              text,
              layoutFeatures
            ).catch((err) => {
              const error = new Error(err.message);
              error.asset = assetGraph.findAssets({
                url: fontUsage.fontUrl,
              })[0];

              assetGraph.warn(error);
            });
          }

          subsetPromiseMap[promiseId].then((fontBuffer) => {
            if (fontBuffer) {
              if (!fontUsage.subsets) {
                fontUsage.subsets = {};
              }
              fontUsage.subsets[format] = fontBuffer;
              const size = fontBuffer.length;
              if (
                !fontUsage.smallestSubsetSize ||
                size < fontUsage.smallestSubsetSize
              ) {
                fontUsage.smallestSubsetSize = size;
                fontUsage.smallestSubsetFormat = format;
              }
            }
          });
        }
      }
    }

    await Promise.all(Object.values(subsetPromiseMap));
  } else {
    const localFonts = [];
    const fontCssUrlMap = {};

    for (const item of htmlAssetTextsWithProps) {
      for (const fontUsage of item.fontUsages) {
        if (!fontUsage.fontUrl) {
          continue;
        }

        const fontAsset = assetGraph.findAssets({ url: fontUsage.fontUrl })[0];

        if (fontAsset.hostname !== 'fonts.gstatic.com') {
          localFonts.push(fontAsset);
          continue;
        }

        const mapId = getSubsetPromiseId(fontUsage, 'truetype');

        if (!fontCssUrlMap[mapId]) {
          fontCssUrlMap[mapId] = `${getGoogleFontSubsetCssUrl(
            fontUsage.props,
            fontUsage.text
          )}`;
        }
      }
    }

    if (localFonts.length > 0) {
      const localFontDescriptions = localFonts
        .map((a) => ` - ${a.urlOrDescription}`)
        .join('\n');
      assetGraph.info(
        new Error(
          `Local subsetting is not possible because fonttools are not installed. Falling back to only subsetting Google Fonts. Run \`pip install fonttools brotli zopfli\` to enable local font subsetting`
        )
      );
      assetGraph.info(
        new Error(`Unoptimised fonts:\n${localFontDescriptions}`)
      );
    }

    const assetGraphForLoadingFonts = new AssetGraph();

    const formatUrls = _.uniq(Object.values(fontCssUrlMap));
    await assetGraphForLoadingFonts.loadAssets(Object.values(formatUrls));

    await assetGraphForLoadingFonts.populate({
      followRelations: {
        type: 'CssFontFaceSrc',
      },
    });

    for (const item of htmlAssetTextsWithProps) {
      for (const fontUsage of item.fontUsages) {
        for (const format of formats) {
          const cssUrl =
            fontCssUrlMap[getSubsetPromiseId(fontUsage, 'truetype')];
          const cssAsset = assetGraphForLoadingFonts.findAssets({
            url: cssUrl,
            isLoaded: true,
          })[0];
          if (cssAsset) {
            const fontRelation = cssAsset.outgoingRelations[0];
            const fontAsset = fontRelation.to;

            if (fontAsset.isLoaded) {
              if (!fontUsage.subsets) {
                fontUsage.subsets = {};
              }

              const buffer = await convertFontBuffer(
                fontAsset.rawSrc,
                format,
                'truetype'
              );

              fontUsage.subsets[format] = buffer;
              const size = buffer.length;
              if (
                !fontUsage.smallestSubsetSize ||
                size < fontUsage.smallestSubsetSize
              ) {
                fontUsage.smallestSubsetSize = size;
                fontUsage.smallestSubsetFormat = format;
              }
            }
          }
        }
      }
    }
  }
}

const fontContentTypeMap = {
  woff: 'font/woff', // https://tools.ietf.org/html/rfc8081#section-4.4.5
  woff2: 'font/woff2',
  truetype: 'font/ttf',
};

const fontOrder = ['woff2', 'woff', 'truetype'];

function getFontFaceForFontUsage(fontUsage) {
  const subsets = fontOrder
    .filter((format) => fontUsage.subsets[format])
    .map((format) => ({
      format,
      url: `data:${fontContentTypeMap[format]};base64,${fontUsage.subsets[
        format
      ].toString('base64')}`,
    }));

  const resultString = ['@font-face {'];

  resultString.push(
    ...Object.keys(fontUsage.props)
      .sort()
      .map((prop) => {
        let value = fontUsage.props[prop];

        if (prop === 'font-family') {
          value = cssQuoteIfNecessary(`${value}__subset`);
        }

        if (prop === 'src') {
          value = subsets
            .map((subset) => `url(${subset.url}) format('${subset.format}')`)
            .join(', ');
        }

        return `${prop}: ${value};`;
      })
      .map((str) => `  ${str}`)
  );

  resultString.push(
    `  unicode-range: ${unicodeRange(fontUsage.codepoints.used)};`
  );

  resultString.push('}');

  return resultString.join('\n');
}

function getUnusedVariantsStylesheet(
  fontUsages,
  accumulatedFontFaceDeclarations
) {
  // Find the available @font-face declarations where the font-family is used
  // (so there will be subsets created), but the specific variant isn't used.
  return accumulatedFontFaceDeclarations
    .filter(
      (decl) =>
        fontUsages.some((fontUsage) =>
          fontUsage.fontFamilies.has(decl['font-family'])
        ) &&
        !fontUsages.some(
          ({ props }) =>
            props['font-style'] === decl['font-style'] &&
            props['font-weight'] === decl['font-weight'] &&
            props['font-stretch'] === decl['font-stretch'] &&
            props['font-family'].toLowerCase() ===
              decl['font-family'].toLowerCase()
        )
    )
    .map((props) => {
      let src = stripLocalTokens(props.src);
      if (props.relations.length > 0) {
        const targets = props.relations.map((relation) => relation.to.url);
        src = src.replace(
          props.relations[0].tokenRegExp,
          () => `url('${targets.shift().replace(/'/g, "\\'")}')`
        );
      }
      return `@font-face{font-family:${props['font-family']}__subset;font-stretch:${props['font-stretch']};font-style:${props['font-style']};font-weight:${props['font-weight']};src:${src}}`;
    })
    .join('\n\n');
}

function getFontUsageStylesheet(fontUsages) {
  return fontUsages
    .filter((fontUsage) => fontUsage.subsets)
    .map((fontUsage) => getFontFaceForFontUsage(fontUsage))
    .join('\n\n');
}

const extensionByFormat = {
  truetype: '.ttf',
  woff: '.woff',
  woff2: '.woff2',
};

function md5HexPrefix(stringOrBuffer) {
  return crypto
    .createHash('md5')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}

async function createSelfHostedGoogleFontsCssAsset(
  assetGraph,
  googleFontsCssAsset,
  formats
) {
  const lines = [];
  for (const cssFontFaceSrc of assetGraph.findRelations({
    from: googleFontsCssAsset,
    type: 'CssFontFaceSrc',
  })) {
    lines.push(`@font-face {`);
    const fontFaceDeclaration = cssFontFaceSrc.node;
    fontFaceDeclaration.walkDecls((declaration) => {
      const propName = declaration.prop.toLowerCase();
      if (propName !== 'src') {
        lines.push(`  ${propName}: ${declaration.value};`);
      }
    });
    const srcFragments = [];
    for (const format of formats) {
      const rawSrc = await convertFontBuffer(cssFontFaceSrc.to.rawSrc, format);
      const url = `/subfont/${cssFontFaceSrc.to.baseName}-${md5HexPrefix(
        rawSrc
      )}${extensionByFormat[format]}`;
      const fontAsset =
        assetGraph.findAssets({ url })[0] ||
        (await assetGraph.addAsset({
          url,
          rawSrc,
        }));
      srcFragments.push(
        `url(${assetGraph.buildRootRelativeUrl(
          fontAsset.url
        )}) format('${format}')`
      );
    }
    lines.push(`  src: ${srcFragments.join(', ')};`, '}');
    lines.push(
      `  unicode-range: ${unicodeRange(
        fontkit.create(cssFontFaceSrc.to.rawSrc).characterSet
      )};`
    );
  }
  const text = lines.join('\n');
  const fallbackAsset = assetGraph.addAsset({
    type: 'Css',
    url: `/subfont/fallback-${md5HexPrefix(text)}.css`,
    text,
  });
  return fallbackAsset;
}

const validFontDisplayValues = [
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
];

function getCodepoints(text) {
  const codepoints = text.split('').map((c) => c.codePointAt(0));

  if (!codepoints.includes(32)) {
    // Make sure that space is always part of the subset fonts (and that it's announced in unicode-range).
    // Prevents Chrome from going off and downloading the fallback:
    // https://gitter.im/assetgraph/assetgraph?at=5f01f6e13a0d3931fad4021b
    codepoints.push(32);
  }
  return codepoints;
}

async function subsetFonts(
  assetGraph,
  {
    formats = ['woff2', 'woff'],
    subsetPath = 'subfont/',
    omitFallbacks = false,
    subsetPerPage,
    inlineFonts,
    inlineCss,
    fontDisplay,
    onlyInfo,
    dynamic,
    console = global.console,
    harfbuzz,
    layoutFeatures,
  } = {}
) {
  if (!validFontDisplayValues.includes(fontDisplay)) {
    fontDisplay = undefined;
  }

  const htmlAssetTextsWithProps = [];
  const subsetUrl = urltools.ensureTrailingSlash(assetGraph.root + subsetPath);

  await assetGraph.applySourceMaps({ type: 'Css' });

  await assetGraph.populate({
    followRelations: {
      $or: [
        {
          to: {
            url: googleFontsCssUrlRegex,
          },
        },
        {
          type: 'CssFontFaceSrc',
          from: {
            url: googleFontsCssUrlRegex,
          },
        },
      ],
    },
  });

  // Collect texts by page
  const inlineCssMap = new Map();
  const _gatherStylesheetsWithPredicates = (...args) => {
    return gatherStylesheetsWithPredicates(inlineCssMap, ...args);
  };
  const _getCssRulesByProperty = (...args) => {
    return getCssRulesByProperty(inlineCssMap, ...args);
  };

  const memoizedGetCssRulesByProperty = memoizeSync(_getCssRulesByProperty);
  const htmlAssets = assetGraph.findAssets({ type: 'Html', isInline: false });
  const traversalRelationQuery = {
    $or: [
      {
        type: { $in: ['HtmlStyle', 'CssImport'] },
      },
      {
        to: {
          type: 'Html',
          isInline: true,
        },
      },
    ],
  };

  // Keep track of the injected CSS assets that should eventually be minified
  // Minifying them along the way currently doesn't work because some of the
  // manipulation is sensitive to the exact text contents. We should fix that.
  const subsetFontsToBeMinified = new Set();
  const fontFaceDeclarationsByHtmlAsset = new Map();
  const potentiallyOrphanedAssets = new Set();

  const headlessBrowser = dynamic && new HeadlessBrowser({ console });
  try {
    for (const htmlAsset of htmlAssets) {
      const accumulatedFontFaceDeclarations = [];
      fontFaceDeclarationsByHtmlAsset.set(
        htmlAsset,
        accumulatedFontFaceDeclarations
      );
      assetGraph.eachAssetPreOrder(
        htmlAsset,
        traversalRelationQuery,
        (asset) => {
          if (asset.type === 'Css' && asset.isLoaded) {
            const seenNodes = new Set();

            const fontRelations = asset.outgoingRelations.filter(
              (relation) => relation.type === 'CssFontFaceSrc'
            );

            for (const fontRelation of fontRelations) {
              const node = fontRelation.node;

              if (!seenNodes.has(node)) {
                seenNodes.add(node);

                const fontFaceDeclaration = {
                  relations: fontRelations.filter((r) => r.node === node),
                  ...initialValueByProp,
                };

                node.walkDecls((declaration) => {
                  const propName = declaration.prop.toLowerCase();
                  if (propName === 'font-family') {
                    fontFaceDeclaration[propName] = unquote(declaration.value);
                  } else {
                    fontFaceDeclaration[propName] = declaration.value;
                  }
                });
                // Disregard incomplete @font-face declarations (must contain font-family and src per spec):
                if (
                  fontFaceDeclaration['font-family'] &&
                  fontFaceDeclaration.src
                ) {
                  accumulatedFontFaceDeclarations.push(fontFaceDeclaration);
                }
              }
            }
          }
        }
      );

      if (accumulatedFontFaceDeclarations.length > 0) {
        const seenFontFaceCombos = new Set();
        for (const fontFace of accumulatedFontFaceDeclarations) {
          const key = `${fontFace['font-family']}/${fontFace['font-style']}/${fontFace['font-weight']}`;
          if (seenFontFaceCombos.has(key)) {
            throw new Error(
              `Multiple @font-face with the same font-family/font-style/font-weight (maybe with different unicode-range?) is not supported yet: ${key}`
            );
          }
          seenFontFaceCombos.add(key);
        }

        const textByProps = fontTracer(htmlAsset.parseTree, {
          stylesheetsWithPredicates: _gatherStylesheetsWithPredicates(
            htmlAsset.assetGraph,
            htmlAsset
          ),
          getCssRulesByProperty: memoizedGetCssRulesByProperty,
          htmlAsset,
        });
        if (headlessBrowser) {
          textByProps.push(...(await headlessBrowser.tracePage(htmlAsset)));
        }
        htmlAssetTextsWithProps.push({
          htmlAsset,
          textByProps,
          accumulatedFontFaceDeclarations,
        });
      }
    }
  } finally {
    if (headlessBrowser) {
      await headlessBrowser.close();
    }
  }

  inlineCssMap.clear();
  memoizedGetCssRulesByProperty.purgeAll();

  const globalFontTextMap = new Map();
  for (const htmlAssetTextsWithPropsEntry of htmlAssetTextsWithProps) {
    const {
      textByProps,
      accumulatedFontFaceDeclarations,
    } = htmlAssetTextsWithPropsEntry;
    const fontUsages = groupTextsByFontFamilyProps(
      textByProps,
      accumulatedFontFaceDeclarations
    );
    htmlAssetTextsWithPropsEntry.fontUsages = fontUsages;

    if (!subsetPerPage) {
      for (const fontUsage of fontUsages) {
        const globalFontText = globalFontTextMap.get(fontUsage.fontUrl);
        if (!globalFontText) {
          globalFontTextMap.set(fontUsage.fontUrl, [ fontUsage.pageText ]);
        } else {
          globalFontText.push(fontUsage.pageText);
        }
      }
    }
  }

  if (!subsetPerPage) {
    const globalFontUsages = {}
    for (const [ fontUrl, texts ] of globalFontTextMap.entries()) {
      const text = uniqueChars(texts.join(''));
      const codepoints = getCodepoints(text);
      globalFontUsages[fontUrl] = {
        text,
        codepoints
      };
    }
    htmlAssetTextsWithProps.globalFontUsages = globalFontUsages;
  }

  if (omitFallbacks) {
    for (const htmlAsset of htmlAssets) {
      const accumulatedFontFaceDeclarations = fontFaceDeclarationsByHtmlAsset.get(
        htmlAsset
      );
      // Remove the original @font-face rules:
      for (const { relations } of accumulatedFontFaceDeclarations) {
        for (const relation of relations) {
          potentiallyOrphanedAssets.add(relation.to);
          if (relation.node.parentNode) {
            relation.node.parentNode.removeChild(relation.node);
          }
          relation.remove();
        }
      }
      htmlAsset.markDirty();
    }
  }

  if (fontDisplay) {
    for (const htmlAssetTextWithProps of htmlAssetTextsWithProps) {
      for (const fontUsage of htmlAssetTextWithProps.fontUsages) {
        fontUsage.props['font-display'] = fontDisplay;
      }
    }
  }

  // Generate codepoint sets for original font, the used subset and the unused subset
  const seenCharacterMap = new Map();

  for (const htmlAssetTextWithProps of htmlAssetTextsWithProps) {
    for (const fontUsage of htmlAssetTextWithProps.fontUsages) {
      const originalFont = assetGraph.findAssets({
        url: fontUsage.fontUrl,
      })[0];
      if (originalFont.isLoaded) {
        const mappedCodepoints = seenCharacterMap.get(originalFont.rawSrc);
        let originalCodepoints;
        try {
          // Guard against 'Unknown font format' errors
          originalCodepoints = mappedCodepoints || fontkit.create(originalFont.rawSrc).characterSet;
        } catch (err) {}
        if (originalCodepoints) {
          if (!mappedCodepoints) {
            seenCharacterMap.set(originalFont.rawSrc, originalCodepoints);
          }
          const page = getCodepoints(fontUsage.pageText);
          const used = (subsetPerPage) ?
                page :
                htmlAssetTextsWithProps.globalFontUsages[fontUsage.fontUrl].codepoints;

          fontUsage.codepoints = {
            original: originalCodepoints,
            used,
            page,
          };
        }
      }
    }
  }

  if (onlyInfo) {
    return {
      fontInfo: htmlAssetTextsWithProps.map(({ fontUsages, htmlAsset }) => ({
        htmlAsset: htmlAsset.urlOrDescription,
        fontUsages: fontUsages,
      })),
    };
  }

  // Generate subsets:
  await getSubsetsForFontUsage(
    assetGraph,
    htmlAssetTextsWithProps,
    formats,
    harfbuzz,
    layoutFeatures
  );

  // Warn about missing glyphs
  const missingGlyphsErrors = [];

  for (const {
    htmlAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (fontUsage.subsets) {
        const subset = Object.values(fontUsage.subsets)[0];
        const mappedCharacterSet = ((!subsetPerPage) ?
                                    seenCharacterMap.get(subset) : null);
        const characterSet = (mappedCharacterSet ||
                              fontkit.create(subset).characterSet);

        if (!subsetPerPage && !mappedCharacterSet) {
          seenCharacterMap.set(subset, characterSet);
        }

        let missedAny = false;
        for (const char of [...fontUsage.pageText]) {
          // Turns out that browsers don't mind that these are missing:
          if (char === '\t' || char === '\n') {
            continue;
          }

          const codePoint = char.codePointAt(0);

          const isMissing = !characterSet.includes(codePoint);

          if (isMissing) {
            let location;
            const charIdx = htmlAsset.text.indexOf(char);

            if (charIdx === -1) {
              location = `${htmlAsset.urlOrDescription} (generated content)`;
            } else {
              const position = new LinesAndColumns(
                htmlAsset.text
              ).locationForIndex(charIdx);
              location = `${htmlAsset.urlOrDescription}:${position.line + 1}:${
                position.column + 1
              }`;
            }

            missingGlyphsErrors.push({
              codePoint,
              char,
              htmlAsset,
              fontUsage,
              location,
            });
            missedAny = true;
          }
        }
        if (missedAny) {
          const fontFaces = accumulatedFontFaceDeclarations.filter((fontFace) =>
            fontUsage.fontFamilies.has(fontFace['font-family'])
          );
          for (const fontFace of fontFaces) {
            const cssFontFaceSrc = fontFace.relations[0];
            const fontFaceDeclaration = cssFontFaceSrc.node;
            if (
              !fontFaceDeclaration.some((node) => node.prop === 'unicode-range')
            ) {
              fontFaceDeclaration.append({
                prop: 'unicode-range',
                value: unicodeRange(fontUsage.codepoints.original),
              });
              cssFontFaceSrc.from.markDirty();
            }
          }
        }
      }
    }
  }

  if (missingGlyphsErrors.length) {
    const errorLog = missingGlyphsErrors.map(
      ({ char, fontUsage, location }) =>
        `- \\u{${char.charCodeAt(0).toString(16)}} (${char}) in font-family '${
          fontUsage.props['font-family']
        }' (${fontUsage.props['font-weight']}/${
          fontUsage.props['font-style']
        }) at ${location}`
    );

    const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

    assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
  }

  // Insert subsets:

  let numFontUsagesWithSubset = 0;
  for (const {
    htmlAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlAssetTextsWithProps) {
    const insertionPoint = assetGraph.findRelations({
      type: 'HtmlStyle',
      from: htmlAsset,
    })[0];
    const subsetFontUsages = fontUsages.filter(
      (fontUsage) => fontUsage.subsets
    );
    const unsubsettedFontUsages = fontUsages.filter(
      (fontUsage) => !subsetFontUsages.includes(fontUsage)
    );

    // Remove all existing preload hints to fonts that might have new subsets
    for (const fontUsage of fontUsages) {
      for (const relation of assetGraph.findRelations({
        type: { $in: ['HtmlPrefetchLink', 'HtmlPreloadLink'] },
        from: htmlAsset,
        to: {
          url: fontUsage.fontUrl,
        },
      })) {
        if (relation.type === 'HtmlPrefetchLink') {
          const err = new Error(
            `Detached ${relation.node.outerHTML}. Will be replaced with preload with JS fallback.\nIf you feel this is wrong, open an issue at https://github.com/Munter/subfont/issues`
          );
          err.asset = relation.from;
          err.relation = relation;

          assetGraph.info(err);
        }

        relation.detach();
      }
    }

    const unsubsettedFontUsagesToPreload = unsubsettedFontUsages.filter(
      (fontUsage) => fontUsage.preload
    );

    if (unsubsettedFontUsagesToPreload.length > 0) {
      // Insert <link rel="preload">
      const preloadRelations = unsubsettedFontUsagesToPreload.map(
        (fontUsage) => {
          // Always preload unsubsetted font files, they might be any format, so can't be clever here
          return htmlAsset.addRelation(
            {
              type: 'HtmlPreloadLink',
              hrefType: 'rootRelative',
              to: fontUsage.fontUrl,
              as: 'font',
            },
            'before',
            insertionPoint
          );
        }
      );

      // Generate JS fallback for browser that don't support <link rel="preload">
      const preloadData = unsubsettedFontUsagesToPreload.map(
        (fontUsage, idx) => {
          const preloadRelation = preloadRelations[idx];

          const formatMap = {
            '.woff': 'woff',
            '.woff2': 'woff2',
            '.ttf': 'truetype',
            '.svg': 'svg',
            '.eot': 'embedded-opentype',
          };
          const name = fontUsage.props['font-family'];
          const props = Object.keys(initialValueByProp).reduce(
            (result, prop) => {
              if (
                fontUsage.props[prop] !==
                normalizeFontPropertyValue(prop, initialValueByProp[prop])
              ) {
                result[prop] = fontUsage.props[prop];
              }
              return result;
            },
            {}
          );

          return `new FontFace(
            "${name}",
            "url('" + "${preloadRelation.href}".toString('url') + "') format('${
            formatMap[preloadRelation.to.extension]
          }')",
            ${JSON.stringify(props)}
          ).load().then(void 0, function () {});`;
        }
      );

      const originalFontJsPreloadAsset = htmlAsset.addRelation(
        {
          type: 'HtmlScript',
          hrefType: 'inline',
          to: {
            type: 'JavaScript',
            text: `try{${preloadData.join('')}}catch(e){}`,
          },
        },
        'before',
        insertionPoint
      ).to;

      for (const [
        idx,
        relation,
      ] of originalFontJsPreloadAsset.outgoingRelations.entries()) {
        relation.hrefType = 'rootRelative';
        relation.to = preloadRelations[idx].to;
        relation.refreshHref();
      }

      originalFontJsPreloadAsset.minify();
    }

    if (subsetFontUsages.length === 0) {
      continue;
    }
    numFontUsagesWithSubset += subsetFontUsages.length;

    let subsetCssText = getFontUsageStylesheet(subsetFontUsages);
    const unusedVariantsCss = getUnusedVariantsStylesheet(
      fontUsages,
      accumulatedFontFaceDeclarations
    );
    if (!inlineCss && !omitFallbacks) {
      // This can go into the same stylesheet because we won't reload all __subset suffixed families in the JS preload fallback
      subsetCssText += unusedVariantsCss;
    }

    let cssAsset = assetGraph.addAsset({
      type: 'Css',
      url: `${subsetUrl}subfontTemp.css`,
      text: subsetCssText,
    });

    subsetFontsToBeMinified.add(cssAsset);

    if (!inlineFonts) {
      for (const fontRelation of cssAsset.outgoingRelations) {
        const fontAsset = fontRelation.to;
        if (!fontAsset.isLoaded) {
          // An unused variant that does not exist, don't try to hash
          fontRelation.hrefType = 'rootRelative';
          continue;
        }
        const extension = fontAsset.contentType.split('/').pop();

        const nameProps = ['font-family', 'font-weight', 'font-style']
          .map((prop) =>
            fontRelation.node.nodes.find((decl) => decl.prop === prop)
          )
          .map((decl) => decl.value);

        const fontWeightRangeStr = nameProps[1]
          .split(/\s+/)
          .map((token) => normalizeFontPropertyValue('font-weight', token))
          .join('_');
        const fileNamePrefix = `${unquote(nameProps[0])
          .replace(/__subset$/, '')
          .replace(/ /g, '_')}-${fontWeightRangeStr}${
          nameProps[2] === 'italic' ? 'i' : ''
        }`;

        const fontFileName = `${fileNamePrefix}-${fontAsset.md5Hex.slice(
          0,
          10
        )}.${extension}`;

        // If it's not inline, it's one of the unused variants that gets a mirrored declaration added
        // for the __subset @font-face. Do not move it to /subfont/
        if (fontAsset.isInline) {
          const fontAssetUrl = subsetUrl + fontFileName;
          const existingFontAsset = assetGraph.findAssets({
            url: fontAssetUrl,
          })[0];
          if (existingFontAsset && fontAsset.isInline) {
            fontRelation.to = existingFontAsset;
            assetGraph.removeAsset(fontAsset);
          } else {
            fontAsset.url = subsetUrl + fontFileName;
          }
        }

        fontRelation.hrefType = 'rootRelative';
      }
    }

    const cssAssetUrl = `${subsetUrl}fonts-${cssAsset.md5Hex.slice(0, 10)}.css`;
    const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
    if (existingCssAsset) {
      assetGraph.removeAsset(cssAsset);
      subsetFontsToBeMinified.delete(cssAsset);
      cssAsset = existingCssAsset;
    } else {
      cssAsset.url = cssAssetUrl;
    }

    if (!inlineFonts) {
      for (const fontRelation of cssAsset.outgoingRelations) {
        const fontAsset = fontRelation.to;

        if (
          fontAsset.contentType === 'font/woff2' &&
          fontRelation.href.startsWith('/subfont/')
        ) {
          const fontFaceDeclaration = fontRelation.node;
          const originalFontFamily = unquote(
            fontFaceDeclaration.nodes.find(
              (node) => node.prop === 'font-family'
            ).value
          ).replace(/__subset$/, '');
          if (
            !fontUsages.some(
              (fontUsage) =>
                fontUsage.fontFamilies.has(originalFontFamily) &&
                fontUsage.preload
            )
          ) {
            continue;
          }

          // Only <link rel="preload"> for woff2 files
          // Preload support is a subset of woff2 support:
          // - https://caniuse.com/#search=woff2
          // - https://caniuse.com/#search=preload

          htmlAsset.addRelation(
            {
              type: 'HtmlPreloadLink',
              hrefType: 'rootRelative',
              to: fontAsset,
              as: 'font',
            },
            'before',
            insertionPoint
          );
        }
      }
    }
    const cssRelation = htmlAsset.addRelation(
      {
        type: 'HtmlStyle',
        hrefType: inlineCss ? 'inline' : 'rootRelative',
        to: cssAsset,
      },
      'before',
      insertionPoint
    );

    let cssAssetInsertion = cssRelation;
    if (!inlineFonts) {
      // JS-based font preloading for browsers without <link rel="preload"> support
      const fontFaceContructorCalls = [];

      cssAsset.parseTree.walkAtRules('font-face', (rule) => {
        let name;
        let url;
        const props = {};

        rule.walkDecls(({ prop, value }) => {
          const propName = prop.toLowerCase();
          if (propName === 'font-weight') {
            value = value
              .split(/\s+/)
              .map((token) => normalizeFontPropertyValue('font-weight', token))
              .join(' ');
            if (/^\d+$/.test(value)) {
              value = parseInt(value, 10);
            }
          }

          if (propName in initialValueByProp) {
            if (
              normalizeFontPropertyValue(propName, value) !==
              normalizeFontPropertyValue(propName, initialValueByProp[propName])
            ) {
              props[propName] = value;
            }
          }

          if (propName === 'font-family') {
            name = unquote(value);
          } else if (propName === 'src') {
            const fontRelations = cssAsset.outgoingRelations.filter(
              (relation) => relation.node === rule
            );
            const urlStrings = value.split(/,\s*/).filter(
              (entry) => entry.startsWith('url(') && entry.includes('/subfont/') // Avoid preloading unused variants
            );
            const urlValues = urlStrings.map((urlString, idx) =>
              urlString.replace(
                fontRelations[idx].href,
                '" + "/__subfont__".toString("url") + "'
              )
            );
            if (urlValues.length > 0) {
              url = `"${urlValues.join(', ')}"`;
            }
          }
        });

        if (url) {
          const originalFontFamily = name.replace(/__subset$/, '');
          if (
            fontUsages.some(
              (fontUsage) =>
                fontUsage.fontFamilies.has(originalFontFamily) &&
                fontUsage.preload
            )
          ) {
            fontFaceContructorCalls.push(
              `new FontFace("${name}", ${url}, ${JSON.stringify(
                props
              )}).load();`
            );
          }
        }
      });

      const jsPreloadRelation = htmlAsset.addRelation(
        {
          type: 'HtmlScript',
          hrefType: 'inline',
          to: {
            type: 'JavaScript',
            text: `try {${fontFaceContructorCalls.join('')}} catch (e) {}`,
          },
        },
        'before',
        cssRelation
      );

      for (const [
        idx,
        relation,
      ] of jsPreloadRelation.to.outgoingRelations.entries()) {
        potentiallyOrphanedAssets.add(relation.to);
        relation.to = cssAsset.outgoingRelations[idx].to;
        relation.hrefType = 'rootRelative';
        relation.refreshHref();
      }

      jsPreloadRelation.to.minify();
      cssAssetInsertion = jsPreloadRelation;
    }

    if (!omitFallbacks && inlineCss && unusedVariantsCss) {
      // The fallback CSS for unused variants needs to go into its own stylesheet after the crude version of the JS-based preload "polyfill"
      const cssAsset = htmlAsset.addRelation(
        {
          type: 'HtmlStyle',
          to: {
            type: 'Css',
            text: unusedVariantsCss,
          },
        },
        'after',
        cssAssetInsertion
      ).to;
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = 'rootRelative';
      }
    }
  }

  if (numFontUsagesWithSubset === 0) {
    return { fontInfo: [] };
  }

  const relationsToRemove = new Set();

  // Lazy load the original @font-face declarations of self-hosted fonts (unless omitFallbacks)
  const originalRelations = new Set();
  for (const htmlAsset of htmlAssets) {
    const accumulatedFontFaceDeclarations = fontFaceDeclarationsByHtmlAsset.get(
      htmlAsset
    );
    // TODO: Maybe group by media?
    const containedRelationsByFontFaceRule = new Map();
    for (const { relations } of accumulatedFontFaceDeclarations) {
      for (const relation of relations) {
        if (
          relation.from.hostname === 'fonts.googleapis.com' || // Google Web Fonts handled separately below
          containedRelationsByFontFaceRule.has(relation.node)
        ) {
          continue;
        }
        originalRelations.add(relation);
        containedRelationsByFontFaceRule.set(
          relation.node,
          relation.from.outgoingRelations.filter(
            (otherRelation) => otherRelation.node === relation.node
          )
        );
      }
    }

    if (containedRelationsByFontFaceRule.size > 0 && !omitFallbacks) {
      let cssAsset = assetGraph.addAsset({
        type: 'Css',
        text: [...containedRelationsByFontFaceRule.keys()]
          .map((rule) =>
            getFontFaceDeclarationText(
              rule,
              containedRelationsByFontFaceRule.get(rule)
            )
          )
          .join(''),
      });
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = 'rootRelative';
      }
      const cssAssetUrl = `${subsetUrl}fallback-${cssAsset.md5Hex.slice(
        0,
        10
      )}.css`;
      const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
      if (existingCssAsset) {
        assetGraph.removeAsset(cssAsset);
        cssAsset = existingCssAsset;
      } else {
        subsetFontsToBeMinified.add(cssAsset);
        cssAsset.url = cssAssetUrl;
      }

      // Create a <link rel="stylesheet"> that asyncLoadStyleRelationWithFallback can convert to async with noscript fallback:
      const fallbackHtmlStyle = htmlAsset.addRelation({
        type: 'HtmlStyle',
        to: cssAsset,
      });

      asyncLoadStyleRelationWithFallback(htmlAsset, fallbackHtmlStyle);
      relationsToRemove.add(fallbackHtmlStyle);
    }
  }

  // Remove the original @font-face blocks, and don't leave behind empty stylesheets:
  const maybeEmptyCssAssets = new Set();
  for (const relation of originalRelations) {
    const cssAsset = relation.from;
    if (relation.node.parent) {
      relation.node.parent.removeChild(relation.node);
    }
    relation.remove();
    cssAsset.markDirty();
    maybeEmptyCssAssets.add(cssAsset);
  }
  for (const cssAsset of maybeEmptyCssAssets) {
    if (cssAsset.isEmpty) {
      for (const incomingRelation of cssAsset.incomingRelations) {
        incomingRelation.detach();
      }
      assetGraph.removeAsset(cssAsset);
    }
  }

  // Async load Google Web Fonts CSS
  const googleFontStylesheets = assetGraph.findAssets({
    type: 'Css',
    url: { $regex: googleFontsCssUrlRegex },
  });
  const selfHostedGoogleCssByUrl = new Map();
  for (const googleFontStylesheet of googleFontStylesheets) {
    const seenPages = new Set(); // Only do the work once for each font on each page
    for (const googleFontStylesheetRelation of googleFontStylesheet.incomingRelations) {
      let htmlParents;

      if (googleFontStylesheetRelation.type === 'CssImport') {
        // Gather Html parents. Relevant if we are dealing with CSS @import relations
        htmlParents = getParents(assetGraph, googleFontStylesheetRelation.to, {
          type: 'Html',
          isInline: false,
          isLoaded: true,
        });
      } else if (googleFontStylesheetRelation.from.type === 'Html') {
        htmlParents = [googleFontStylesheetRelation.from];
      } else {
        htmlParents = [];
      }
      for (const htmlParent of htmlParents) {
        if (seenPages.has(htmlParent)) {
          continue;
        }
        seenPages.add(htmlParent);

        if (!omitFallbacks) {
          let selfHostedGoogleFontsCssAsset = selfHostedGoogleCssByUrl.get(
            googleFontStylesheetRelation.to.url
          );
          if (!selfHostedGoogleFontsCssAsset) {
            selfHostedGoogleFontsCssAsset = await createSelfHostedGoogleFontsCssAsset(
              assetGraph,
              googleFontStylesheetRelation.to,
              formats
            );
            subsetFontsToBeMinified.add(selfHostedGoogleFontsCssAsset);
            selfHostedGoogleCssByUrl.set(
              googleFontStylesheetRelation.to.url,
              selfHostedGoogleFontsCssAsset
            );
          }
          const selfHostedFallbackRelation = htmlParent.addRelation(
            {
              type: 'HtmlStyle',
              to: selfHostedGoogleFontsCssAsset,
              hrefType: 'rootRelative',
            },
            'lastInBody'
          );
          relationsToRemove.add(selfHostedFallbackRelation);
          asyncLoadStyleRelationWithFallback(
            htmlParent,
            selfHostedFallbackRelation
          );
        }
        relationsToRemove.add(googleFontStylesheetRelation);
      }
    }
    googleFontStylesheet.unload();
  }

  // Clean up, making sure not to detach the same relation twice, eg. when multiple pages use the same stylesheet that imports a font
  for (const relation of relationsToRemove) {
    relation.detach();
  }

  // Use subsets in font-family:

  const webfontNameMap = {};

  for (const { fontUsages } of htmlAssetTextsWithProps) {
    for (const { subsets, fontFamilies, props } of fontUsages) {
      if (subsets) {
        for (const fontFamily of fontFamilies) {
          webfontNameMap[
            fontFamily.toLowerCase()
          ] = `${props['font-family']}__subset`;
        }
      }
    }
  }

  let customPropertyDefinitions; // Avoid computing this unless necessary
  // Inject subset font name before original webfont
  const cssAssets = assetGraph.findAssets({
    type: 'Css',
    isLoaded: true,
  });
  let changesMadeToCustomPropertyDefinitions = false;
  for (const cssAsset of cssAssets) {
    let changesMade = false;
    cssAsset.eachRuleInParseTree((cssRule) => {
      if (cssRule.parent.type === 'rule' && cssRule.type === 'decl') {
        const propName = cssRule.prop.toLowerCase();
        if (
          (propName === 'font' || propName === 'font-family') &&
          cssRule.value.includes('var(')
        ) {
          if (!customPropertyDefinitions) {
            customPropertyDefinitions = findCustomPropertyDefinitions(
              cssAssets
            );
          }
          for (const customPropertyName of extractReferencedCustomPropertyNames(
            cssRule.value
          )) {
            for (const relatedCssRule of [
              cssRule,
              ...(customPropertyDefinitions[customPropertyName] || []),
            ]) {
              const modifiedValue = injectSubsetDefinitions(
                relatedCssRule.value,
                webfontNameMap,
                omitFallbacks // replaceOriginal
              );
              if (modifiedValue !== relatedCssRule.value) {
                relatedCssRule.value = modifiedValue;
                changesMadeToCustomPropertyDefinitions = true;
              }
            }
          }
        } else if (propName === 'font-family') {
          const fontFamilies = cssListHelpers.splitByCommas(cssRule.value);
          for (let i = 0; i < fontFamilies.length; i += 1) {
            const subsetFontFamily =
              webfontNameMap[unquote(fontFamilies[i]).toLowerCase()];
            if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
              fontFamilies.splice(
                i,
                omitFallbacks ? 1 : 0,
                cssQuoteIfNecessary(subsetFontFamily)
              );
              i += 1;
              cssRule.value = fontFamilies.join(', ');
              changesMade = true;
            }
          }
        } else if (propName === 'font') {
          const fontProperties = cssFontParser(cssRule.value);
          const fontFamilies =
            fontProperties && fontProperties['font-family'].map(unquote);
          if (fontFamilies) {
            const subsetFontFamily =
              webfontNameMap[fontFamilies[0].toLowerCase()];
            if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
              // FIXME: Clean up and move elsewhere
              if (omitFallbacks) {
                fontFamilies.shift();
              }
              fontFamilies.unshift(subsetFontFamily);
              const stylePrefix = fontProperties['font-style']
                ? `${fontProperties['font-style']} `
                : '';
              const weightPrefix = fontProperties['font-weight']
                ? `${fontProperties['font-weight']} `
                : '';
              const lineHeightSuffix = fontProperties['line-height']
                ? `/${fontProperties['line-height']}`
                : '';
              cssRule.value = `${stylePrefix}${weightPrefix}${
                fontProperties['font-size']
              }${lineHeightSuffix} ${fontFamilies
                .map(cssQuoteIfNecessary)
                .join(', ')}`;
              changesMade = true;
            }
          }
        }
      }
    });
    if (changesMade) {
      cssAsset.markDirty();
    }
  }

  // This is a bit crude, could be more efficient if we tracked the containing asset in findCustomPropertyDefinitions
  if (changesMadeToCustomPropertyDefinitions) {
    for (const cssAsset of cssAssets) {
      cssAsset.markDirty();
    }
  }

  // This is a bit awkward now, but if it's done sooner, it breaks the CSS source regexping:
  for (const cssAsset of subsetFontsToBeMinified) {
    await cssAsset.minify();
  }

  await assetGraph.serializeSourceMaps(undefined, {
    type: 'Css',
    outgoingRelations: {
      $where: (relations) =>
        relations.some((relation) => relation.type === 'CssSourceMappingUrl'),
    },
  });
  for (const relation of assetGraph.findRelations({
    type: 'SourceMapSource',
  })) {
    relation.hrefType = 'rootRelative';
  }
  for (const relation of assetGraph.findRelations({
    type: 'CssSourceMappingUrl',
    hrefType: { $in: ['relative', 'inline'] },
  })) {
    relation.hrefType = 'rootRelative';
  }

  for (const asset of potentiallyOrphanedAssets) {
    if (asset.incomingRelations.length === 0) {
      assetGraph.removeAsset(asset);
    }
  }

  // Hand out some useful info about the detected subsets:
  return {
    fontInfo: htmlAssetTextsWithProps.map(({ fontUsages, htmlAsset }) => ({
      htmlAsset: htmlAsset.urlOrDescription,
      fontUsages: fontUsages.map((fontUsage) => _.omit(fontUsage, 'subsets')),
    })),
  };
}

module.exports = subsetFonts;
