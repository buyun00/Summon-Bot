const normal = value => String(value ?? '').normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values)];
const versions = text => {
  const wording = normal(text);
  return unique([
    ...[...wording.matchAll(/(?:(?<![a-z\d])v|(?:\bversion|版本)\s*:?\s*)(\d+(?:\.\d+)*(?:-(?:alpha|beta|rc|preview|dev)(?:\.\d+|\d+)*)?)(?!\d|\.\d)/gu)].map(match => match[1]),
    ...[...wording.matchAll(/(?<![\w.])(\d+(?:\.\d+)*)\s*版/gu)].map(match => match[1]),
  ]);
};
const links = text => unique((text?.match(/https?:\/\/[^\s<>"'`\])，。；）】]+/gu) || []).map(link => link.replace(/[.,;]+$/u, '')));
function containsIdentity(text, name) {
  if (!name) return false;
  for (let start = text.indexOf(name); start !== -1; start = text.indexOf(name, start + 1)) {
    if (!/[\w.-]/u.test(text[start - 1] || '') && !/^(?:[\w-]|\.[\w])/u.test(text.slice(start + name.length))) return true;
  }
  return false;
}

function references(text, names, workIds) {
  const wording = normal(text), urls = links(text);
  const ids = unique([...(wording.match(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?::[\w:.-]+\w)?\b/gu) || []),
    ...workIds.filter(id => id.length >= 8 && containsIdentity(wording, id))]);
  const files = names.filter(name => containsIdentity(wording, name) || wording.includes(`《${name.replace(/\.[^.]+$/u, '')}》`));
  const fileTokens = normal(urls.reduce((rest, url) => rest.replaceAll(url, ''), text))
    .match(/[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:md|txt|json|pdf|docx?|xlsx?|csv|zip|7z|html?|pptx?|png|jpe?g|apk|exe|dmg)(?![\w-]|\.[\w])/gu) || [];
  const unknownFile = fileTokens.some(file => !files.some(name => name.endsWith(file)));
  return { ids, files, urls, versions: versions(text), unknownFile };
}

const hasReferences = ref => ref.ids.length || ref.files.length || ref.urls.length || ref.versions.length || ref.unknownFile;

function matchPublication(entry, ref) {
  const { publication, workId, operationId } = entry;
  const artifactIds = publication.attachments.map(item => normal(item.id));
  const ids = [workId, operationId, publication.messageId, publication.replyTo, publication.manifestOperationId].map(normal);
  if (ref.unknownFile || ref.ids.some(id => !ids.includes(id) && !artifactIds.includes(id)) ||
    ref.files.some(name => !publication.attachments.some(item => normal(item.name) === name)) ||
    ref.urls.some(url => !entry.links.includes(url))) return null;

  const named = publication.attachments.filter(item => ref.ids.includes(normal(item.id)) || ref.files.includes(normal(item.name)));
  let attachments = named.length ? named : publication.attachments;
  if (ref.versions.length) {
    const labeled = attachments.filter(item => versions(item.name).some(version => ref.versions.includes(version)));
    const matchingVersions = attachments.some(item => versions(item.name).length) ? labeled.flatMap(item => versions(item.name)) :
      ref.urls.flatMap(versions);
    if (ref.versions.some(version => !matchingVersions.includes(version)) || named.length && labeled.length !== named.length) return null;
    if (labeled.length) attachments = labeled;
  }
  return { ...publication, attachments };
}

export function acceptanceBindings(units, entries, replyTo) {
  const names = unique(entries.flatMap(entry => entry.publication.attachments.map(item => normal(item.name))).filter(Boolean));
  const workIds = unique(entries.map(entry => normal(entry.workId)));
  const replies = replyTo ? entries.filter(entry => entry.publication.messageId === replyTo) : [];
  const replied = replies.length === 1 ? replies[0] : null;
  const publicEntries = entries.filter(entry => !entry.verification);
  const referenceOf = units.map(unit => references(unit.text, names, workIds));
  return units.map(({ unit, sentenceStart }, index) => {
    // A comma can separate “I read v2” from “approved”. Do not take a target
    // from a different sentence or a subsequent instruction.
    const own = referenceOf[index];
    const previous = !hasReferences(own) && index > 0 && units[index - 1].sentenceStart === sentenceStart && /[,，]\s*$/u.test(units[index - 1].text);
    const ref = previous ? referenceOf[index - 1] : own;
    const fail = (reason, matches = []) => ({ unit, reason, identified: matches.slice(0, 3).map(({ workId, publication }) => ({ workId, ...publication })) });
    if (!replied && !hasReferences(ref)) return { ...fail('No exact delivery, file, work or version was identified in the approval.'),
      allowNatural: !replyTo };
    if (replyTo && !replied) return fail('The replied-to message could not be verified as a delivery from this work source.');
    const pool = replied ? publicEntries.filter(entry => entry === replied || replied.verification && entry.workId === replied.workId &&
      entry.target?.verificationOperationIds?.includes(replied.operationId)) : publicEntries;
    const matches = pool.flatMap(entry => {
      const publication = matchPublication(entry, ref);
      return publication ? [{ ...entry, publication }] : [];
    });
    if (!matches.length) return fail(replied ? 'The replied-to delivery is unavailable or conflicts with the stated identity.' :
      'No delivered result matches the exact identity in the approval.');
    if (matches.length !== 1) return fail('Several delivered results match the approval; the exact delivery is ambiguous.', matches);
    const [{ target, publication, workId }] = matches;
    return target ? { unit, identityUnit: previous && hasReferences(ref) ? units[index - 1].unit : unit, workId, target, publication } :
      fail('The identified delivery is no longer current or is still awaiting a confirmed result.', matches);
  });
}

export { links as acceptanceLinks };

const natural = value => normal(value).replace(/[\s*_‘’“”'"《》]/gu, '').replace(/[−–—]/gu, '-');

// A model can select markers, but an actual source unit and a uniquely
// matching delivered candidate are required before an identity can be bound.
export function naturalAcceptanceMatch({ units, identityUnits, anchors, candidates }) {
  if (!Array.isArray(identityUnits) || !Array.isArray(anchors) || !anchors.length || anchors.length > 6) return null;
  const source = natural(units.filter(item => identityUnits.includes(item.unit)).map(item => item.text).join('\n'));
  if (anchors.some(anchor => typeof anchor !== 'string' || anchor.length > 120)) return null;
  const markers = unique(anchors.map(natural)).filter(marker => marker.length >= 2 && /[\p{L}\p{N}]/u.test(marker));
  if (!markers.length || markers.some(marker => !source.includes(marker)) ||
      markers.length < 2 && !/\d{4}[-/]\d{1,2}[-/]\d{1,2}.*\d{1,2}:\d{2}/.test(markers[0])) return null;
  const matches = candidates.filter(candidate => markers.every(marker => natural(candidate.identityText).includes(marker)));
  return matches.length === 1 ? matches[0] : null;
}
