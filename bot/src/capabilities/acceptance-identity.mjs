import { localTime } from '../context/fact-time.mjs';

const normal = value => String(value ?? '').normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values)];
const versionNumber = String.raw`\d+(?:\.\d+)*(?:-(?:alpha|beta|rc|preview|dev)(?:\.\d+|\d+)*)?`;
const standaloneVersion = new RegExp(String.raw`(?:(?<![\w.-])v|(?:\bversion|版本)\s*:?\s*)(${versionNumber})(?![\w-]|\.[\w])`, 'gu');
const publishedVersion = new RegExp(String.raw`(?:(?<![a-z\d])v|(?:\bversion|版本)\s*:?\s*)(${versionNumber})(?!\d|\.\d)`, 'gu');
const compoundLabel = new RegExp(String.raw`(?<![\w.-])[a-z\d]+(?:[_.-][a-z\d]+)*[_.-]v${versionNumber}(?![\w-]|\.[\w])`, 'gu');
const contentLabels = text => unique(normal(text).match(compoundLabel) || []);
const versions = (text, { published = false } = {}) => {
  const wording = normal(text);
  return unique([
    ...[...wording.matchAll(published ? publishedVersion : standaloneVersion)].map(match => match[1]),
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

const matchesContentLabels = (text, labels) => labels.every(label => containsIdentity(normal(text), label));

function references(text, names, workIds) {
  const wording = normal(text), urls = links(text);
  const outsideUrls = urls.reduce((rest, url) => rest.replaceAll(url, ''), text);
  const ids = unique([...(wording.match(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?::[\w:.-]+\w)?\b/gu) || []),
    ...workIds.filter(id => id.length >= 8 && containsIdentity(wording, id))]);
  const files = names.filter(name => containsIdentity(wording, name) || wording.includes(`《${name.replace(/\.[^.]+$/u, '')}》`));
  const fileTokens = normal(outsideUrls)
    .match(/[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:md|txt|json|pdf|docx?|xlsx?|csv|zip|7z|html?|pptx?|png|jpe?g|apk|exe|dmg)(?![\w-]|\.[\w])/gu) || [];
  const unknownFile = fileTokens.some(file => !files.some(name => name.endsWith(file)));
  return { ids, files, urls, versions: versions(outsideUrls), unknownFile };
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
    const attachmentVersions = item => versions(item.name, { published: true });
    const labeled = attachments.filter(item => attachmentVersions(item).some(version => ref.versions.includes(version)));
    const matchingVersions = attachments.some(item => attachmentVersions(item).length) ? labeled.flatMap(attachmentVersions) :
      ref.urls.flatMap(url => versions(url, { published: true }));
    if (ref.versions.some(version => !matchingVersions.includes(version)) || named.length && labeled.length !== named.length) return null;
    if (labeled.length) attachments = labeled;
  }
  return { ...publication, attachments };
}

export function acceptanceClockTimes(text) {
  return unique([...normal(text).matchAll(/(?<![\d:+-])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])/gu)]
    .map(([, hour, minute]) => `${hour.padStart(2, '0')}:${minute}`));
}

function publicationMatchesTime(publication, times) {
  return !times.length || times.every(time => time === localTime(publication.publishedAt)?.slice(11, 16));
}

