export const workflowQuestions = 'Start with “行不行？” and check what the evidence, capabilities, context and authority permit. Then ask “好不好？” and assess how the actual choice serves the current goal and the project ahead. For “怎么更好？” compare a concrete alternative, its benefit and cost, and explain the actual choice. If none is feasible, state the specific constraints that rule it out.';

export const comparisonFields = {
  fact: { type: 'string', maxLength: 240, description: '行不行. A short verifiable fact about feasibility, context or authority.' },
  fit: { type: 'string', maxLength: 300, description: '好不好. What the actual arrangement achieves or leaves uncovered.' },
  alternative: { type: 'string', maxLength: 300, description: '怎么更好. The concrete alternative considered, or why none is feasible.' },
  tradeoff: { type: 'string', maxLength: 300, description: 'The relevant gain, cost and reason for the chosen option.' },
};

export const comparisonSchema = { type: 'object', additionalProperties: false,
  properties: comparisonFields, required: Object.keys(comparisonFields) };

export function workflowComparison(value) {
  const result = {};
  for (const [key, { maxLength }] of Object.entries(comparisonFields)) {
    const text = typeof value?.[key] === 'string' && value[key].trim().replace(/\s+/g, ' ');
    if (!text || text.length > maxLength) return null;
    result[key] = text;
  }
  return result;
}
