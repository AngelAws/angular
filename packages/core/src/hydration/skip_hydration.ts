/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {TNode, TNodeFlags} from '../render3/interfaces/node';
import {RElement} from '../render3/interfaces/renderer_dom';

/**
 * The name of an attribute that can be added to the hydration boundary node
 * (component host node) to disable hydration for the content within that boundary.
 */
export const SKIP_HYDRATION_ATTR_NAME = 'ngSkipHydration';

/** Lowercase name of the `ngSkipHydration` attribute used for case-insensitive comparisons. */
const SKIP_HYDRATION_ATTR_NAME_LOWER_CASE = 'ngskiphydration';

/**
 * Helper function to check if a given TNode has the 'ngSkipHydration' attribute.
 */
export function hasSkipHydrationAttrOnTNode(tNode: TNode): boolean {
  const attrs = tNode.mergedAttrs;
  if (attrs === null) return false;
  // only ever look at the attribute name and skip the values
  for (let i = 0; i < attrs.length; i += 2) {
    const value = attrs[i];
    // This is a marker, which means that the static attributes section is over,
    // so we can exit early.
    if (typeof value === 'number') return false;
    if (typeof value === 'string' && value.toLowerCase() === SKIP_HYDRATION_ATTR_NAME_LOWER_CASE) {
      return true;
    }
  }
  return false;
}

/**
 * Helper function to check if a given RElement has the 'ngSkipHydration' attribute.
 */
export function hasSkipHydrationAttrOnRElement(rNode: RElement): boolean {
  return rNode.hasAttribute(SKIP_HYDRATION_ATTR_NAME);
}

/**
 * Checks whether a TNode has a flag to indicate that it's a part of
 * a skip hydration block.
 */
export function hasInSkipHydrationBlockFlag(tNode: TNode): boolean {
  return (tNode.flags & TNodeFlags.inSkipHydrationBlock) === TNodeFlags.inSkipHydrationBlock;
}

/**
 * Helper function that determines if a given node is within a skip hydration block
 * by navigating up the TNode tree to see if any parent nodes have skip hydration
 * attribute.
 *
 * TODO(akushnir): this function should contain the logic of `hasInSkipHydrationBlockFlag`,
 * there is no need to traverse parent nodes when we have a TNode flag (which would also
 * make this lookup O(1)).
 */
export function isInSkipHydrationBlock(tNode: TNode): boolean {
  let currentTNode: TNode|null = tNode.parent;
  while (currentTNode) {
    if (hasSkipHydrationAttrOnTNode(currentTNode)) {
      return true;
    }
    currentTNode = currentTNode.parent;
  }
  return false;
}