const natural = value => normal(value).replace(/[\s*_‘’“”'"《》]/gu, '').replace(/[−–—]/gu, '-');

function hasContentClue(source, delivered) {
  const body = natural(delivered);
  return natural(source).split(/[^\p{L}\p{N}-]+/u).some(part => {
    for (let index = 0; index + 6 <= part.length; index += 1) {
      const clue = part.slice(index, index + 6);
      if (/\p{L}/u.test(clue) && body.includes(clue)) return true;
    }
    return false;
  });
}

export function acceptanceBindings(units, entries, replyTo, { excluded = [], approval, roomResultsAvailable = true } = {}) {
  const names = unique(entries.flatMap(entry => entry.publication.attachments.map(item => normal(item.name))).filter(Boolean));
  const workIds = unique(entries.map(entry => normal(entry.workId)));
  const replies = replyTo ? entries.filter(entry => entry.publication.messageId === replyTo) : [];
  const replied = replies.length === 1 ? replies[0] : null;
  const publicEntries = entries.filter(entry => !entry.verification);
  const referenceOf = new Map(units.map(unit => [unit.unit, references(unit.text, names, workIds)]));
  const clockOf = new Map(units.map(unit => [unit.unit, acceptanceClockTimes(unit.text)]));
  const labelsOf = new Map(units.map(unit => [unit.unit, contentLabels(unit.text)]));
  const bySentence = Map.groupBy(units, unit => unit.sentenceStart);
  const sentences = [...bySentence.keys()];
  const sentenceIndex = new Map(sentences.map((start, index) => [start, index]));
  const excludedUnits = new Set(excluded);
  const scope = approval?.scopeUnits && new Set(approval.scopeUnits);
  return (approval ? units.slice(approval.unit - 1, approval.unit) : units).map(({ unit, sentenceStart }) => {
    const sentence = sentenceIndex.get(sentenceStart);
    const adjacent = sentences.slice(Math.max(0, sentence - 1), sentence + 2).flatMap(start => bySentence.get(start));
    const inSource = adjacent.filter(item => !excludedUnits.has(item.unit));
    const nearby = inSource.filter(item => item.unit === unit || (scope ? scope.has(item.unit) : item.unit <= unit));
    if (!scope && !nearby.some(item => hasReferences(referenceOf.get(item.unit)) || clockOf.get(item.unit).length))
      nearby.push(...inSource.filter(item => item.unit > unit));
    const referenced = nearby.filter(item => hasReferences(referenceOf.get(item.unit)));
    const fail = (reason, matches = []) => ({ unit, reason, identified: matches.slice(0, 3).map(({ workId, publication }) => ({ workId, ...publication })) });
    if (replyTo && !replied) return fail('未能确认所回复的消息是本群的有效交付。');
    const pool = replied ? publicEntries.filter(entry => entry === replied || replied.verification && entry.workId === replied.workId &&
      entry.target?.verificationOperationIds?.includes(replied.operationId)) : publicEntries;
    const timed = nearby.filter(item => clockOf.get(item.unit).length);
    const timedSource = nearby.map(item => item.text).join('\n');
    // A compound label identifies a material mentioned in the body. It is
    // never the version of the enclosing text delivery or attachment.
    const labelUnits = nearby.filter(item => labelsOf.get(item.unit).length);
    const labels = unique(labelUnits.flatMap(item => labelsOf.get(item.unit)));
    if (!replied && !referenced.length && !timed.length) return {
      ...fail('本条确认没有指明可唯一核对的交付、文件或版本。'), allowNatural: roomResultsAvailable, contentLabels: labels };
    if (!replied && !referenced.length && !roomResultsAvailable) return fail('当前未能核对同群的交付来源。');
    const refs = referenced.map(item => referenceOf.get(item.unit));
    const combined = Object.fromEntries(['ids', 'files', 'urls', 'versions'].map(key => [key, unique(refs.flatMap(ref => ref[key]))]));
    combined.unknownFile = refs.some(ref => ref.unknownFile);
    const times = unique(timed.flatMap(item => clockOf.get(item.unit)));
    const matches = pool.flatMap(entry => {
      if (!publicationMatchesTime(entry.publication, times)) return [];
      const exactBodyLabel = entry.target?.roomResultId && labels.length;
      if (exactBodyLabel && !matchesContentLabels(entry.identityText, labels)) return [];
      if (!replied && !referenced.length && !exactBodyLabel && !hasContentClue(timedSource, entry.identityText)) return [];
      const publication = matchPublication(entry, combined);
      return publication ? [{ ...entry, publication }] : [];
    });
    if (!matches.length) return { ...fail(replied ? '所回复的交付不可用，或与本条确认里的标识冲突。' :
      '未找到与本条确认中标识相符的交付。'), allowNatural: !replied && !referenced.length && times.length === 1,
      clockTimes: times, contentLabels: labels };
    if (matches.length !== 1) return fail('有多个交付符合本条线索，请回复要验收的原交付。', matches);
    const [{ target, publication, workId }] = matches;
    const identityUnits = nearby.filter(item => referenced.includes(item) || timed.includes(item) ||
      target?.roomResultId && labelUnits.includes(item)).map(item => item.unit);
    return target ? { unit, identityUnit: identityUnits[0] ?? unit, identityUnits, workId, target, publication } :
      fail('所指交付已不是当前版本，或仍在等待实际结果确认。', matches);
  });
}

export { links as acceptanceLinks };

// A model can select markers, but an actual source unit and a uniquely
// matching delivered candidate are required before an identity can be bound.
export function naturalAcceptanceMatch({ units, identityUnits, anchors, candidates, clockTimes = [], contentLabels: labels = [] }) {
  if (!Array.isArray(identityUnits) || !Array.isArray(anchors) || !anchors.length || anchors.length > 6) return null;
  const source = natural(units.filter(item => identityUnits.includes(item.unit)).map(item => item.text).join('\n'));
  if (anchors.some(anchor => typeof anchor !== 'string' || anchor.length > 120)) return null;
  const markers = unique(anchors.map(natural)).filter(marker => marker.length >= 2 && /[\p{L}\p{N}]/u.test(marker));
  if (!markers.length || markers.some(marker => !source.includes(marker)) ||
      markers.length < 2 && !/\d{4}[-/]\d{1,2}[-/]\d{1,2}.*\d{1,2}:\d{2}/.test(markers[0]) ||
      !clockTimes.length && !markers.some(marker => marker.length >= 8)) return null;
  const matches = candidates.filter(candidate => publicationMatchesTime(candidate, clockTimes) &&
    (!candidate.ownerBotId || matchesContentLabels(candidate.identityText, labels)) &&
    markers.every(marker => natural(candidate.identityText).includes(marker)));
  return matches.length === 1 ? matches[0] : null;
}
