export const userTimeZone = 'Asia/Shanghai';
export function localTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', {
    timeZone: userTimeZone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
  }).format(date) + ' +08:00' : null;
}
export function factTime(times = {}, observedAt = new Date().toISOString()) {
  return { observedAt, observedLocal: localTime(observedAt), timeZone: userTimeZone,
    sourceTimes: Object.fromEntries(Object.entries(times).filter(([,value]) => value).map(([key,value]) => [key, { original: value, local: localTime(value) }])),
    instruction: 'This is a snapshot at observedAt. Preserve each source identity, stage and original time. Use the local times for the user; a submission/append receipt time is not the turn start. Retain exact totals and failures from the cited source; do not infer unobserved tests or delivery. Resource publication, attachment in a message, accepted delivery, external completion and user acceptance are separate facts. Local task counts do not establish connector event queues are empty.' };
}
