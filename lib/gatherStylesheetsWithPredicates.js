const postcss = require('postcss');

module.exports = function gatherStylesheetsWithPredicates(
  inlineCssMap,
  assetGraph,
  htmlAsset
) {
  const assetStack = [];
  const incomingMedia = [];
  const conditionalCommentConditionStack = [];
  const result = [];
  (function traverse(asset, isWithinNotIeConditionalComment, isWithinNoscript) {
    if (assetStack.includes(asset)) {
      // Cycle detected
      return;
    } else if (!asset.isLoaded) {
      return;
    }
    assetStack.push(asset);
    for (const relation of assetGraph.findRelations({
      from: asset,
      type: {
        $in: [
          'HtmlStyle',
          'CssImport',
          'HtmlConditionalComment',
          'HtmlNoscript',
        ],
      },
    })) {
      if (assetStack.includes(relation.to) || !relation.to.isLoaded) {
        continue;
      }
      if (relation.type === 'HtmlNoscript') {
        traverse(relation.to, isWithinNotIeConditionalComment, true);
      } else if (relation.type === 'HtmlConditionalComment') {
        conditionalCommentConditionStack.push(relation.condition);
        traverse(
          relation.to,
          isWithinNotIeConditionalComment ||
            (relation.conditionalComments &&
              relation.conditionalComments.length > 0),
          isWithinNoscript
        );
        conditionalCommentConditionStack.pop();
      } else {
        const media = relation.media;
        if (media) {
          incomingMedia.push(media);
        }
        traverse(
          relation.to,
          isWithinNotIeConditionalComment ||
            (relation.conditionalComments &&
              relation.conditionalComments.length > 0),
          isWithinNoscript
        );
        if (media) {
          incomingMedia.pop();
        }
      }
    }
    assetStack.pop();
    if (asset.type === 'Css') {
      const predicates = {};
      for (const incomingMedium of incomingMedia) {
        predicates[`mediaQuery:${incomingMedium}`] = true;
      }
      for (const conditionalCommentCondition of conditionalCommentConditionStack) {
        predicates[`conditionalComment:${conditionalCommentCondition}`] = true;
      }
      if (isWithinNoscript) {
        predicates.script = false;
      }
      if (isWithinNotIeConditionalComment) {
        predicates['conditionalComment:IE'] = false;
      }
      const node = asset.incomingRelations[0].node;
      const dataHref = Array.from(node.attributes).reduce((acc, { name, value }) => {
        if (name === 'data-href') {
          if (! inlineCssMap.get(value)) {
            const parseTree = postcss.parse(asset.text);
            inlineCssMap.set(value, parseTree);
          }
          return value;
        }
        return acc;
      }, undefined);
      const text = (dataHref) ? [ dataHref ] : asset.text;
      result.push({
        text,
        predicates,
      });
    }
  })(htmlAsset);

  return result;
};
