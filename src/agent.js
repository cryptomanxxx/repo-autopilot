// Paths the coding agent may propose to edit. Infrastructure, hidden files, dependencies and the
// agent's own code stay read-only; the chat Worker adds every file it bundles to that list.
export function allowedAgentPath(path) {
  return typeof path === 'string' && !path.includes('..') && !path.includes('\\') && !path.split('/').some(part=>part.startsWith('.')) && (path === 'README.md' || /^(src|public|test)\/[a-zA-Z0-9_./-]+\.(js|css|html|md)$/.test(path)) && path !== 'src/agent.js';
}
