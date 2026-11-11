import { basename } from 'node:path';
import { localTime } from '../context/fact-time.mjs';
import { localPackagePaths, localPathKey } from '../runtime/local-delivery.mjs';

const normalizedScope = text => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

export function sameRoomResultAcceptance(left, right) {
  return Boolean(left.userId) && left.userId === right.userId && left.roomId === right.roomId && left.version === right.version &&
    (left.publicationMessageId || left.resultId) === (right.publicationMessageId || right.resultId) &&
    left.ownerBotId === right.ownerBotId && left.dutyKey === right.dutyKey && left.fullScope === right.fullScope &&
    normalizedScope(left.scope) === normalizedScope(right.scope) &&
    normalizedScope(left.remainingBoundaries) === normalizedScope(right.remainingBoundaries);
}

const normal = value => String(value ?? '').normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values)];
const versionNumber = String.raw`\d+(?:\.\d+)*(?:-(?:alpha|beta|rc|preview|dev)(?:\.\d+|\d+)*)?`;
const standaloneVersion = new RegExp(String.raw`(?:(?<![\w.-])v|(?:\bversion|版本)\s*:?\s*)(${versionNumber})(?![\w-]|\.[\w])`, 'gu');
const publishedVersion = new RegExp(String.raw`(?:(?<![a-z\d])v|(?:\bversion|版本)\s*:?\s*)(${versionNumber})(?!\d|\.\d)`, 'gu');
const compoundLabel = new RegExp(String.raw`(?<![\w.-])[a-z\d]+(?:[_.-][a-z\d]+)*[_.-]v${versionNumber}(?![\w-]|\.[\w])`, 'gu');
const archivePath = /\.(?:zip|7z|tar(?:\.gz)?|tgz)$/iu;
const evidenceFile = /^(?:[\x60"'「《][^\x60"'「」《》:/\\\r\n]+\.[a-z\d]+[\x60"'」》]|[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[a-z\d]+)(?![\w-]|\.[\w])/iu;
const fileListJoin = /^\s*(?:以及|和|与|及|、)\s*(?:(?:随包|包内|同(?:一)?目录|解包后)的?\s*)?/u;
const bundledUse = /^\s*(?:我\s*)?(?:实际\s*)?(?:使用|用)\s*(?:随包(?:提供)?|包内|解包后|解出(?:来)?)的?\s*/u;
const runVerb = /^\s*(?:跑|运行|执行)/u;
const runReport = /^\s*(?:我\s*)?(?:(?:这次|本次|实际|另)\s*)?(?:跑|运行|执行)(?:了|完(?:了)?)\s*/u;
const browserFiles = /^\s*(?:正式)?(?:网页|浏览器)(?:端)?的?\s*(?:附件|分卷|首卷)\s*/u;
const browserLimit = /^\s*的?\s*(?:实际\s*)?(?:下载\s*)?(?:仍|尚|还)?\s*(?:(?:未|没(?:有|能)?)\s*(?:(?:最终|成功|完整|确认)\s*)*(?:下载|落盘|保存|完成)|(?:仅|只)(?:有发布回执|(?:到|见|有)(?:未确认)?临时文件))/u;
const deliveryOrApproval = /交付|验收|评审/u;
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

function fileListEnd(text, start) {
  let end = 0;
  while (start < text.length) {
    const file = evidenceFile.exec(text.slice(start));
    if (!file) break;
    end = start + file[0].length;
    const join = fileListJoin.exec(text.slice(end));
    if (!join) break;
    start = end + join[0].length;
  }
  return end;
}

function afterLocalFileDescription(text) {
  const use = bundledUse.exec(text);
  const prefix = use || browserFiles.exec(text);
  if (!prefix) return text;
  const end = fileListEnd(text, prefix[0].length);
  const tail = text.slice(end);
  return end && (use ? runVerb : browserLimit).test(tail) ? tail : text;
}

function localReferenceOverrides(referenced, unit, bySentence, referenceOf, names, workIds) {
  const overrides = new Map();
  let previousRun;
  for (const item of referenced) {
    if (item.unit === unit) continue;
    const wording = afterLocalFileDescription(item.text);
    const continuesRun = previousRun?.unit === item.unit - 1 && previousRun.sentenceStart === item.sentenceStart;
    const descriptiveRun = wording !== item.text || item.unit > unit &&
      !bySentence.get(item.sentenceStart).some(clause => deliveryOrApproval.test(clause.text));
    const run = descriptiveRun && (runReport.exec(wording) || (continuesRun && fileListJoin.exec(wording)));
    const end = run && fileListEnd(wording, run[0].length);
    const inputs = end && !deliveryOrApproval.test(wording.slice(end));
    if (!inputs && wording === item.text) continue;
    const { files, unknownFile } = references(wording, names, workIds);
    // A run report can name inputs. Keep any named delivery and all other
    // identity clues, and only remove unknown filenames from the operand list.
    if (inputs) previousRun = item;
    overrides.set(item.unit, { ...referenceOf.get(item.unit), files,
      unknownFile: inputs ? references(wording.slice(end), names, workIds).unknownFile : unknownFile });
  }
  return overrides;
}

function matchPublication(entry, ref, timedAttachment) {
  const { workId, operationId } = entry;
  const { localFiles, ...publication } = entry.publication;
  const artifactIds = publication.attachments.map(item => normal(item.id));
  const ids = [workId, operationId, publication.messageId, publication.replyTo, publication.manifestOperationId].map(normal);
  if (ref.unknownFile || ref.ids.some(id => !ids.includes(id) && !artifactIds.includes(id)) ||
    ref.files.some(name => !publication.attachments.some(item => normal(item.name) === name)) ||
    ref.urls.some(url => !entry.links.includes(url))) return null;

  const named = publication.attachments.filter(item => ref.ids.includes(normal(item.id)) || ref.files.includes(normal(item.name)));
  if (localFiles?.length && !named.length && !timedAttachment) return null;
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

function matchLocalPublication(entry, ref) {
  const { publication, workId, operationId } = entry;
  if (!publication.localFiles?.length || (!ref.files.length && !ref.paths.length) || ref.unknownFile) return [];
  const ids = [workId, operationId, publication.messageId, publication.replyTo, publication.manifestOperationId].map(normal);
  if (ref.ids.some(id => !ids.includes(id)) || ref.urls.some(url => !entry.links.includes(url))) return [];
  return publication.localFiles.filter(file => ref.files.every(name => name === normal(file.name)) &&
    ref.paths.every(path => path === localPathKey(file.path)) &&
    ref.versions.every(version => versions(file.name, { published: true }).includes(version))).map(file => {
    const available = Number.isFinite(file.mtimeMs);
    return { ...entry, target: available ? entry.target : null, localUnavailable: !available,
      publication: { ...publication, attachments: [], localFiles: [file] } };
  });
}

export function acceptanceClockTimes(text) {
  return unique([...normal(text).matchAll(/(?<![\d:+-])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])/gu)]
    .map(([, hour, minute]) => `${hour.padStart(2, '0')}:${minute}`));
}

