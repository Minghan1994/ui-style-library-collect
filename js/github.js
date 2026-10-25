// The only module that talks to GitHub.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class LibraryRepo {
  #token;

  constructor(fullName, token, branch = 'main') {
    this.fullName = fullName;
    this.branch = branch;
    this.isPrivate = true;
    this.#token = token;
  }

  /** Connects and reads the default branch and visibility. */
  static async open(fullName, token) {
    const repo = new LibraryRepo(fullName, token);
    const info = await repo.#request(`/repos/${fullName}`);
    repo.fullName = info.full_name;
    repo.branch = info.default_branch;
    repo.isPrivate = info.private;
    return repo;
  }

  webUrl(path = '') {
    return `https://github.com/${this.fullName}${path ? `/tree/${this.branch}/${path}` : ''}`;
  }

  readText(path) {
    return this.#request(this.#contentsPath(path), { as: 'text' });
  }

  readBlob(path) {
    return this.#request(this.#contentsPath(path), { as: 'blob' });
  }

  #contentsPath(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `/repos/${this.fullName}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`;
  }

  /**
   * Every folder in `dir` with the text of its case.md and the git blob id
   * of each file, in one GraphQL call. → [{ name, caseMd, files: { name: oid } }]
   */
  async listFolders(dir) {
    const [owner, name] = this.fullName.split('/');
    const query = `query($o:String!,$n:String!,$e:String!){repository(owner:$o,name:$n){object(expression:$e){
      ... on Tree{entries{name type object{... on Tree{entries{name object{... on Blob{oid text}}}}}}}}}}`;
    const res = await this.#request('/graphql', {
      method: 'POST',
      body: { query, variables: { o: owner, n: name, e: `${this.branch}:${dir}` } },
    });
    if (res.errors?.length) throw new GitHubError(0, res.errors[0].message);
    return (res.data?.repository?.object?.entries || [])
      .filter((e) => e.type === 'tree')
      .map((e) => {
        const entries = e.object?.entries || [];
        return {
          name: e.name,
          caseMd: entries.find((f) => f.name === 'case.md')?.object?.text || '',
          files: Object.fromEntries(entries.map((f) => [f.name, f.object?.oid])),
        };
      });
  }

  /**
   * Adds files in a single commit on the default branch.
   * files: [{ path, content: string | Blob }] → { sha, url }
   */
  async commit(files, message, onProgress = () => {}) {
    const base = `/repos/${this.fullName}`;
    const ref = `${base}/git/refs/heads/${encodeURIComponent(this.branch)}`;
    const entries = [];
    for (const f of files) {
      onProgress(`Uploading ${f.path.split('/').pop()}…`);
      const body = typeof f.content === 'string'
        ? { content: f.content, encoding: 'utf-8' }
        : { content: await toBase64(f.content), encoding: 'base64' };
      const blob = await this.#request(`${base}/git/blobs`, { method: 'POST', body });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    onProgress('Committing…');
    // If the branch moves between reading and updating it, rebase onto the new head.
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = (await this.#request(ref)).object.sha;
      const parent = await this.#request(`${base}/git/commits/${head}`);
      const tree = await this.#request(`${base}/git/trees`, { method: 'POST', body: { base_tree: parent.tree.sha, tree: entries } });
      const commit = await this.#request(`${base}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [head] } });
      try {
        await this.#request(ref, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return { sha: commit.sha, url: commit.html_url };
      } catch (e) {
        if (e.status !== 422) throw e;
      }
    }
    throw new GitHubError(409, 'The branch kept changing while saving. Try again.');
  }

  /** Newest runs of a workflow file on the default branch (needs Actions: read). */
  async workflowRuns(workflow, count = 5) {
    const res = await this.#request(
      `/repos/${this.fullName}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(this.branch)}&per_page=${count}`,
    );
    return res.workflow_runs;
  }

  /** Starts a workflow run on the default branch (needs Actions: write). */
  async dispatchWorkflow(workflow) {
    await this.#request(`/repos/${this.fullName}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: { ref: this.branch },
    });
  }

  // as: 'json' (default), or 'text' / 'blob' for a file's raw contents.
  async #request(path, { method = 'GET', body, as = 'json' } = {}) {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: as === 'json' ? 'application/vnd.github+json' : 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GitHubError(res.status, data.message || res.statusText);
    }
    return res.status === 204 ? null : res[as]();
  }
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
