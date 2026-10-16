// @ts-check

/**
 * Scanner-extracted text is an internal search index, not document metadata.
 * Never return its contents through document list or mutation responses.
 * @param {Record<string, any>} document
 */
export function publicDocument(document) {
  const copy = structuredClone(document);
  const indexed = typeof copy.extractedText === "string" && copy.extractedText.length > 0;
  delete copy.extractedText;
  return {...copy, extractedTextIndexed: indexed};
}
