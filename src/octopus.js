import 'dotenv/config';

const SERVER_URL = process.env.OCTOPUS_SERVER_URL;
const API_KEY = process.env.OCTOPUS_API_KEY;

const headers = {
  'X-Octopus-ApiKey': API_KEY,
  'Content-Type': 'application/json',
};

async function octoFetch(path, options = {}) {
  const url = `${SERVER_URL}${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Octopus API ${res.status}: ${body}`);
  }
  return res.json();
}

async function findByName(path, name) {
  const data = await octoFetch(`${path}?partialName=${encodeURIComponent(name)}&take=10`);
  const items = data.Items || [];
  const match = items.find(i => i.Name === name);
  if (!match) {
    throw new Error(`Not found: "${name}" at ${path}`);
  }
  return match;
}

export async function resolveIds(spaceName, projectName, runbookName, environmentName) {
  const space = await findByName('/api/spaces', spaceName);
  const spaceId = space.Id;

  const [project, environment] = await Promise.all([
    findByName(`/api/${spaceId}/projects`, projectName),
    findByName(`/api/${spaceId}/environments`, environmentName),
  ]);

  const runbook = await findByName(`/api/${spaceId}/projects/${project.Id}/runbooks`, runbookName);

  return {
    spaceId,
    projectId: project.Id,
    runbookId: runbook.Id,
    publishedSnapshotId: runbook.PublishedRunbookSnapshotId,
    environmentId: environment.Id,
  };
}

export async function executeRunbook(spaceId, snapshotId, environmentId, formValues = {}) {
  const data = await octoFetch(`/api/${spaceId}/runbookRuns`, {
    method: 'POST',
    body: JSON.stringify({
      RunbookSnapshotId: snapshotId,
      EnvironmentId: environmentId,
      FormValues: formValues,
    }),
  });
  return { taskId: data.TaskId, runId: data.Id };
}

export async function getTaskStatus(taskId) {
  const data = await octoFetch(`/api/tasks/${taskId}`);
  return {
    state: data.State,
    isCompleted: data.IsCompleted,
    finishedSuccessfully: data.FinishedSuccessfully,
    errorMessage: data.ErrorMessage,
  };
}
