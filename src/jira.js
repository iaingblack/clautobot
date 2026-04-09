import 'dotenv/config';

const BASE_URL = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const API_TOKEN = process.env.JIRA_API_TOKEN;

const AUTH = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64');

const headers = {
  'Authorization': `Basic ${AUTH}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

async function jiraFetch(path, options = {}) {
  const url = `${BASE_URL}/rest/api/3${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function createIssue(projectKey, summary, description) {
  return jiraFetch('/issue', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          }],
        },
        issuetype: { name: 'Task' },
      },
    }),
  });
}

export async function getIssue(issueKey) {
  return jiraFetch(`/issue/${issueKey}?fields=status,summary`);
}

export async function getTransitions(issueKey) {
  const data = await jiraFetch(`/issue/${issueKey}/transitions`);
  return data.transitions;
}

export async function transitionIssue(issueKey, transitionName) {
  const transitions = await getTransitions(issueKey);
  const match = transitions.find(t => t.name === transitionName);
  if (!match) {
    const available = transitions.map(t => t.name).join(', ');
    throw new Error(`Transition "${transitionName}" not found. Available: ${available}`);
  }
  return jiraFetch(`/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
}

export async function addComment(issueKey, text) {
  return jiraFetch(`/issue/${issueKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }],
      },
    }),
  });
}