function publicationMatchesTime(publication, times) {
  return !times.length || times.every(time => time === localTime(publication.publishedAt)?.slice(11, 16));
}

function timedAttachmentTitles(text, times) {
  if (!times.length || !/(?:附件|\battachments?\b)/iu.test(text)) return [];
  return [...normal(text).matchAll(/《([^《》]+)》/gu)].map(([, title]) => title.trim()).filter(title => /[\p{L}\p{N}]/u.test(title));
}

function attachmentHasTitle(attachment, title) {
  const name = normal(attachment.name).replace(/\.[^.]+$/u, '');
  for (let start = name.indexOf(title); start !== -1; start = name.indexOf(title, start + 1)) {
    if (!/[\p{L}\p{N}]/u.test(name[start - 1] || '') && !/^[\p{L}\p{N}]/u.test(name.slice(start + title.length))) return true;
  }
  return false;
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

export function acceptanceBindings(units, entries, replyTo, {
  excluded = [], sharedScopeUnits = [], attachmentPublications = [], roomWorkPublications = [], approval, roomResultsAvailable = true,
} = {}) {
  const localNames = new Set(entries.flatMap(entry => (entry.publication.localFiles || []).map(file => normal(file.name))));
  const names = unique([...entries.flatMap(entry => entry.publication.attachments.map(item => normal(item.name))), ...localNames].filter(Boolean));
  const workIds = unique(entries.map(entry => normal(entry.workId)));
  const replies = replyTo ? entries.filter(entry => entry.publication.messageId === replyTo) : [];
  const replied = replies.length === 1 ? replies[0] : null;
  const publicEntries = entries.filter(entry => !entry.verification);
  const referenceOf = new Map(units.map(unit => [unit.unit, references(unit.text, names, workIds)]));
  const pathsOf = new Map(units.map(unit => [unit.unit, localPackagePaths(unit.text)]));
  const clockOf = new Map(units.map(unit => [unit.unit, acceptanceClockTimes(unit.text)]));
  const labelsOf = new Map(units.map(unit => [unit.unit, contentLabels(unit.text)]));
  const bySentence = Map.groupBy(units, unit => unit.sentenceStart);
  const sentences = [...bySentence.keys()];
  const sentenceIndex = new Map(sentences.map((start, index) => [start, index]));
  const excludedUnits = new Set(excluded);
  const sharedUnits = new Set(sharedScopeUnits);
  const sharedTitles = new Map(sharedScopeUnits.map(unit => [unit, timedAttachmentTitles(units[unit - 1].text, clockOf.get(unit))]));
  const scope = approval?.scopeUnits && new Set(approval.scopeUnits);
  const identity = approval?.identityUnits && new Set(approval.identityUnits);
  return (approval ? units.slice(approval.unit - 1, approval.unit) : units).map(({ unit, sentenceStart }) => {
    const sentence = sentenceIndex.get(sentenceStart);
    const adjacent = sentences.slice(Math.max(0, sentence - 1), sentence + 2).flatMap(start => bySentence.get(start));
    const namedLocalFiles = referenceOf.get(unit).files.filter(name => localNames.has(name));
    // A recording instruction can share approval scope. Share only the named
    // local file in the approval itself and a path that identifies that file.
    const sharedLocal = adjacent.filter(item => sharedUnits.has(item.unit) && namedLocalFiles.length &&
      (item.unit === unit || pathsOf.get(item.unit).some(path => namedLocalFiles.includes(normal(basename(path))))));
    const inSource = adjacent.filter(item => !excludedUnits.has(item.unit) || sharedLocal.includes(item));
    const nearby = inSource.filter(item => item.unit === unit || (scope ? scope.has(item.unit) : item.unit <= unit));
    if (!scope && !nearby.some(item => hasReferences(referenceOf.get(item.unit)) || clockOf.get(item.unit).length))
      nearby.push(...inSource.filter(item => item.unit > unit));
    if (!scope && localNames.size) {
      const named = nearby.flatMap(item => referenceOf.get(item.unit).files);
      // The adjacent takeout path can qualify the package named in the approval.
      for (const item of inSource) if (item.unit > unit && !nearby.includes(item) && pathsOf.get(item.unit).some(path => {
        const name = normal(basename(path));
        return localNames.has(name) && (!named.length || named.includes(name));
      })) nearby.push(item);
    }
    const referenced = nearby.filter(item => hasReferences(referenceOf.get(item.unit)) || pathsOf.get(item.unit).length);
    const fail = (reason, matches = []) => ({ unit, reason, identified: matches.slice(0, 3).map(({ workId, publication }) => ({ workId, ...publication })) });
    if (replyTo && !replied) return fail('未能确认所回复的消息是本群的有效交付。');
    // The same clause can identify an earlier attachment and supply input to
    // new production. Only share a timed, named attachment reference, never
    // the separate action clause or its other scope details.
    const shared = !replied && !referenced.length ? adjacent.filter(item => item.unit <= unit &&
      (!scope || scope.has(item.unit)) && sharedTitles.get(item.unit)?.length) : [];
    const titles = unique(shared.flatMap(item => sharedTitles.get(item.unit)));
    const pool = replied ? publicEntries.filter(entry => entry === replied || replied.verification && entry.workId === replied.workId &&
      entry.target?.verificationOperationIds?.includes(replied.operationId)) : publicEntries;
    // A scope can cite the time of a separate check without changing the
    // publication already identified by the original approval.
    const timed = nearby.filter(item => clockOf.get(item.unit).length &&
      (!identity || identity.has(item.unit) || referenced.includes(item)));
    const timedSource = nearby.map(item => item.text).join('\n');
    // A compound label identifies a material mentioned in the body. It is
    // never the version of the enclosing text delivery or attachment.
    const labelUnits = nearby.filter(item => labelsOf.get(item.unit).length);
    const labels = unique(labelUnits.flatMap(item => labelsOf.get(item.unit)));
    if (!replied && !referenced.length && !timed.length && !shared.length) return {
      ...fail('本条确认没有指明可唯一核对的交付、文件或版本。'), allowNatural: roomResultsAvailable, contentLabels: labels };
    if (!replied && !referenced.length && !roomResultsAvailable) return fail('当前未能核对同群的交付来源。');
    const referenceUnits = [...referenced, ...shared];
    const refs = referenceUnits.map(item => referenceOf.get(item.unit));
    const combined = Object.fromEntries(['ids', 'files', 'urls', 'versions'].map(key => [key, unique(refs.flatMap(ref => ref[key]))]));
    combined.unknownFile = refs.some(ref => ref.unknownFile);
    combined.paths = unique(referenced.flatMap(item => pathsOf.get(item.unit).map(localPathKey)));
    // Limit this to one explicit local archive path. The original excerpts
    // still supply the scope, and the room and work checks still bind the file.
    const localReferences = combined.paths.length === 1 && archivePath.test(combined.paths[0])
      ? localReferenceOverrides(referenced, unit, bySentence, referenceOf, names, workIds) : new Map();
    const localRefs = localReferences.size ? referenceUnits.map(item => localReferences.get(item.unit) || referenceOf.get(item.unit)) : null;
    const localIdentity = localRefs ? { ...combined, files: unique(localRefs.flatMap(ref => ref.files)),
      unknownFile: localRefs.some(ref => ref.unknownFile) } : combined;
    const times = unique([...timed, ...shared].flatMap(item => clockOf.get(item.unit)));
    let namedAttachment;
    if (titles.length) {
      const named = attachmentPublications.filter(publication => publicationMatchesTime(publication, times)).flatMap(publication =>
        publication.attachments.filter(item => item.id && titles.every(title => attachmentHasTitle(item, title)))
          .map(attachment => ({ messageId: publication.messageId, id: attachment.id })));
      if (named.length > 1) return fail('本群有多个附件符合本条线索，请指出要验收的原附件。');
      if (!named.length) return fail('本群未找到与确认中时间和题名相符的附件。');
      [namedAttachment] = named;
    }
    const matches = pool.flatMap(entry => {
      if (!publicationMatchesTime(entry.publication, times)) return [];
      const exactBodyLabel = entry.target?.roomResultId && labels.length;
      if (exactBodyLabel && !matchesContentLabels(entry.identityText, labels)) return [];
      if (!replied && !referenced.length && !titles.length && !exactBodyLabel && !hasContentClue(timedSource, entry.identityText)) return [];
      const publication = !combined.paths.length && matchPublication(entry, combined, namedAttachment);
      if (namedAttachment) {
        const attachment = publication?.messageId === namedAttachment.messageId &&
          publication.attachments.find(item => item.id === namedAttachment.id);
        return attachment ? [{ ...entry, publication: { ...publication, attachments: [attachment] } }] : [];
      }
      const local = matchLocalPublication(entry, localIdentity);
      return publication ? [{ ...entry, publication }, ...local] : local;
    });
    if (!matches.length) return { ...fail(replied ? '所回复的交付不可用，或与本条确认里的标识冲突。' :
      '未找到与本条确认中标识相符的交付。'), allowNatural: !replied && !referenced.length && !titles.length && times.length === 1,
      clockTimes: times, contentLabels: labels };
    if (matches.length !== 1) return fail('有多个交付符合本条线索，请回复要验收的原交付。', matches);
    const [{ target, publication, workId, senderId, operationId, localUnavailable }] = matches;
    if (publication.localFiles?.length) {
      const [file] = publication.localFiles;
      const roomMatches = roomWorkPublications.filter(item => (!replyTo || item.messageId === replyTo) &&
        publicationMatchesTime(item, times) && combined.ids.every(id =>
          [item.messageId, item.workId, item.replyTo, ...item.operationIds].map(normal).includes(id)) &&
        item.paths.some(path => combined.paths.length ? localPathKey(path) === localPathKey(file.path) : normal(basename(path)) === normal(file.name)));
      if (roomMatches.length > 1) return fail('本群有多个工作交付符合该本机文件线索，请回复对应的原交付。', matches);
      if (!roomMatches.some(item => item.messageId === publication.messageId && item.workId === workId &&
        item.senderId === senderId && item.replyTo === publication.replyTo && item.operationIds.includes(operationId)))
        return fail('未能核对本机文件所在的原群交付。', matches);
    }
    const identityReferences = publication.localFiles?.length ? referenced.filter(item =>
      pathsOf.get(item.unit).length || hasReferences(localReferences.get(item.unit) || referenceOf.get(item.unit))) : referenced;
    const sharedIdentityUnits = [...shared, ...sharedLocal.filter(item => identityReferences.includes(item))].map(item => item.unit);
    const identityUnits = [...nearby, ...shared].filter(item => identityReferences.includes(item) || timed.includes(item) || shared.includes(item) ||
      target?.roomResultId && labelUnits.includes(item)).map(item => item.unit);
    identityUnits.sort((left, right) => left - right);
    return target ? { unit, identityUnit: identityUnits[0] ?? unit, identityUnits, sharedIdentityUnits, workId, target, publication } :
      fail(localUnavailable ? '所指本机文件的项目权限或原交付时的文件状态未能核对。' :
        '所指交付已不是当前版本，或仍在等待实际结果确认。', matches);
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
  const matches = candidates.filter(candidate => !candidate.localFiles?.length && publicationMatchesTime(candidate, clockTimes) &&
    (!candidate.ownerBotId || matchesContentLabels(candidate.identityText, labels)) &&
    markers.every(marker => natural(candidate.identityText).includes(marker)));
  return matches.length === 1 ? matches[0] : null;
}
