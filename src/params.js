/**
 * Extract parameters from a Jira issue based on workflow param config.
 *
 * @param {object} issue - Jira issue object (from REST API)
 * @param {object} paramsConfig - params section from workflows.yml
 * @returns {object} extracted key-value pairs for Octopus FormValues
 */
export function extractParams(issue, paramsConfig) {
  if (!paramsConfig) return {};

  const result = {};
  for (const [paramName, config] of Object.entries(paramsConfig)) {
    const value = extractSingle(issue, config);
    if (value === null) {
      throw new Error(
        `Could not extract param "${paramName}" from ${issue.key} using strategy "${config.from}"`
      );
    }
    result[paramName] = value;
  }
  return result;
}

function extractSingle(issue, config) {
  switch (config.from) {
    case 'label-prefix': {
      const labels = issue.fields.labels || [];
      const match = labels.find(l => l.startsWith(config.prefix));
      return match ? match.slice(config.prefix.length) : null;
    }

    case 'summary-regex': {
      const m = issue.fields.summary?.match(new RegExp(config.pattern));
      return m?.[1] ?? null;
    }

    case 'custom-field': {
      return issue.fields[config.field] ?? null;
    }

    case 'fixed': {
      return config.value ?? null;
    }

    default:
      throw new Error(`Unknown param extraction strategy: "${config.from}"`);
  }
}
